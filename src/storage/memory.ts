import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { SweepableStore } from "./types.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MemoryStore implements SweepableStore {
  private readonly objects = new Map<Sha, Uint8Array>();
  private pointer: Sha | undefined;

  readObject(sha: Sha): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(sha)?.slice());
  }

  async writeObject(bytes: Uint8Array): Promise<Sha> {
    const copy = bytes.slice();
    const digest = await crypto.subtle.digest("SHA-1", copy);
    const sha = parseSha(bytesToHex(new Uint8Array(digest)));

    if (!this.objects.has(sha)) {
      this.objects.set(sha, copy);
    }
    return sha;
  }

  readPointer(): Promise<Sha | undefined> {
    return Promise.resolve(this.pointer);
  }

  setPointer(next: Sha, expected: Sha | undefined): Promise<boolean> {
    if (this.pointer !== expected) {
      return Promise.resolve(false);
    }
    this.pointer = next;
    return Promise.resolve(true);
  }

  listObjects(): Promise<readonly Sha[]> {
    return Promise.resolve([...this.objects.keys()]);
  }

  deleteObject(sha: Sha): Promise<void> {
    this.objects.delete(sha);
    return Promise.resolve();
  }
}
