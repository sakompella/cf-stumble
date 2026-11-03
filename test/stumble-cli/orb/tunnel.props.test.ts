import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, expect, test } from "vitest";
import { forwardedHead, serveEgress } from "../../../src/stumble-cli/orb/tunnel.js";

const TOKEN = "provider-token";

let upstream: Server;

let egress: Server;

let egressPort: number;

let workerUrl: URL;

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address()).port;
}

beforeAll(async () => {
  upstream = createServer((socket) => {
    socket.pipe(socket);
  });
  workerUrl = new URL(`http://127.0.0.1:${await listen(upstream)}`);
  egress = serveEgress({ url: workerUrl, token: TOKEN });
  egressPort = await listen(egress);
});

afterAll(() => {
  upstream.close();
  egress.close();
});

function exchange(chunks: readonly Buffer[], expectedBytes = Infinity): Promise<Buffer> {
  const socket: Socket = connect(egressPort, "127.0.0.1");
  const received: Buffer[] = [];
  let length = 0;

  return new Promise((resolve, reject) => {
    const finish = (): void => {
      socket.destroy();
      resolve(Buffer.concat(received));
    };

    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      length += chunk.byteLength;

      if (length >= expectedBytes) finish();
    });
    socket.on("end", finish);
    socket.on("error", reject);
  });
}

function splitAt(bytes: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.byteLength + 1)))].toSorted(
    (left, right) => left - right,
  );

  return [0, ...points].map((start, index) => bytes.subarray(start, points[index] ?? undefined));
}

const headerLine = gs
  .tuples(
    gs.fromRegex("[a-z][a-z-]{0,10}", { fullmatch: true }),
    gs.fromRegex("[ -~]{0,20}", { fullmatch: true }),
  )
  .map(([name, value]) => `${name}: ${value}`);

test("an /api upgrade reaches the Worker with only its path, host and token rewritten, and the rest passes both ways unchanged", async () => {
  await hegel.testAsync(
    async (tc) => {
      const headers = tc.draw(gs.arrays(headerLine, { maxSize: 5 }));
      const body = Buffer.from(tc.draw(gs.binary({ maxSize: 2_048 })));
      const cutPoints = gs.integers({ minValue: 0, maxValue: 10_000 });
      const cuts = tc.draw(gs.arrays(cutPoints, { maxSize: 4 }));
      const incoming = { method: "GET", path: "/api", headers: ["host: x", ...headers] };
      const head = ["GET /api HTTP/1.1", ...incoming.headers, "", ""].join("\r\n");
      const request = Buffer.concat([Buffer.from(head, "latin1"), body]);
      const sent = forwardedHead(incoming, { url: workerUrl, token: TOKEN });
      const rewritten = Buffer.concat([Buffer.from(sent, "latin1"), body]);

      const echoed = await exchange(splitAt(request, cuts), rewritten.byteLength);

      expect(echoed.toString("latin1")).toBe(rewritten.toString("latin1"));
      expect(echoed.toString("latin1")).toContain(`host: ${workerUrl.host}\r\n`);
      expect(echoed.toString("latin1").split("\r\n")[0]).toBe("GET /orb/computerd HTTP/1.1");
    },
    { testCases: 100 },
  );
});

test("the health check is answered locally and any other path is refused", async () => {
  const health = await exchange([Buffer.from("GET /health HTTP/1.1\r\nhost: x\r\n\r\n")]);
  const other = await exchange([Buffer.from("GET /files HTTP/1.1\r\nhost: x\r\n\r\n")]);

  expect(health.toString()).toMatch(/^HTTP\/1\.1 200 .*ok$/su);
  expect(other.toString()).toMatch(/^HTTP\/1\.1 404 /u);
});
