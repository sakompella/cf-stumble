import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Project } from "../../project-catalog.js";
import { waitForWorkspaceProvision } from "../../workspace/index.js";
import {
  resolveSelectableProject,
  type SelectableCatalog,
  type SelectableProject,
} from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { MainFacetMountProblem } from "../artifacts/index.js";
import type { ProjectCapabilityStub, ProjectWorkspaceNamespace } from "./project-workspace.js";

export type ProjectTurnFacet = Readonly<{
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the generation parses the turn request; nothing on this side proves its shape.
    request: unknown,
    workingDirectory: string,
  ): Promise<ReadableStream<Uint8Array>>;
}>;

type ProvisionSelectedProject = (project: Project, signal: AbortSignal) => Effect.Effect<boolean>;

type ProvisionHarness = (signal: AbortSignal) => Effect.Effect<boolean>;

type MountServingGeneration = () => Effect.Effect<
  { readonly fetcher: ProjectTurnFacet },
  MainFacetMountProblem
>;

interface ProjectTurnRequest {
  readonly projectId: unknown;
  readonly request: unknown;
}

interface ProjectTurnInput extends ProjectTurnRequest {
  /** Server-derived from the tenant key, so a client cannot present one. */
  readonly workspaceName: string;
  readonly catalog: SelectableCatalog;
  readonly namespace: ProjectWorkspaceNamespace;
  readonly mount: MountServingGeneration;
  readonly provision: ProvisionSelectedProject;
  readonly provisionHarness?: ProvisionHarness | undefined;
  readonly signal: AbortSignal;
  /**
   * The capability is handed out with this budget, so the Workspace Host ends it at the turn's
   * deadline.
   */
  readonly remainingMs: () => number;
}

/** `no-active-generation` is not a fault: there was no main harness to run the turn. */
export type ProjectTurnRefusal =
  | "invalid-project-id"
  | "unknown-project-id"
  | "no-active-generation"
  | "mount-failed"
  | "workspace-unavailable"
  | "turn-not-started";

export type ProjectTurnStart =
  | Readonly<{ ok: true; frames: ReadableStream<Uint8Array>; workspace: TurnWorkspace }>
  | Readonly<{ ok: false; reason: ProjectTurnRefusal }>;

/**
 * Cancelling the generation's stream does not stop a quiet generation, since Workers RPC reports
 * the reader gone only on its next write. Ending the capability kills running commands and refuses
 * later calls through any duplicate the generation kept. Call `end` once.
 */
export type TurnWorkspace = Readonly<{ end(): void }>;

/**
 * Hold a duplicate, because Workers RPC disposes a received stub once the call that received it
 * returns, and the turn outlives that call.
 */
function holdWorkspace(capability: ProjectCapabilityStub): TurnWorkspace {
  const held = capability.dup();

  const release = () => {
    held[Symbol.dispose]();
  };

  return {
    end() {
      void held.endTurn().then(release, release);
    },
  };
}

const NOT_STARTED = { ok: false, reason: "turn-not-started" } as const satisfies ProjectTurnStart;

function mountRefusal(problemCode: string): "no-active-generation" | "mount-failed" {
  return problemCode === "no-active-generation" ? "no-active-generation" : "mount-failed";
}

type WorkspacePreparation = "ready" | "aborted" | "unavailable";

function prepareWorkspace(
  input: ProjectTurnInput,
  selected: SelectableProject,
): Effect.Effect<WorkspacePreparation> {
  return Effect.gen(function* () {
    if (!(yield* workspaceIsAvailable(input))) return "aborted";

    if (
      selected.kind === "harness" &&
      input.provisionHarness !== undefined &&
      !(yield* input.provisionHarness(input.signal))
    ) {
      return input.signal.aborted ? "aborted" : "unavailable";
    }

    return input.signal.aborted ? "aborted" : "ready";
  });
}

