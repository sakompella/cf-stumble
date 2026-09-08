import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  byId,
  selectRequests,
  waitForText,
  type BrowserPage,
  type HarnessServer,
} from "../harness.mjs";

export const CANDIDATE = { label: 2, harnessCommit: "def456", status: "ready" } as const;

export async function openControls(page: BrowserPage): Promise<void> {
  await page.click(`${byId(ID.generationDrawer)} summary`);
}

export async function submitCommit(page: BrowserPage, commit: string): Promise<void> {
  await page.type(byId(ID.candidateCommitInput), commit);
  await page.click(byId(ID.submitCandidateButton));
  await waitForText(page, ID.submitStatus, "ok");
}

export async function activateLabel(page: BrowserPage, label: number): Promise<void> {
  await page.type(byId(ID.activateLabelInput), String(label));
  await page.click(byId(ID.activateButton));
  await waitForText(page, ID.activateStatus, "ok");
}

export async function rollbackLabel(page: BrowserPage, label: number): Promise<void> {
  await page.type(byId(ID.rollbackLabelInput), String(label));
  await page.click(byId(ID.rollbackButton));
  await waitForText(page, ID.rollbackStatus, "ok");
}

export function generationRequests(server: HarnessServer, path: string) {
  return selectRequests(server.requests(), "POST", path);
}

export async function waitForGeneration(
  page: BrowserPage,
  label: string,
  epoch: string,
): Promise<void> {
  await page.waitFor(
    `document.getElementById(${JSON.stringify(ID.activeGenerationLabel)})?.textContent === ${JSON.stringify(label)} && document.getElementById(${JSON.stringify(ID.generationEpoch)})?.textContent === ${JSON.stringify(epoch)}`,
  );
  await waitForText(page, ID.statusStatus, "ok");
}

export async function prepareCandidate(page: BrowserPage): Promise<void> {
  await submitCommit(page, CANDIDATE.harnessCommit);
  await waitForGeneration(page, "1", "3");
}
