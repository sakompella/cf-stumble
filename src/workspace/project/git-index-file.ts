const SIGNATURE = "DIRC";

const FIXED_BYTES = 62;

const EXTENDED_FLAG = 0x4000;

const NAME_LENGTH_MASK = 0xfff;

const STAGE_SHIFT = 12;

const STAGE_MASK = 3;

const HEADER_BYTES = 12;

const OID_OFFSET = 40;

const MODE_OFFSET = 24;

export type ReadFile = (path: string) => Promise<Uint8Array>;

export type RemoveFile = (path: string, stop: string) => Promise<void>;

export interface WorkFiles {
  readonly read: ReadFile;
  readonly remove: RemoveFile;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly list: (dir: string) => Promise<readonly string[]>;
}

export interface IndexEntry {
  readonly oid: string;
  readonly mode: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseIndex(bytes: Uint8Array): Map<string, IndexEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);

  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== SIGNATURE || ![2, 3].includes(version))
    throw new Error(`unsupported index format version ${version}`);

  const entries = new Map<string, IndexEntry>();
  let position = HEADER_BYTES;

  for (let remaining = view.getUint32(8); remaining > 0; remaining -= 1) {
    const flags = view.getUint16(position + FIXED_BYTES - 2);
    const header = FIXED_BYTES + (version === 3 && (flags & EXTENDED_FLAG) !== 0 ? 2 : 0);
    const nameStart = position + header;
    let nameEnd = nameStart + (flags & NAME_LENGTH_MASK);

    if ((flags & NAME_LENGTH_MASK) === NAME_LENGTH_MASK)
      nameEnd = nameStart + bytes.subarray(nameStart).indexOf(0);

    if (((flags >> STAGE_SHIFT) & STAGE_MASK) === 0)
      entries.set(new TextDecoder().decode(bytes.subarray(nameStart, nameEnd)), {
        oid: hex(bytes.subarray(position + OID_OFFSET, position + OID_OFFSET + 20)),
        mode: view.getUint32(position + MODE_OFFSET).toString(8),
      });

    position += (header + (nameEnd - nameStart) + 8) & ~7;
  }

  return entries;
}
