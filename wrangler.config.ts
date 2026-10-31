import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  build: { command: "pnpm run build:page" },
  types: {
    generate: false,
  },
});
