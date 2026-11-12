import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { Duplex } from "node:stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  decodeProviderFrame,
  encodeFrame,
  ORB_PING,
  ORB_PONG,
  type HostFrame,
  type ProviderFrame,
} from "../../../src/orb-protocol.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const TEXT_OPCODE = 0x01;

const CLOSE_OPCODE = 0x08;

export type FakeHost = Readonly<{
  origin: string;
  attempts(): number;
  closedLinks(): number;
  received(): readonly (ProviderFrame | typeof ORB_PING)[];
  send(frame: HostFrame): void;
  closeLink(): void;
  close(): void;
}>;

export type FakeLink = Readonly<{ greeting?: HostFrame; answersPings?: boolean }>;

type ClientFrame = Readonly<{ opcode: number; payload: Buffer }>;

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);

  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);

  return Buffer.concat([header, payload]);
}

function nextClientFrame(buffer: Buffer): { frame: ClientFrame; size: number } | undefined {
  if (buffer.length < 2) return undefined;

  const shortLength = (buffer[1] ?? 0) & 0x7f;
  const lengthEnd = shortLength === 126 ? 4 : 2;

  if (buffer.length < lengthEnd) return undefined;

  const length = shortLength === 126 ? buffer.readUInt16BE(2) : shortLength;
  const maskEnd = lengthEnd + 4;
  const size = maskEnd + length;

  if (buffer.length < size) return undefined;

  const mask = buffer.subarray(lengthEnd, maskEnd);

  const payload = Buffer.from(
    buffer.subarray(maskEnd, size).map((byte, index) => byte ^ (mask[index % 4] ?? 0)),
  );

  return { frame: { opcode: (buffer[0] ?? 0) & 0x0f, payload }, size };
}

function answerFrames(
  socket: Duplex,
  link: FakeLink,
  received: (ProviderFrame | typeof ORB_PING)[],
): void {
  let pending = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    for (let next = nextClientFrame(pending); next; next = nextClientFrame(pending)) {
      pending = pending.subarray(next.size);
      const { opcode, payload } = next.frame;

      if (opcode === CLOSE_OPCODE) socket.end(Buffer.from([0x88, 0]));

      if (opcode !== TEXT_OPCODE) continue;

      const text = payload.toString();

      if (text !== ORB_PING) {
        received.push(Option.getOrThrow(decodeProviderFrame(text)));

        continue;
      }

      received.push(ORB_PING);

      if (link.answersPings !== false) socket.write(textFrame(ORB_PONG));
    }
  });
}

export type FakeContainer = Readonly<{ address: string; close(): void }>;

async function listening(handler?: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return { server, address: `127.0.0.1:${port}` };
}

export async function startFakeContainer(handler: RequestListener): Promise<FakeContainer> {
  const { server, address } = await listening(handler);

  return {
    address,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function startFakeHost(link?: FakeLink): Promise<FakeHost> {
  const { server, address } = await listening();
  let attempts = 0;
  let closedLinks = 0;
  let socket: Duplex | undefined;
  const received: (ProviderFrame | typeof ORB_PING)[] = [];

  server.on("upgrade", (request, upgraded) => {
    attempts += 1;
    socket = upgraded;

    if (link === undefined) {
      upgraded.destroy();

      return;
    }

    const accept = createHash("sha1")
      .update(String(request.headers["sec-websocket-key"]) + WEBSOCKET_GUID)
      .digest("base64");

    answerFrames(upgraded, link, received);
    upgraded.on("error", () => {
      upgraded.destroy();
    });
    upgraded.on("close", () => {
      closedLinks += 1;
    });
    upgraded.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    if (link.greeting !== undefined) upgraded.write(textFrame(encodeFrame(link.greeting)));
  });

  return {
    origin: `http://${address}`,
    attempts: () => attempts,
    closedLinks: () => closedLinks,
    received: () => received,
    send: (frame) => {
      socket?.write(textFrame(encodeFrame(frame)));
    },
    closeLink: () => {
      socket?.destroy();
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
