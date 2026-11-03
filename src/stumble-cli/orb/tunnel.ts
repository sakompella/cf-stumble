import { connect as connectTcp, createServer, type Server, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { ORB_COMPUTERD_PATH, ORB_TOKEN_HEADER } from "../../workspace/orb-protocol.js";

const HEAD_END = "\r\n\r\n";

const HEALTHY = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok";

const REFUSED = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

export type RequestHead = Readonly<{ method: string; path: string; headers: readonly string[] }>;

export type WorkerTarget = Readonly<{ url: URL; token: string }>;

export function splitHead(buffered: Buffer): { head: RequestHead; rest: Buffer } | undefined {
  const end = buffered.indexOf(HEAD_END);

  if (end === -1) return undefined;

  const [requestLine = "", ...headers] = buffered.subarray(0, end).toString("latin1").split("\r\n");
  const [method = "", path = ""] = requestLine.split(" ");

  return { head: { method, path, headers }, rest: buffered.subarray(end + HEAD_END.length) };
}

function headerName(line: string): string {
  return line.slice(0, line.indexOf(":")).trim().toLowerCase();
}

export function forwardedHead(head: RequestHead, target: WorkerTarget): string {
  const kept = head.headers.filter((line) => {
    const name = headerName(line);

    return name !== "host" && name !== ORB_TOKEN_HEADER;
  });

  return [
    `${head.method} ${ORB_COMPUTERD_PATH} HTTP/1.1`,
    `host: ${target.url.host}`,
    `${ORB_TOKEN_HEADER}: ${target.token}`,
    ...kept,
  ]
    .join("\r\n")
    .concat(HEAD_END);
}

function dialWorker(url: URL): Socket {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

  if (url.protocol === "https:")
    return connectTls({ host: url.hostname, port, servername: url.hostname });

  return connectTcp({ host: url.hostname, port });
}

function pipeToWorker(local: Socket, head: RequestHead, rest: Buffer, target: WorkerTarget): void {
  const remote = dialWorker(target.url);
  remote.write(forwardedHead(head, target));
  remote.write(rest);
  local.pipe(remote);
  remote.pipe(local);

  const closeBoth = (): void => {
    local.destroy();
    remote.destroy();
  };

  for (const socket of [local, remote]) {
    socket.on("error", closeBoth);
    socket.on("close", closeBoth);
  }
}

function answer(local: Socket, head: RequestHead, rest: Buffer, target: WorkerTarget): void {
  if (head.path === "/health") {
    local.end(HEALTHY);

    return;
  }

  if (head.path === "/api") {
    pipeToWorker(local, head, rest, target);

    return;
  }

  local.end(REFUSED);
}

export function serveEgress(target: WorkerTarget): Server {
  return createServer((local) => {
    let buffered = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);

      const split = splitHead(buffered);

      if (split === undefined) return;

      local.off("data", onData);
      local.pause();
      answer(local, split.head, split.rest, target);
    };

    local.on("data", onData);
    local.on("error", () => {
      local.destroy();
    });
  });
}
