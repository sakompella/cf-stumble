import { execFileSync } from "node:child_process";

const imageRefScript = new URL("image-ref.sh", import.meta.url);

export const workspaceImage = execFileSync(imageRefScript.pathname, { encoding: "utf8" }).trim();
