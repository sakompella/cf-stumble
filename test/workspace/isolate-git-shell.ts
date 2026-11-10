import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { seedWorkspaceRoot } from "./host-fixtures.js";

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.String, data: Schema.optional(Schema.String) }),
  ),
);

export const SETUP = [
  "git init",
  "git config user.name Test",
  "git config user.email test@example.com",
  "echo one > a.txt",
  "echo two > b.txt",
  "git add -A",
  "git commit -q -m first",
].join(" && ");

export function shell(name: string, command: string) {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);

    const target = await host.project({ remainingMs: 60_000 });

    const started = await target.startExec({ command, timeoutMs: 20_000, backend: "isolate" });

    if (!started.ok) throw new Error(started.error.code);

    const lines = (await new Response(started.value.events).text()).split("\n").filter(Boolean);
    const events = lines.map((line) => decodeEvent(line));

    return {
      stdout: events
        .flatMap((event) => (event.kind === "stdout" ? [event.data] : []))
        .join("")
        .replace("Initialized empty Git repository in /workspace/.git/\n", ""),
      stderr: events.flatMap((event) => (event.kind === "stderr" ? [event.data] : [])).join(""),
    };
  });
}
