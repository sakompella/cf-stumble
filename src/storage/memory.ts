import { Result } from "better-result";
import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import { MAX_OBJECT_BYTES, ObjectTooLargeError, type SweepableStore } from "./types.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class MemoryStore implements SweepableStore {
  private readonly objects = new Map<Sha, Uint8Array>();
  private pointer: Sha | undefined;

  readObject(sha: Sha): ReturnType<SweepableStore["readObject"]> {
    return Promise.resolve(Result.ok(this.objects.get(sha)?.slice()));
  }

  async writeObject(bytes: Uint8Array): ReturnType<SweepableStore["writeObject"]> {
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      return Result.err(
        new ObjectTooLargeError({ actualBytes: bytes.byteLength, maxBytes: MAX_OBJECT_BYTES }),
      );
    }
    const copy = bytes.slice();
    const digest = await crypto.subtle.digest("SHA-1", copy);
    const sha = parseSha(bytesToHex(new Uint8Array(digest)));

    if (!this.objects.has(sha)) {
      this.objects.set(sha, copy);
    }
    return Result.ok(sha);
  }

  readPointer(): ReturnType<SweepableStore["readPointer"]> {
    return Promise.resolve(Result.ok(this.pointer));
  }

  setPointer(next: Sha, expected: Sha | undefined): ReturnType<SweepableStore["setPointer"]> {
    if (this.pointer !== expected) {
      return Promise.resolve(Result.ok(false));
    }
    this.pointer = next;
    return Promise.resolve(Result.ok(true));
  }

  listObjects(): ReturnType<SweepableStore["listObjects"]> {
    return Promise.resolve(Result.ok([...this.objects.keys()]));
  }

  deleteObject(sha: Sha): ReturnType<SweepableStore["deleteObject"]> {
    this.objects.delete(sha);
    return Promise.resolve(Result.ok());
  }
}
