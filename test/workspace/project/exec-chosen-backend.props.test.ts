import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { WorkspaceRuntimeEvent } from "@cloudflare/computer";
import type {
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";
import { chosenExecBackend } from "../../../src/workspace/project/exec-selection.js";

type ExecWorkspace = Parameters<typeof chosenExecBackend>[0];

type Route = "isolate" | "container" | "refused";

const RUNTIME_BACKENDS = { isolate: "worker-shell", container: "container-shell" } as const;

const DOCUMENTED_ROUTES: ReadonlyArray<
  readonly [command: string, automatic: Route, isolate: Route, container: Route]
> = [
  ["ls", "isolate", "isolate", "container"],
  ["grep foo file | wc -l", "isolate", "isolate", "container"],
  ["pnpm test", "container", "container", "container"],
  ["pnpm install", "container", "container", "container"],
  ["cat /etc/hosts", "container", "container", "container"],
  ["git status", "container", "refused", "container"],
  ["cd repo && git commit -m x", "container", "refused", "container"],
  ["echo 'git push'", "isolate", "isolate", "container"],
  ["", "container", "container", "container"],
];

const encoder = new TextEncoder();

const COMMAND_NOT_FOUND = 127;

function runEvents(
  backend: string,
  isolateFindsCommand: boolean,
): readonly WorkspaceRuntimeEvent[] {
  if (backend === RUNTIME_BACKENDS.isolate && !isolateFindsCommand) {
    return [{ id: "run", seq: 0, name: "exit", code: COMMAND_NOT_FOUND }];
  }

  return [
    { id: "run", seq: 0, name: "stdout", value: encoder.encode(`ran on ${backend}\n`) },
    { id: "run", seq: 1, name: "exit", code: 0 },
  ];
}

function scriptedExec(isolateFindsCommand: boolean): ExecWorkspace["runtime"]["exec"] {
  return (_command, options) => {
    const events = runEvents(options.backend, isolateFindsCommand);

    let index = 0;

    return Promise.resolve({
      getReader: () => ({
        read: () => {
          const value = index < events.length ? events[index++] : undefined;

          return value === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.resolve({ done: false, value });
        },
        cancel: () => Promise.resolve(),
      }),
      kill: () => Promise.resolve(),
    });
  };
}

function completePull(): ExecWorkspace["pull"] {
  return () => ({
    [Symbol.asyncIterator]: () => {
      let finished = false;

      return {
        next: () => {
          if (finished) return Promise.resolve({ done: true, value: undefined });

          finished = true;

          return Promise.resolve({ done: false, value: { skipped: 0, complete: true } });
        },
      };
    },
  });
}

function scriptedWorkspace(isolateFindsCommand: boolean): ExecWorkspace {
  return { runtime: { exec: scriptedExec(isolateFindsCommand) }, pull: completePull() };
}

async function shown(
  handle: ExecBackendHandle,
): Promise<readonly [string, string, number | undefined]> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  for (let read = await handle.reader.read(); !read.done; read = await handle.reader.read()) {
    const event = read.value;

    if (event.name === "exit") exitCode = event.exitCode;
    else if (event.name === "stdout") stdout += new TextDecoder().decode(event.data);
    else stderr += event.name === "stderr" ? new TextDecoder().decode(event.data) : "";
  }

  return [stdout, stderr, exitCode];
}

function answer(
  route: Exclude<Route, "refused">,
  automatic: boolean,
  isolateFindsCommand: boolean,
): readonly [string, string, number] {
  if (route === "isolate" && !isolateFindsCommand) {
    return automatic
      ? ["container", `ran on ${RUNTIME_BACKENDS.container}\n`, 0]
      : ["isolate", "", COMMAND_NOT_FOUND];
  }

  return [route, `ran on ${RUNTIME_BACKENDS[route]}\n`, 0];
}

test("an exec answers from the runtime backend its documented route names, an automatic one falls back to the container when the isolate lacks the command, and a refused one says git runs only in the container", () =>
  hegel.testAsync(async (tc) => {
    const [command, automatic, isolate, container] = tc.draw(gs.sampledFrom(DOCUMENTED_ROUTES));
    const requested = tc.draw(gs.sampledFrom(["automatic", "isolate", "container"] as const));

    const input: ExecBackendInput = {
      command,
      cwd: "/",
      timeoutMs: 1,
      backend: requested === "automatic" ? undefined : requested,
    };

    const isolateFindsCommand = tc.draw(gs.booleans());

    const handle = await chosenExecBackend(scriptedWorkspace(isolateFindsCommand), {
      generation: 1,
    }).exec(input);

    const expected =
      requested === "container" ? container : requested === "isolate" ? isolate : automatic;

    if (expected === "refused") {
      const [stdout, stderr, exitCode] = await shown(handle);

      expect(handle.backend).toBe("isolate");
      expect(handle.isolateRefused).toBe(true);
      expect(stdout).toBe("");
      expect(stderr).toContain("git runs only in the container");
      expect(exitCode).toBe(1);

      return;
    }

    const answered = await shown(handle);

    expect([handle.backend, answered[0], answered[2]]).toEqual(
      answer(expected, requested === "automatic", isolateFindsCommand),
    );
  }));
