import { env } from "cloudflare:workers";

export function ownerAuthorization(password = env.OWNER_PASSWORD ?? ""): string {
  return `Basic ${btoa(`aditya:${password}`)}`;
}

export function ownerRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", ownerAuthorization());

  return new Request(url, { ...init, headers });
}
