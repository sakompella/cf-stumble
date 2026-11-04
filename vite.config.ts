import { cloudflare } from "@cloudflare/vite-plugin";
import { bindings } from "cf/config";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      config: (loaded) => ({
        ...loaded,
        worker: {
          ...loaded.worker,
          compatibilityFlags: [...(loaded.worker.compatibilityFlags ?? []), "enable_weak_ref"],
          env: { ...loaded.worker.env, OWNER_PASSWORD: bindings.secret() },
        },
      }),
    }),
  ],
});
