import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // The owner page's script is a generated module, so every Wrangler build, and so `cf build` and
  // `cf deploy`, builds it from its current source first.
  build: { command: "pnpm run build:page" },
  types: {
    generate: false,
  },
});
