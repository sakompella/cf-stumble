import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  canonicalRepositoryUrl,
  defaultProjectDisplayName,
  PROJECT_ID_LIMIT,
  projectIdForRepository,
  resolveProject,
  type Project,
} from "../src/project-catalog.js";
import { projectOf } from "./project-fixtures.js";

const owner = gs.fromRegex("[a-z0-9][a-z0-9-]{0,10}");

const repository = gs.fromRegex("[a-z0-9][a-z0-9._-]{0,10}");

const breakages: readonly ((base: string) => string)[] = [
  (base) => base.replace("https:", "http:"),
  (base) => base.replace("https:", "ftp:"),
  (base) => base.replace("https:", "git:"),
  (base) => base.replace("//", "//someone@"),
  (base) => base.replace("//", "//someone:secret@"),
  (base) => base.replace("//", "//:secret@"),
  (base) => `${base}?ref=main`,
  (base) => `${base}#readme`,
  (base) => base.replace("https://", ""),
  (base) => base.slice(0, base.lastIndexOf("/")),
  (base) => `${base.slice(0, base.lastIndexOf("/"))}/`,
  (base) => `${base.slice(0, base.lastIndexOf("/"))}/.git`,
  () => "",
  () => "   ",
  () => "https://",
  () => "https://github.com",
];

test("a URL that is not an https repository URL without credentials is refused", () => {
  hegel.test((tc) => {
    const base = `https://github.com/${tc.draw(owner)}/${tc.draw(repository)}`;
    const broken = tc.draw(gs.sampledFrom(breakages))(base);

    expect(canonicalRepositoryUrl(broken)).toBeUndefined();
    expect(projectIdForRepository(broken)).toBeUndefined();
  });
});

test("canonicalising any text never throws and settles after one pass", () => {
  hegel.test((tc) => {
    const text = tc.draw(gs.oneOf(gs.text({ maxSize: 40 }), gs.urls()));
    const canonical = canonicalRepositoryUrl(text);

    if (canonical === undefined) {
      expect(projectIdForRepository(text)).toBeUndefined();

      return;
    }

    expect(canonical.startsWith("https://")).toBe(true);
    expect(canonicalRepositoryUrl(canonical)).toBe(canonical);
    expect(projectIdForRepository(canonical)).toBe(projectIdForRepository(text));
  });
});

const elsewhere = [
  "www.github.com",
  "api.github.com",
  "gitlab.com",
  "github.com.example.com",
  "github.com.",
  "github.com:8443",
  "github.com:80",
];

test("only a repository on github.com itself gets an id", () => {
  hegel.test((tc) => {
    const url = `https://${tc.draw(gs.sampledFrom(elsewhere))}/${tc.draw(owner)}/${tc.draw(repository)}`;

    expect(projectIdForRepository(url)).toBeUndefined();
  });
});

const strange = ["~", "+", "!", "@", "é", "|", "%2F", "%41", ":"];

function insertAt(text: string, position: number, piece: string): string {
  return `${text.slice(0, position)}${piece}${text.slice(position)}`;
}

test("an owner or repository name with a character GitHub does not allow gets no id", () => {
  hegel.test((tc) => {
    const ownerName = tc.draw(owner);
    const name = tc.draw(repository);
    const piece = tc.draw(gs.sampledFrom(strange));
    const inOwner = tc.draw(gs.booleans());
    const target = inOwner ? ownerName : name;
    const position = tc.draw(gs.integers({ minValue: 0, maxValue: target.length }));
    const spoiled = insertAt(target, position, piece);

    const url = `https://github.com/${inOwner ? spoiled : ownerName}/${inOwner ? name : spoiled}`;

    expect(projectIdForRepository(url)).toBeUndefined();
  });
});

test("an owner of 40 characters or a name of 101 gets no id, one character less does", () => {
  hegel.test((tc) => {
    const ownerLength = tc.draw(gs.integers({ minValue: 1, maxValue: 45 }));
    const nameLength = tc.draw(gs.integers({ minValue: 1, maxValue: 110 }));
    const url = `https://github.com/${"o".repeat(ownerLength)}/${"r".repeat(nameLength)}`;

    expect(projectIdForRepository(url) !== undefined).toBe(ownerLength <= 39 && nameLength <= 100);
  });
});

test("a path deeper than owner and repository gets no id", () => {
  hegel.test((tc) => {
    const extra = tc.draw(gs.arrays(repository, { minSize: 1, maxSize: 3 }));
    const url = `https://github.com/${tc.draw(owner)}/${tc.draw(repository)}/${extra.join("/")}`;

    expect(projectIdForRepository(url)).toBeUndefined();
  });
});

const connectable = gs.arrays(gs.tuples(owner, repository), { minSize: 1, maxSize: 5 });

function projectsOf(pairs: readonly (readonly [string, string])[]): readonly Project[] {
  const byId = new Map(
    pairs
      .flatMap(([ownerName, name]) => {
        const url = `https://github.com/${ownerName}/${name}`;

        return projectIdForRepository(url) === undefined ? [] : [projectOf(url)];
      })
      .map((project) => [project.id, project]),
  );

  return [...byId.values()];
}

test("a project of the catalog resolves to itself and any other valid id is unknown", () => {
  hegel.test((tc) => {
    const catalog = projectsOf(tc.draw(connectable));
    const stranger = projectsOf([[tc.draw(owner), tc.draw(repository)]]).at(0);

    for (const project of catalog) {
      expect(resolveProject(project.id, catalog)).toEqual({ ok: true, project });
    }

    if (stranger !== undefined && !catalog.some((project) => project.id === stranger.id)) {
      expect(resolveProject(stranger.id, catalog)).toEqual({
        ok: false,
        reason: "unknown-project-id",
      });
    }

    expect(resolveProject("a".repeat(PROJECT_ID_LIMIT), catalog)).toEqual({
      ok: false,
      reason: "unknown-project-id",
    });
  });
});

const corruptions: readonly ((id: string) => string)[] = [
  (id) => `${id}-`,
  (id) => `-${id}`,
  (id) => `${id}--`,
  (id) => `${id}X`,
  (id) => `${id}_`,
  (id) => `${id}.`,
  (id) => `${id}/`,
  (id) => `${id} `,
  (id) => `${id}\n`,
  (id) => `${id}é`,
  (id) => `${id}--0d`,
  (id) => `${id}--1`,
  () => "",
  () => "a".repeat(PROJECT_ID_LIMIT + 1),
];

test("a string that is no project id is refused as invalid, never looked up", () => {
  hegel.test((tc) => {
    const catalog = projectsOf(tc.draw(connectable));
    const known = catalog[0]?.id ?? "x";
    const corrupted = tc.draw(gs.sampledFrom(corruptions))(known);

    expect(resolveProject(corrupted, catalog)).toEqual({
      ok: false,
      reason: "invalid-project-id",
    });
  });
});

test("a project is shown as the last two segments of its repository path", () => {
  hegel.test((tc) => {
    const segments = tc.draw(gs.arrays(owner, { minSize: 2, maxSize: 4 }));
    const url = canonicalRepositoryUrl(`https://example.com/${segments.join("/")}`);

    if (url === undefined) throw new Error("two segments under https must canonicalise");

    expect(defaultProjectDisplayName(url)).toBe(segments.slice(-2).join("/"));
  });
});
