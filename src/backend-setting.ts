import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const BackendSetting = Schema.Literals(["provider", "cloudflare"]);

export type BackendSetting = typeof BackendSetting.Type;

type SettingStore = Readonly<{
  get(key: string): string | undefined;
  put(key: string, value: string): void;
}>;

const BACKEND_SETTING_KEY = "workspace-backend";

export const decodeBackendSetting = Schema.decodeUnknownOption(BackendSetting);

export function readBackendSetting(kv: SettingStore): BackendSetting {
  return Option.getOrElse(decodeBackendSetting(kv.get(BACKEND_SETTING_KEY)), () => "provider");
}

export function writeBackendSetting(kv: SettingStore, setting: BackendSetting): void {
  kv.put(BACKEND_SETTING_KEY, setting);
}

export type WorkspaceBackendChange =
  | Readonly<{ ok: true; backend: BackendSetting }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy" }> }>;
