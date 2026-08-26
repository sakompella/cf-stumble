import git, { type FsClient } from "isomorphic-git";
import { describe, expect, it } from "vitest";

import {
  decodeObject,
  encodeObject,
  hashObject,
} from "../../src/git/index.js";
import { createMemoryFs } from "../support/memory-fs.js";

const gitdir = "/oracle/.git";

function createOracleFs(): FsClient {
  // MemoryFs uses a deliberately narrow runtime shape whose method record is typed loosely
  // because isomorphic-git's FsClient declarations use Function for every method.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return createMemoryFs() as FsClient;
}

describe("isomorphic-git codec oracle", () => {
  it("agrees on blob hashes and reads blobs in both directions", async () => {
    const cases = [
      new Uint8Array(),
      Uint8Array.from([0, 1, 2, 255, 0]),
    ];

    for (const data of cases) {
      const object = { type: "blob" as const, data };
      const encoded = encodeObject(object);

      const oracleFs = createOracleFs();
      const oracleOid = await git.writeBlob({ fs: oracleFs, gitdir, blob: data });
      await expect(hashObject(encoded)).resolves.toBe(oracleOid);

      const writtenByOracle = await git.readObject({
        fs: oracleFs,
        gitdir,
        oid: oracleOid,
        format: "wrapped",
      });
      if (writtenByOracle.type !== "wrapped") {
        throw new Error(`expected a wrapped blob, got ${writtenByOracle.type}`);
      }
      expect(decodeObject(new Uint8Array(writtenByOracle.object))).toEqual(object);

      const encodedFs = createOracleFs();
      const encodedOid = await git.writeObject({
        fs: encodedFs,
        gitdir,
        object: encoded,
        format: "wrapped",
      });
      expect(encodedOid).toBe(oracleOid);
      await expect(
        git.readBlob({ fs: encodedFs, gitdir, oid: encodedOid }),
      ).resolves.toEqual({ oid: encodedOid, blob: data });
    }
  });
});
