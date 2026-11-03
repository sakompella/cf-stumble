import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import {
  decodeBody,
  decodeHostFrame,
  decodeProviderFrame,
  encodeBody,
  encodeFrame,
  type HostFrame,
  type ProviderFrame,
} from "../../src/orb-protocol.js";

const id = gs.integers({ minValue: 0, maxValue: 1_000_000 });

const word = gs.text({ maxSize: 12 });

const headers = gs.arrays(gs.tuples(word, word), { maxSize: 4 });

const body = gs.optional(
  gs.binary({ maxSize: 64 }).map((bytes) => btoa(String.fromCodePoint(...bytes))),
);

const job = gs.oneOf<Extract<HostFrame, { _tag: "job" }>["job"]>(
  gs
    .record({ container: word, env: gs.arrays(gs.tuples(word, word), { maxSize: 4 }) })
    .map(({ container, env }) => ({ _tag: "start", container, env: Object.fromEntries(env) })),
  word.map((container) => ({ _tag: "stop", container })),
  word.map((container) => ({ _tag: "delete", container })),
);

const hostFrame = gs.oneOf<HostFrame>(
  gs.record({ id, job }).map((fields) => ({ _tag: "job", ...fields })),
  gs
    .record({ id, port: id, method: word, path: word, headers, body })
    .map((fields) => ({ _tag: "fetch", ...fields })),
);

const providerFrame = gs.oneOf<ProviderFrame>(
  id.map((egressPort) => ({ _tag: "hello", egressPort })),
  gs.record({ id, runtime: gs.optional(word) }).map((fields) => ({ _tag: "job-done", ...fields })),
  gs
    .record({ id, status: id, headers, body })
    .map((fields) => ({ _tag: "fetch-result", ...fields })),
  gs.record({ id, message: word }).map((fields) => ({ _tag: "failed", ...fields })),
  gs.record({ runtime: word, reason: word }).map((fields) => ({ _tag: "exited", ...fields })),
);

test("every frame the Host sends decodes back to itself on the provider", () => {
  hegel.test((tc) => {
    const frame = tc.draw(hostFrame);

    expect(decodeHostFrame(encodeFrame(frame))).toEqual(Option.some(frame));
  });
});

test("every frame the provider sends decodes back to itself on the Host", () => {
  hegel.test((tc) => {
    const frame = tc.draw(providerFrame);

    expect(decodeProviderFrame(encodeFrame(frame))).toEqual(Option.some(frame));
  });
});

test("a frame meant for the other side, or any other text, is refused rather than misread", () => {
  hegel.test((tc) => {
    const text = tc.draw(
      gs.oneOf(
        gs.text(),
        hostFrame.map((frame) => encodeFrame(frame)),
        gs.just("ping"),
        gs.just('{"_tag":"job","id":-1,"job":{"_tag":"stop","container":"x"}}'),
      ),
    );

    const decoded = decodeProviderFrame(text);

    expect(Option.isNone(decoded)).toBe(true);
  });
});

test("a body survives the trip through base64, and an empty body is sent as null", () => {
  hegel.test((tc) => {
    const bytes = new Uint8Array(tc.draw(gs.binary({ maxSize: 4_096 })));
    const encoded = encodeBody(bytes);

    if (bytes.byteLength === 0) expect(encoded).toBeNull();
    else expect(encoded === null ? undefined : decodeBody(encoded)).toEqual(bytes);
  });
});
