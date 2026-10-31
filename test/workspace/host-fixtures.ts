import { Workspace } from "@cloudflare/computer";
import { WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import { computerStorage } from "../../src/workspace/workspace-platform.js";
import type {
  GitHubCredentialRequest,
  HarnessBuildRequest,
  ProjectProvisionRequest,
  ProjectRemovalRequest,
} from "../../src/workspace/workspace-surfaces.js";

export const REFUSED_BUILD: HarnessBuildRequest = {
  kind: "build-output",
  harnessCommit: "not-a-commit",
};

export const REFUSED_PROVISION: ProjectProvisionRequest = {
  kind: "provision-project",
  projectId: "not-a-project",
  repositoryUrl: "not-a-url",
  step: "clone",
};

export const REFUSED_REMOVAL: ProjectRemovalRequest = {
  kind: "remove-project",
  projectId: "not-a-project",
};

export const REFUSED_CREDENTIAL: GitHubCredentialRequest = {
  kind: "github-credential",
  step: "install",
  token: "not a token",
};

type StubbedMember = "fs" | "runtime";

const STUBBED_MEMBERS: readonly StubbedMember[] = ["fs", "runtime"];

const originalMembers = STUBBED_MEMBERS.map(
  (member) => [member, Object.getOwnPropertyDescriptor(Workspace.prototype, member)] as const,
);

export function stubWorkspaceMember<Member>(name: StubbedMember, member: Member): Member {
  Object.defineProperty(Workspace.prototype, name, { configurable: true, get: () => member });

  return member;
}

export function restoreWorkspaceMembers(): void {
  for (const [name, descriptor] of originalMembers) {
    if (descriptor !== undefined) Object.defineProperty(Workspace.prototype, name, descriptor);
  }
}

export async function seedWorkspaceRoot(state: DurableObjectState): Promise<void> {
  const workspace = new Workspace({
    storage: computerStorage(state.storage),
    sessionId: state.id.toString(),
    backends: [],
  });

  await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
}
