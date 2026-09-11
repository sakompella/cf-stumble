import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const transactions = new FakeProjectTransactions();
  const execBackend = new FakeExecBackend();
  const target = new ProjectRpcTarget(provider, transactions, execBackend);

  return { provider, transactions, execBackend, target };
}
