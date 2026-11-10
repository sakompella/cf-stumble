import type { Case } from "./http-case.mts";

const CLIP = 300;

function halves(body: NonNullable<Case["body"]>): Case["body"][] {
  if (body.kind === "text") {
    return body.text.length > 1
      ? [
          { kind: "text", text: body.text.slice(0, body.text.length >> 1) },
          { kind: "text", text: body.text.slice(body.text.length >> 1) },
        ]
      : [];
  }

  if (body.kind === "repeat") return body.count > 1 ? [{ ...body, count: body.count >> 1 }] : [];

  if (body.kind === "nest") return body.depth > 1 ? [{ ...body, depth: body.depth >> 1 }] : [];

  return body.hex.length > 2
    ? [{ ...body, hex: body.hex.slice(0, (body.hex.length >> 2) * 2) }]
    : [];
}

function smaller(body: Case["body"]): Case["body"][] {
  return body === undefined ? [] : [undefined, ...halves(body)];
}

export function reductions(probe: Case): Case[] {
  const withoutHeader = probe.headers.map((_header, index) => ({
    ...probe,
    headers: probe.headers.filter((_other, position) => position !== index),
  }));

  const query = probe.path.indexOf("?");

  const paths = [
    ...(query >= 0 ? [probe.path.slice(0, query)] : []),
    ...(probe.path.length > 2 ? [probe.path.slice(0, probe.path.length >> 1)] : []),
  ].map((path) => ({ ...probe, path }));

  const methods = ["GET", "POST"].flatMap((method) =>
    method === probe.method ? [] : [{ ...probe, method }],
  );

  return [
    ...smaller(probe.body).map((body) => ({ ...probe, body })),
    ...withoutHeader,
    ...paths,
    ...methods,
  ];
}

export async function shrink(
  probe: Case,
  stillFails: (candidate: Case) => Promise<boolean>,
  limit: number,
): Promise<Case> {
  let current = probe;
  let sends = 0;
  let progress = true;

  while (progress && sends < limit) {
    progress = false;

    for (const candidate of reductions(current)) {
      sends += 1;

      if (await stillFails(candidate)) {
        current = candidate;
        progress = true;

        break;
      }

      if (sends >= limit) break;
    }
  }

  return current;
}

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}...(${text.length} chars)` : text;
}

export function render(probe: Case): string {
  return JSON.stringify({
    ...probe,
    path: clip(probe.path),
    headers: probe.headers.map(([name, value]) => [name, clip(value)]),
    body:
      probe.body === undefined
        ? undefined
        : {
            ...probe.body,
            ...("text" in probe.body && { text: clip(probe.body.text) }),
            ...("hex" in probe.body && { hex: clip(probe.body.hex) }),
          },
  });
}
