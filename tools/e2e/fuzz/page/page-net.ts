import type { FuzzWindow } from "./page-dom.ts";

type Patched = FuzzWindow & { fzPatched?: boolean };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;

  return input instanceof URL ? input.href : input.url;
}

export function installNet(window: Patched): void {
  if (window.fzPatched === true) return;

  const real = window.fetch.bind(window);

  window.fzPatched = true;
  window.fetch = async (input, init) => {
    const mode = window.fzMode ?? "none";
    const isSend = (init?.method ?? "GET") === "POST" && requestUrl(input).endsWith("/messages");

    if (mode === "offline") throw new TypeError("Failed to fetch");

    if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 2_000));

    const response = await real(input, init);

    if (mode === "drop" && isSend) throw new TypeError("Failed to fetch");

    return response;
  };
}
