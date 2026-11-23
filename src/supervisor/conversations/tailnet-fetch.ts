import type { TailnetFetch } from "../../facet/index.js";

export function tailnetFetchOf(tailnet?: Pick<Fetcher, "fetch">): TailnetFetch {
  return (url, init) =>
    tailnet === undefined
      ? Promise.reject(new Error("no tailnet is connected to this deployment"))
      : Promise.resolve().then(() => tailnet.fetch(new Request(url, init)));
}
