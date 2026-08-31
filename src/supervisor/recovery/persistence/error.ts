import type { RecoveryOperationErrorInput } from "../episode.js";

export function isNonemptyWellFormedUnicode(value: RecoveryOperationErrorInput): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- This parser must inspect each UTF-16 code unit to reject unpaired surrogates.
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      // oxlint-disable-next-line unicorn/prefer-code-point -- This parser must inspect each UTF-16 code unit to reject unpaired surrogates.
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}
