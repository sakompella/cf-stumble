import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import type {
  ProjectFileInfo,
  ProjectLstatInfo,
  ProjectResult,
  ProjectRpcTargetContract,
} from "../../../src/workspace/project/protocol.js";

/**
 * The two stub operations Workers RPC adds to a received capability, over a real
 * `ProjectRpcTarget`. `test/facet/generation-0/facet-turn-loaded.test.ts` proves the genuine
 * article behaves this way across a real RPC hop; this stand-in makes the same lifetime
 * observable in-process, where a test can count duplications and disposals and script the
 * filesystem and exec backend underneath.
 *
 * Using a handle after it is disposed throws with the runtime's own wording, so a test that
 * releases too early fails the same way it would against a real stub.
 */
export class FakeProjectCapability implements ProjectRpcTargetContract, Disposable {
  readonly ledger: { dups: number; disposals: number; live: number };
  readonly provider: FakeProjectFilesystemProvider;
  readonly execBackend: FakeExecBackend;
  readonly #target: ProjectRpcTarget;
  #disposed = false;

  private constructor(
    target: ProjectRpcTarget,
    provider: FakeProjectFilesystemProvider,
    execBackend: FakeExecBackend,
    ledger: { dups: number; disposals: number; live: number },
  ) {
    this.#target = target;
    this.provider = provider;
    this.execBackend = execBackend;
    this.ledger = ledger;
    ledger.live += 1;
  }

  static create(): FakeProjectCapability {
    const provider = new FakeProjectFilesystemProvider();
    const execBackend = new FakeExecBackend();
    const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend);
    return new FakeProjectCapability(target, provider, execBackend, {
      dups: 0,
      disposals: 0,
      live: 0,
    });
  }

  dup(): FakeProjectCapability {
    this.ledger.dups += 1;
    return new FakeProjectCapability(this.#target, this.provider, this.execBackend, this.ledger);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.ledger.disposals += 1;
    this.ledger.live -= 1;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
  lstat(path: unknown): Promise<ProjectResult<ProjectLstatInfo>> {
    return this.#live().lstat(path);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
  readFile(path: unknown): Promise<ProjectResult<Uint8Array>> {
    return this.#live().readFile(path);
  }

  writeFile(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
    path: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
    bytes: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
    mode: unknown,
  ): Promise<ProjectResult<null>> {
    return this.#live().writeFile(path, bytes, mode);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
  listFiles(path: unknown): Promise<ProjectResult<readonly ProjectFileInfo[]>> {
    return this.#live().listFiles(path);
  }

  startExec(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
    input: unknown,
  ): Promise<ProjectResult<{ operationId: string; events: ReadableStream<Uint8Array> }>> {
    return this.#live().startExec(input);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.
  kill(operationId: unknown): Promise<ProjectResult<null>> {
    return this.#live().kill(operationId);
  }

  #live(): ProjectRpcTarget {
    if (this.#disposed) throw new Error("RPC stub used after being disposed.");
    return this.#target;
  }
}
