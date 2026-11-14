import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";

const RestoreState = Schema.fromJsonString(
  Schema.Struct({ label: Schema.optional(Schema.Number), project: Schema.optional(Schema.String) }),
);

export type RestoreState = Readonly<{ label: number | undefined; project: string | undefined }>;

function file(runId: string): string {
  return join(tmpdir(), `cf-stumble-e2e-${runId}-restore.json`);
}

export function loadRestoreState(runId: string): RestoreState {
  if (!existsSync(file(runId))) return { label: undefined, project: undefined };

  const saved = Schema.decodeUnknownSync(RestoreState)(readFileSync(file(runId), "utf8"));

  return { label: saved.label, project: saved.project };
}

export function saveRestoreState(runId: string, state: RestoreState): void {
  writeFileSync(file(runId), JSON.stringify(state), { mode: 0o600 });
}

export function forgetRestoreState(runId: string): void {
  rmSync(file(runId), { force: true });
}
