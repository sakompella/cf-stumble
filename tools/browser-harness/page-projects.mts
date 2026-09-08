import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";

/**
 * The sidebar as a reader sees it: which projects are offered, where each one lives, which one is
 * current, and what the page says about the workspace's GitHub authorization.
 *
 * `locations` is read separately from `labels` because the two answer different questions. A page
 * that listed both allowed working directories but showed neither a repository URL nor the harness
 * checkout would leave a reader unable to tell which project a name refers to.
 */

export type ProjectListSnapshot = Readonly<{
  status: string;
  projects: readonly string[];
  labels: readonly string[];
  locations: readonly string[];
  selected: readonly string[];
  ariaCurrent: readonly string[];
  githubState: string;
  githubDetail: string;
  connectStatus: string;
  verificationHref: string;
  verificationText: string;
  verificationTarget: string;
  verificationRel: string;
  credentialInputs: readonly string[];
}>;

export function readProjectList(page: BrowserPage): Promise<ProjectListSnapshot> {
  return page.evaluate<ProjectListSnapshot>(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? "";
    const buttons = Array.from(document.querySelectorAll(".${CLASS.projectButton}"));
    const link = document.getElementById("${ID.githubVerificationLink}");
    const credential = /token|secret|password|credential/i;
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    return {
      status: read("${ID.projectListStatus}"),
      projects: buttons.map((button) => button.getAttribute("data-project-id") ?? ""),
      labels: buttons.map((button) => button.textContent ?? ""),
      locations: buttons.map((button) => button.querySelector(".repo")?.textContent ?? ""),
      selected: buttons
        .filter((button) => button.classList.contains("${CLASS.selectedProject}"))
        .map((button) => button.getAttribute("data-project-id") ?? ""),
      ariaCurrent: buttons.map((button) => button.getAttribute("aria-current") ?? ""),
      githubState: read("${ID.githubState}"),
      githubDetail: read("${ID.githubDetail}"),
      connectStatus: read("${ID.connectStatus}"),
      verificationHref: link === null ? "" : (link.getAttribute("href") ?? ""),
      verificationText: link === null ? "" : (link.textContent ?? ""),
      verificationTarget: link === null ? "" : (link.getAttribute("target") ?? ""),
      verificationRel: link === null ? "" : (link.getAttribute("rel") ?? ""),
      credentialInputs: inputs
        .map((input) => {
          const label = input.id === "" ? null : document.querySelector("label[for=" + JSON.stringify(input.id) + "]");
          return [input.id, input.name ?? "", input.type ?? "", input.placeholder ?? "",
            label === null ? "" : (label.textContent ?? "")].join(" ");
        })
        .filter((described) => credential.test(described)),
    };
  })()`);
}