/**
 * The capability reaches the generation as an argument of `startTurn`, never as a loader
 * environment entry: the Worker Loader caches its entry under the harness commit, so a capability
 * there would serve every project. The workspace name comes from the Supervisor's tenant key, not
 * the request. Nothing disposes the obtained stub here, because the generation leases a duplicate
 * that outlives this call and disposing would cut a running turn off from its files.
 */
export function startFacetTurn(input: ProjectTurnInput): Effect.Effect<ProjectTurnStart> {
  return Effect.gen(function* () {
    const resolved = resolveSelectableProject(input.projectId, input.catalog);

    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    const selected = resolved.project;

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    const preparation = yield* prepareWorkspace(input, selected);

    if (preparation === "aborted") return NOT_STARTED;

    if (preparation === "unavailable") {
      return { ok: false, reason: "workspace-unavailable" };
    }

    const mounted = yield* Effect.result(input.mount());

    if (Result.isFailure(mounted)) {
      return { ok: false, reason: mountRefusal(mounted.failure.code) };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    if (selected.kind === "repository" && !(yield* input.provision(selected, input.signal))) {
      return { ok: false, reason: "workspace-unavailable" };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    const capability = yield* obtainCapability(input);

    if (capability === null) {
      return { ok: false, reason: "workspace-unavailable" };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    if (!(yield* workspaceIsAvailable(input))) return NOT_STARTED;

    return yield* beginOnFacet(input, mounted.success.fetcher, capability, selected);
  });
}

/** The hold is taken first, because handing a stub to a call gives it away. */
function beginOnFacet(
  input: ProjectTurnInput,
  facet: ProjectTurnFacet,
  capability: ProjectCapabilityStub,
  selected: SelectableProject,
): Effect.Effect<ProjectTurnStart> {
  return Effect.gen(function* () {
    const workspace = holdWorkspace(capability);

    const frames = yield* facetStream(() =>
      facet.startTurn(capability, input.request, selectedWorkingDirectory(selected)),
    ).pipe(Effect.onInterrupt(() => Effect.sync(workspace.end)));

    if (frames === null) {
      workspace.end();

      return NOT_STARTED;
    }

    return endedBeforeItBegan(input, frames, workspace);
  });
}

function obtainCapability(input: ProjectTurnInput): Effect.Effect<ProjectCapabilityStub | null> {
  return Effect.promise(() => {
    const remainingMs = input.remainingMs();

    return Promise.resolve(
      input.namespace.getByName(input.workspaceName).project({ remainingMs }),
    ).then(
      (capability) => capability,
      () => null,
    );
  });
}

function workspaceIsAvailable(input: ProjectTurnInput): Effect.Effect<boolean> {
  return waitForWorkspaceProvision(input.workspaceName, input.signal);
}

/**
 * A start interrupted while the answer is on its way cancels the live stream when it arrives
 * instead of leaving it unread.
 */
function facetStream(
  begin: () => Promise<ReadableStream<Uint8Array>>,
): Effect.Effect<ReadableStream<Uint8Array> | null> {
  return Effect.suspend(() => {
    let answer: Promise<ReadableStream<Uint8Array> | null>;

    try {
      answer = begin().then(
        (frames) => frames,
        () => null,
      );
    } catch {
      return Effect.succeed(null);
    }

    return Effect.promise(() => answer).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          void answer.then(cancelUnread);
        }),
      ),
    );
  });
}

function cancelUnread(frames: ReadableStream<Uint8Array> | null): void {
  frames?.cancel().then(
    () => {},
    () => {},
  );
}

/**
 * The facet already began work behind its stream, so the stream is cancelled and the workspace
 * ended.
 */
function endedBeforeItBegan(
  input: ProjectTurnInput,
  frames: ReadableStream<Uint8Array>,
  workspace: TurnWorkspace,
): ProjectTurnStart {
  if (!input.signal.aborted) {
    return { ok: true, frames, workspace };
  }

  cancelUnread(frames);
  workspace.end();

  return NOT_STARTED;
}
