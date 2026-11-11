import { recordPost } from "./page-store.ts";
import { fz } from "./page-state.ts";

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function installNet(window: Window): void {
  if (fz.patched) return;

  const real = window.fetch.bind(window);

  fz.patched = true;
  window.fetch = async (input, init) => {
    const isSend = (init?.method ?? "GET") === "POST" && requestUrl(input).endsWith("/messages");

    if (isSend) recordPost(window, await new Response(init?.body).text(), fz.mode);

    if (fz.mode === "offline") throw new TypeError("Failed to fetch");

    if (fz.mode === "slow") await delay(2_000);

    const response = await real(input, init);

    if (fz.mode === "drop" && isSend) throw new TypeError("Failed to fetch");

    return response;
  };
}
