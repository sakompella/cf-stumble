/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { PROJECT_CATALOG } from "../../../src/project-catalog.js";
import { calls, says } from "../../facet/generation-0/facet-turn-helpers.js";
import {
  completedTurn,
  derivedName,
  facetRunning,
  projectWorkspaces,
  turnFor,
  turnWithNothingServing,
} from "./project-turn-helpers.js";

/**
 * The production path from a client-supplied project id to a turn running against that project's
 * own files, across three isolates: this one asks, a second hands out the capability, and a third
 * runs the turn.
 *
 * Only the Workspace Host itself is a stand-in, and not by preference: the real `WorkspaceHost`
 * Durable Object cannot be constructed in this runtime at all, because its constructor builds a
 * `WorkspaceContainerAPI` and `@cloudflare/vitest-plugin` provides no container. The stand-in
 * reproduces the one behaviour isolation rests on — a name selects a filesystem — and nothing
 * else. Everything above it is the deployed code: the catalog resolves the id,
 * `deriveProjectWorkspaceName` derives the name, `ProjectRpcTarget` is the capability, and the
 * turn is the real Generation 0 turn running Pi's stock tools.
 */

const [projectOne, projectTwo] = PROJECT_CATALOG;

afterEach(async () => {
  await reset();
});

test("the turn writes through a capability this path obtained for the resolved project", async () => {
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([
    calls("write", { path: "notes.txt", content: "written by the turn" }),
    says("Wrote it."),
  ]);

  const frames = await completedTurn(workspaces, facet, projectOne.id);

  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    await workspaces.fileText(await derivedName(projectOne.id), "/project/notes.txt"),
    "no capability was passed in, so these bytes prove the path obtained a working one itself",
  ).toBe("written by the turn");
});

test("a turn for one project cannot read the file another project's turn wrote", async () => {
  const workspaces = await projectWorkspaces();

  const writer = await facetRunning([
    calls("write", { path: "secret.txt", content: "project one only" }),
    says("Wrote it."),
  ]);
  const wrote = await completedTurn(workspaces, writer, projectOne.id);
  expect(wrote.at(-1), "project one's write must land before project two reads").toMatchObject({
    kind: "completed",
  });

  const reader = await facetRunning([calls("read", { path: "secret.txt" }), says("Read it.")]);
  const read = await completedTurn(workspaces, reader, projectTwo.id);

  expect(
    read[0],
    "project two asked for the path project one wrote, so the read must fail",
  ).toMatchObject({ kind: "tool-result", toolName: "read", isError: true });
  expect(
    await workspaces.fileText(await derivedName(projectTwo.id), "/project/secret.txt"),
  ).toBeNull();
  expect(
    await workspaces.requestedNames(),
    "two projects must have selected two workspaces, not one shared workspace",
  ).toHaveLength(2);
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
    "a client string must not reach a workspace name, even a rejected one",
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
