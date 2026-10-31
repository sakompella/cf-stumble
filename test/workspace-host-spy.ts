import { vi } from "vitest";

export type HostNamespace<Host> = Readonly<{ getByName(name: string): Host }>;

export function replaceWorkspaceHost<Host>(namespace: HostNamespace<NoInfer<Host>>, fake: Host) {
  return vi.spyOn(namespace, "getByName").mockReturnValue(fake);
}
