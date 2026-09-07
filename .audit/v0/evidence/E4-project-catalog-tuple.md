# E4 — The project catalog is a fixed two-tuple TYPE, not just placeholder data

Status: CONFIRMED by the root agent. Blocks goal criterion 3.
Sharpens architecture-critique finding 5 and roadmap task T6.

`src/project-catalog.ts`:

```ts
export type ProjectCatalog = readonly [Project, Project];
```

The catalog is a fixed-arity tuple in the TYPE SYSTEM. Its data is two frozen
placeholders pointing at `https://example.invalid/placeholder/project-{one,two}.git`.

## Why this is bigger than swapping the data

Goal criterion 3 requires "at least two GitHub repositories ... connected through
authorization separate from Access". A two-tuple cannot hold three projects, and no
runtime connect flow can append to it. T6 must change the type to a variable-length
collection and follow it through every consumer, not edit a constant.

`ProjectCatalog` appears 17 times across 5 files:
`src/project-catalog.ts`, `src/workspace-names.ts`, `src/workspace/project-provision.ts`,
`src/supervisor/threads/project-threads.ts`, `test/project-catalog.test.ts`.

`resolveProject` is the single choke point every consumer already goes through, so the
seam exists. The arity is the thing that has to move.

## Interaction with E3

`deriveProjectWorkspaceName` takes a `Project` and hashes `project.id` into the
container name (E3). T6 adds real projects; T3 removes the per-project container.
If T6 lands first, connecting a third repository creates a third container. Order T3
before or with T6, or T6 must not be judged on workspace behaviour.
