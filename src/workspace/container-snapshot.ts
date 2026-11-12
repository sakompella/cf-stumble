import {
  WorkspaceContainerAPI,
  type ContainerLaunchSpec,
  type ContainerRuntimeInfo,
} from "@cloudflare/computer/backends/container";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import { WORKSPACE_ROOT } from "../workspace-layout.js";

const SNAPSHOT_KEY = "workspace-container-snapshot";

const LAUNCHED_IMAGE_KEY = "workspace-container-image";

const IMAGE_NAME = "app";

const RESTORABLE_MS = 29 * 24 * 60 * 60 * 1_000;

const SNAPSHOT_TIMEOUT_MS = 60_000;

const RESTORE_ENTRYPOINT = [
  "/bin/sh",
  "-c",
  `rm -rf ${WORKSPACE_ROOT} && exec /usr/local/bin/computerd`,
];

const SavedSnapshot = Schema.Struct({
  id: Schema.String,
  image: Schema.String,
  storePaths: Schema.Number,
  usedAtMs: Schema.Number,
});

type SavedSnapshot = typeof SavedSnapshot.Type;

const decodeSaved = Schema.decodeUnknownOption(SavedSnapshot);

const decodeImage = Schema.decodeUnknownOption(Schema.String);

type SnapshotStore = Pick<SyncKvStorage, "get" | "put" | "delete">;

type SnapshotContainer = Pick<Container, "images" | "snapshotContainer"> &
  Readonly<{ exec(command: string[]): Promise<Pick<ExecProcess, "output">> }>;

function restorable(saved: SavedSnapshot, image: string, nowMs: number): boolean {
  return saved.image === image && nowMs - saved.usedAtMs < RESTORABLE_MS;
}

function storeGrew(
  saved: Option.Option<SavedSnapshot>,
  image: string,
  storePaths: number,
): boolean {
  return Option.match(saved, {
    onNone: () => true,
    onSome: (snapshot) => snapshot.image !== image || storePaths > snapshot.storePaths,
  });
}

export class SnapshotContainerAPI extends WorkspaceContainerAPI {
  readonly #state: DurableObjectState;
  readonly #kv: SnapshotStore;

  constructor(state: DurableObjectState) {
    super(state);
    this.#state = state;
    this.#kv = state.storage.kv;
  }

  override async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const image = this.#image(spec);
    const nowMs = Date.now();
    const saved = decodeSaved(this.#kv.get(SNAPSHOT_KEY));
    const restore = Option.filter(saved, (snapshot) => restorable(snapshot, image, nowMs));

    if (Option.isNone(restore)) {
      this.#kv.delete(SNAPSHOT_KEY);

      return this.#launched(await super.start(spec), image, "image");
    }

    const snapshot = restore.value;

    const runtime = await super
      .start({ ...spec, containerSnapshot: { id: snapshot.id }, entrypoint: RESTORE_ENTRYPOINT })
      .catch((cause: unknown) => {
        this.#kv.delete(SNAPSHOT_KEY);
        logRedactedCause("workspace.container: snapshot restore failed", cause);

        return null;
      });

    if (runtime === null) return this.#launched(await super.start(spec), image, "image");

    if (runtime.outcome !== "adopted") this.#kv.put(SNAPSHOT_KEY, { ...snapshot, usedAtMs: nowMs });

    return this.#launched(runtime, image, "snapshot");
  }

  override async restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    this.#kv.delete(SNAPSHOT_KEY);

    return this.#launched(await super.restart(spec), this.#image(spec), "image");
  }

  #launched(
    runtime: ContainerRuntimeInfo,
    image: string,
    from: "image" | "snapshot",
  ): ContainerRuntimeInfo {
    if (runtime.outcome === "adopted") return runtime;

    this.#kv.put(LAUNCHED_IMAGE_KEY, image);
    logEvent("info", "workspace.container.launch", { from, image });

    return runtime;
  }

  #image(spec: ContainerLaunchSpec): string {
    return this.#state.container?.images[spec.name ?? IMAGE_NAME] ?? "";
  }
}

async function countStorePaths(container: SnapshotContainer): Promise<number> {
  const listing = await container.exec(["/bin/sh", "-c", "ls -A /nix/store | wc -l"]);
  const { exitCode, stdout } = await listing.output();
  const count = Number(new TextDecoder().decode(stdout).trim());

  if (exitCode !== 0 || !Number.isInteger(count))
    throw new Error(`counting /nix/store entries exited ${String(exitCode)}`);

  return count;
}

export function snapshotBeforeStop(container: SnapshotContainer, kv: SnapshotStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("container snapshot timed out"));
    }, SNAPSHOT_TIMEOUT_MS);

    save(container, kv).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error("container snapshot failed", { cause }));
      },
    );
  });
}

async function save(container: SnapshotContainer, kv: SnapshotStore): Promise<void> {
  const image = container.images[IMAGE_NAME] ?? "";

  if (!Option.contains(decodeImage(kv.get(LAUNCHED_IMAGE_KEY)), image)) {
    logEvent("info", "workspace.container.snapshot", { outcome: "older-image" });

    return;
  }

  const storePaths = await countStorePaths(container);

  if (!storeGrew(decodeSaved(kv.get(SNAPSHOT_KEY)), image, storePaths)) {
    logEvent("info", "workspace.container.snapshot", { outcome: "unchanged", storePaths });

    return;
  }

  const startedAtMs = Date.now();
  const snapshot = await container.snapshotContainer({});
  const usedAtMs = Date.now();

  kv.put(SNAPSHOT_KEY, { id: snapshot.id, image, storePaths, usedAtMs });
  logEvent("info", "workspace.container.snapshot", {
    outcome: "saved",
    image,
    storePaths,
    sizeBytes: snapshot.size,
    durationMs: usedAtMs - startedAtMs,
  });
}
