import type { Model } from "../../../src/page/client/model.js";
import { Message } from "../../../src/page/client/message.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled } from "./requests.js";

export const CONNECTED = {
  state: "connected",
  login: "octocat",
  source: "device-authorization",
} as const;

export const AWAITING = {
  state: "awaiting-authorization",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: 1,
} as const;

export const LATE_MORNING = new Date(2026, 9, 16, 11, 5).getTime();

type Stored = Readonly<{ github: object | null; checkedAt: number | null }>;

export async function readingGitHub(
  github: Stored["github"],
  checkedAt: Stored["checkedAt"] = LATE_MORNING,
  start: Model = init().model,
): Promise<Model> {
  const done = await settled(update(start, Message.ClickedRefreshGitHub()), () =>
    Promise.resolve(Response.json({ ok: true, github, checkedAt })),
  );

  return done.model;
}
