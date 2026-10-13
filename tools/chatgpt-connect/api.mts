import { ToolError } from "./error.mjs";
import { readFile } from "node:fs/promises";
import { parseJsonRecord, type CdpResult } from "../browser-harness/cdp.mjs";
import { type JsonRecord } from "../json.mjs";
import { type Options } from "./options.mjs";

export async function serviceHeaders(options: Options): Promise<
  Readonly<{
    "CF-Access-Client-Id": string;
    "CF-Access-Client-Secret": string;
    Origin: string;
    "content-type": string;
  }>
> {
  const token = parseJsonRecord(await readFile(options.tokenFile, "utf8"));
  const clientId = token?.text("clientId");
  const clientSecret = token?.text("clientSecret");

  if (
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    throw new ToolError("Service token file is invalid");
  }

  return {
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
    Origin: options.origin,
    "content-type": "application/json",
  };
}

export async function post(
  options: Options,
  headers: Awaited<ReturnType<typeof serviceHeaders>>,
  path: string,
  body: JsonRecord,
  signal: AbortSignal,
): Promise<CdpResult> {
  const response = await fetch(`${options.origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
    signal,
  });

  const document = parseJsonRecord(await response.text());

  if (response.status !== 200 || document === undefined) {
    const code = document?.text("problem.code");

    if (
      path.endsWith("/complete") &&
      response.status >= 400 &&
      response.status < 500 &&
      code !== undefined &&
      /^[a-z0-9_-]{1,80}$/iu.test(code)
    ) {
      throw new ToolError(code);
    }

    throw new ToolError(`Owner API status ${response.status}`);
  }

  return document;
}
