import { redactCredentials } from "../../src/github/redaction.js";

export function containsCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}
