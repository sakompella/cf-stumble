const MAX_SCORE = 60000;

const HASH_BASE = 107927;

const CHUNK_BYTES = 64;

const BINARY_SCAN_BYTES = 8000;

const NEWLINE = 10;

const CARRIAGE_RETURN = 13;

const MULTIPLIER = 0x61000f;

export const MINIMUM_SCORE = MAX_SCORE / 2;

function isText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, BINARY_SCAN_BYTES).includes(0);
}

function spans(bytes: Uint8Array): Map<number, number> {
  const text = isText(bytes);
  const counts = new Map<number, number>();
  let first = 0;
  let second = 0;
  let length = 0;

  bytes.forEach((byte, index) => {
    if (text && byte === CARRIAGE_RETURN && bytes[index + 1] === NEWLINE) return;

    const previous = first;
    first = ((first << 7) ^ (second >>> 25)) >>> 0;
    second = ((second << 7) ^ (previous >>> 25)) >>> 0;
    first = (first + byte) >>> 0;
    length += 1;

    if (length < CHUNK_BYTES && byte !== NEWLINE) return;

    const key = ((first + Math.imul(second, MULTIPLIER)) >>> 0) % HASH_BASE;
    counts.set(key, (counts.get(key) ?? 0) + length);
    first = 0;
    second = 0;
    length = 0;
  });

  if (length > 0) {
    const key = ((first + Math.imul(second, MULTIPLIER)) >>> 0) % HASH_BASE;
    counts.set(key, (counts.get(key) ?? 0) + length);
  }

  return counts;
}

export function similarity(source: Uint8Array, target: Uint8Array): number {
  const largest = Math.max(source.length, target.length);
  const delta = largest - Math.min(source.length, target.length);

  if (largest * (MAX_SCORE - MINIMUM_SCORE) < delta * MAX_SCORE) return 0;

  const targetSpans = spans(target);
  let copied = 0;

  for (const [key, count] of spans(source)) copied += Math.min(count, targetSpans.get(key) ?? 0);

  return Math.floor((copied * MAX_SCORE) / largest);
}
