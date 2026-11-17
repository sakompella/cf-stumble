import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import type { Model } from "../../../src/page/client/model.js";
import { AWAITING, CONNECTED, readingGitHub } from "./github-answers.js";
import { findById, htmlOf } from "./rendered.js";

const CONTROLS = {
  authorize: ID.authorizeButton,
  complete: ID.completeAuthorizationButton,
  check: ID.refreshGitHubButton,
  link: ID.githubVerificationLink,
};

function offered(model: Model): string[] {
  const html = htmlOf(model);

  return Object.entries(CONTROLS)
    .filter(([, id]) => findById(html, id) !== undefined)
    .map(([name]) => name);
}

test.each([
  { state: "no record yet", github: null, controls: ["authorize", "check"] },
  { state: "disconnected", github: { state: "disconnected" }, controls: ["authorize", "check"] },
  {
    state: "reconnect-required",
    github: { state: "reconnect-required", reason: "credential-rejected" },
    controls: ["authorize", "check"],
  },
  {
    state: "awaiting-authorization",
    github: AWAITING,
    controls: ["authorize", "complete", "check", "link"],
  },
  { state: "connected", github: CONNECTED, controls: ["check"] },
  { state: "tooling-missing", github: { state: "tooling-missing" }, controls: ["check"] },
])("the GitHub panel offers only what works while $state", async ({ github, controls }) => {
  expect(offered(await readingGitHub(github))).toEqual(controls);
});
