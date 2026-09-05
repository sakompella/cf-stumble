/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { sampleProjectOne, sampleProjectTwo } from "../../project-fixtures.js";
import { projectDirectory } from "../../../src/workspace-layout.js";
import { calls, says } from "../../facet/generation-0/facet-turn-helpers.js";
import {
  completedTurn,
  facetRunning,
  otherTenantWorkspaceName,
  projectWorkspaces,
  turnFor,
  turnWithNothingServing,
  workspaceName,
} from "./project-turn-helpers.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";

/**
 * The production path from a client-supplied project id to a turn running in that project's
 * directory, across three isolates: this one asks, a second hands out the capability, and a third
 * runs the turn.
 *
 * Only the Workspace Host itself is a stand-in, and not by preference: the real `WorkspaceHost`
 * Durable Object cannot be constructed in this runtime at all, because its constructor builds a
 * `WorkspaceContainerAPI` and `@cloudflare/vitest-plugin` provides no container. The stand-in
 * reproduces the one behaviour these tests rest on — a name selects a filesystem — and nothing
 * else. Everything above it is the deployed code: the catalog resolves the id, `workspace-layout`
 * gives the directory, `ProjectRpcTarget` is the capability, and the turn is the real Generation 0
 * turn running Pi's stock tools.
 *
 * What changed with ADR-0038: selecting a project no longer selects a container. One workspace
 * holds every repository, and the project id chooses the directory the turn starts in.
 */

const projectOne = sampleProjectOne;
const projectTwo = sampleProjectTwo;

/**
 * The tool-result frame of a turn. A turn publishes the tool call before its result, so these
 * tests name the frame they mean rather than counting positions in the stream.
 */
function toolResultFrame(frames: readonly FacetTurnFrame[]): FacetTurnFrame | undefined {
  return frames.find((frame) => frame.kind === "tool-result");
}

afterEach(async () => {
  await reset();
});

test("a turn writes into the selected project's own directory in the tenant's workspace", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([
    calls("write", { path: "notes.txt", content: "written by the turn" }),
    says("Wrote it."),
  ]);

  const frames = await completedTurn(workspaces, facet, projectOne.id);

  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    await workspaces.fileText(workspaceName, `${projectDirectory(projectOne.id)}/notes.txt`),
    "no capability was passed in, so these bytes prove the path obtained a working one itself",
  ).toBe("written by the turn");
});

test("selecting another project selects another directory, not another workspace", async () => {
  const workspaces = await projectWorkspaces();

  const first = await facetRunning([
    calls("write", { path: "who.txt", content: "project one" }),
    says("Wrote it."),
  ]);
  await completedTurn(workspaces, first, projectOne.id);
  const second = await facetRunning([
    calls("write", { path: "who.txt", content: "project two" }),
    says("Wrote it."),
  ]);
  await completedTurn(workspaces, second, projectTwo.id);

  expect(
    await workspaces.fileText(workspaceName, `${projectDirectory(projectOne.id)}/who.txt`),
  ).toBe("project one");
  expect(
    await workspaces.fileText(workspaceName, `${projectDirectory(projectTwo.id)}/who.txt`),
  ).toBe("project two");
  expect(
    await workspaces.requestedNames(),
    "two projects of one tenant must share one workspace (ADR-0038)",
  ).toEqual([workspaceName]);
});

test("a turn may read a sibling repository, because the workspace is one machine", async () => {
  const workspaces = await projectWorkspaces();

  const writer = await facetRunning([
    calls("write", { path: "shared.txt", content: "project one wrote this" }),
    says("Wrote it."),
  ]);
  const wrote = await completedTurn(workspaces, writer, projectOne.id);
  expect(wrote.at(-1), "project one's write must land before project two reads").toMatchObject({
    kind: "completed",
  });

  const reader = await facetRunning([
    calls("read", { path: `../${projectOne.id}/shared.txt` }),
    says("Read it."),
  ]);
  const read = await completedTurn(workspaces, reader, projectTwo.id);

  expect(
    toolResultFrame(read),
    "ADR-0038 permits reaching a sibling repository; it is not a security boundary",
  ).toMatchObject({ kind: "tool-result", toolName: "read", isError: false });
});

test("a turn cannot address anything outside the workspace root", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([
    calls("read", { path: "../../../etc/passwd" }),
    says("Tried it."),
  ]);

  const frames = await completedTurn(workspaces, facet, projectOne.id);

  expect(
    toolResultFrame(frames),
    "the path guard is the workspace root, not the project directory",
  ).toMatchObject({ kind: "tool-result", toolName: "read", isError: true });
});

test("another tenant's workspace is a different name that no request can reach", async () => {
  const workspaces = await projectWorkspaces();

  const writer = await facetRunning([
    calls("write", { path: "tenant.txt", content: "tenant one" }),
    says("Wrote it."),
  ]);
  await completedTurn(workspaces, writer, projectOne.id);
  const other = await facetRunning([calls("read", { path: "tenant.txt" }), says("Read it.")]);
  const read = await completedTurn(workspaces, other, projectOne.id, otherTenantWorkspaceName);

  expect(
    toolResultFrame(read),
    "the second tenant's Supervisor names its own workspace, which holds no such file",
  ).toMatchObject({ kind: "tool-result", toolName: "read", isError: true });
  expect(
    await workspaces.fileText(
      otherTenantWorkspaceName,
      `${projectDirectory(projectOne.id)}/tenant.txt`,
    ),
  ).toBeNull();
  expect((await workspaces.requestedNames()).length, "two tenants, two workspaces").toBe(2);
});

test("an unrecognized project id is refused before any workspace is named", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("never asked")]);

  const unknown = await turnFor(workspaces, facet, "not-a-configured-project");
  const malformed = await turnFor(workspaces, facet, { id: projectOne.id });

  expect(unknown).toEqual({ ok: false, reason: "unknown-project-id" });
  expect(malformed).toEqual({ ok: false, reason: "invalid-project-id" });
  expect(
    await workspaces.requestedNames(),
    "a client string must not reach a workspace, even a rejected one",
  ).toEqual([]);
});

test("nothing serving refuses the turn before a capability is obtained", async () => {
  const workspaces = await projectWorkspaces();

  const refused = await turnWithNothingServing(workspaces);

  expect(refused).toEqual({ ok: false, reason: "no-active-generation" });
  expect(
    await workspaces.requestedNames(),
    "a Supervisor with no generation to run the turn must not open a workspace",
  ).toEqual([]);
});
