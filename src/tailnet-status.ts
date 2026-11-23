import type { Status } from "../build/tailnet/index.js";

export type TailnetStatus = Readonly<{
  node: Status;
}>;
