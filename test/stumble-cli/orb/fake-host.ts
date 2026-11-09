import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import * as Schema from "effect/Schema";
import { encodeFrame, type HostFrame } from "../../../src/orb-protocol.js";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const CLOSE_OPCODE = 0x08;

export type FakeHost = Readonly<{
  origin: string;
  attempts(): number;
  closedLinks(): number;
  close(): void;
}>;

function textFrame(frame: HostFrame): Buffer {
  const payload = Buffer.from(encodeFrame(frame));

  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);

  return Buffer.concat([header, payload]);
}

export async function startFakeHost(greeting?: HostFrame): Promise<FakeHost> {
  const server = createServer();
  let attempts = 0;
  let closedLinks = 0;

  server.on("upgrade", (request, socket) => {
    attempts += 1;

    if (greeting === undefined) {
      socket.destroy();

      return;
    }

    const accept = createHash("sha1")
      .update(String(request.headers["sec-websocket-key"]) + WEBSOCKET_GUID)
      .digest("base64");

    socket.on("data", (chunk: Buffer) => {
      if (((chunk[0] ?? 0) & 0x0f) === CLOSE_OPCODE) socket.end(Buffer.from([0x88, 0]));
    });
    socket.on("close", () => {
      closedLinks += 1;
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(textFrame(greeting));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return {
    origin: `http://127.0.0.1:${port}`,
    attempts: () => attempts,
    closedLinks: () => closedLinks,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
