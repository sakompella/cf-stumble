import { parseSha } from "./types.js";
import type { Sha } from "./types.js";

export async function hashObject(bytes: Uint8Array): Promise<Sha> {
  const input = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-1", input);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return parseSha(hex);
}
