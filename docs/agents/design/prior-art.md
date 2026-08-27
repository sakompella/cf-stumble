# Prior art

This survey asked whether the project had rebuilt existing work. It had in two places. The results
changed two decisions and corrected three claims.

## The git object store: js-git already did exactly this

**`js-git`** implements our precise invariant: `sha1(codec.frame(object))`, storing the
uncompressed framed bytes directly, behind duck-typed `saveAs` / `loadAs` / `loadRaw` / `saveRaw`
storage. That is the same separation of _object format_ from _object storage_ that our four-function
store exists to provide.

It was last published in 2017 and is effectively dead, so it is prior art rather than a
dependency. But it settles the design question: the shape is right and known-good, and no
maintained JavaScript package offers it.

The wider survey, from reading source rather than READMEs:

| Library                           | Alive     | Format separated from storage                        | Verdict                          |
| --------------------------------- | --------- | ---------------------------------------------------- | -------------------------------- |
| `js-git`                          | No (2017) | Yes — exactly our invariant                          | Validates the design; unusable   |
| `isomorphic-git`                  | Yes       | Partial — loose-object zlib layout is hard-coded     | Breaks the invariant             |
| `go-git`                          | Yes       | Yes — `EncodedObjectStorer`                          | Right shape, wrong language      |
| `gix` (Rust)                      | Yes       | Yes — `gix-object` format vs `gix-odb` storage       | Could replace the codec via WASM |
| `dulwich` (Python)                | Yes       | Yes — `ObjectStore`                                  | Strong prior art, wrong language |
| Irmin (OCaml)                     | Yes       | Yes — `Content_addressable.S`, atomic `test_and_set` | Best design prior art            |
| `wasm-git`, `nodegit`, Dolt, Noms | —         | —                                                    | Dead ends for this purpose       |

**This is what finally justifies the hand-written codec**, and it is a better argument than any of
the three originally given for it. Every mature implementation of this idea separates format from
storage exactly as we do; the only JS one is abandoned; the maintained alternatives either hard-code
a filesystem layout or are in another language.

One real escape hatch was found: direct `isomorphic-git` plus a transient `FsClient` and
`readObject({ format: "wrapped" })` can extract exact object bytes for our store. That would remove
the codec while keeping the invariant, at the cost of retaining a filesystem shim and zlib. Worth
knowing; not obviously worth doing.

## Nix: three deliberate differences

Read from Nix source rather than documentation, and it corrects claims made in
`docs/agents/design/generations.md`:

- **Nix skips creating a generation when the output path is unchanged.** We always allocate,
  because our unit is the _attempt_, not the _result_. Re-attempting an identical commit records a
  meaningful event when a facet load can fail transiently. This difference is intentional.
- **Nix generation numbers can be reused** after pruning the highest generation. Ours never are.
  Ours is the stronger guarantee and we keep it, since attempt records are evidence.
- **A failed Nix _build_ creates no generation; a failed _activation_ consumes one**, because
  `nix-env --set` switches the profile before `switch-to-configuration` runs. Our "allocate the
  number and write the row before invoking the loader" matches the activation case, which is the
  case we are actually modelling. Good news: the model was right for the right reason.

libostree's `deployserial` turned out **not** to be a global attempt counter — it is only unique per
repeated deployment of one commit. Its useful ideas are retention controls (`--retain-pending`,
`--retain-rollback`, pinning) and the atomic swap between two boot directories.

## Autolith: the primary inspiration for the facet/supervisor split

**[Autolith](https://github.com/lambda-symbolics/autolith)** is the project this architecture is
modelled on, not a dependency of it. It draws the same line we draw, between an active image that
is meant to change and a small stable authority that is not:

- The **active image** contains the terminal, agent, tools, and state, and is broadly mutable.
  Autolith keeps application definitions in one package so the running system can rewrite itself.
  It does not keep the active image small.
- The **stable launcher** and **pristine recovery image** remain separate from the active image
  and from each other. The launcher boots the system and can fall back. The recovery image is the
  untouched last-known-good state, closer to generation 0 than to ordinary agent work.
- `self.*` installs _complete_ definitions, not incremental patches — the same reason our
  generations are whole materializations rather than diffs applied to a running facet.

Autolith's `AGENTS.md` names the stable launcher, mutable active agent, its workers, and the
pristine recovery path separately. It reserves a small operation set for _durable self-mutation_,
the actions that change what boots next. Ordinary workspace tools and the active image's tool
registry remain broad and extensible. Cf-stumble borrows that shape: a small auditable recovery and
promotion mechanism, with a facet loop, tools, prompts, skills, and policies that may grow (see
ADR-0024). Autolith does not limit the active agent to a handful of primitives. This project did
so after mistaking a derivative prompt for the product; see
`docs/agents/design/decision-provenance.md`.

## Self-modifying agents: the Darwin Gödel Machine

The closest complete system is the **Darwin Gödel Machine**
([paper](https://arxiv.org/abs/2505.22954), [code](https://github.com/jennyzzt/dgm)): an archive of
self-modified agent variants with parent lineage, each run in Docker under time limits, evaluated by
fresh benchmark execution.

Three things it learned that we had not:

1. **Cheap gates before expensive evaluation.** DGM rejects a candidate that fails to compile or
   has lost its ability to modify itself before spending anything on benchmarks. The general lesson
   is to test candidate viability and successor production before expensive evaluation; the current
   bootstrap preflight expresses that through its existing tool protocol.
2. **Keep weaker branches; parent selection is not greedy.** Later improvements can emerge from
   candidates that scored badly. Our model prunes nothing, so we are accidentally fine here, but it
   is a reason not to add aggressive pruning later.
3. **Optimising one benchmark amplifies brittle and unsafe behaviour**, so safety checks belong as a
   _separate objective_ rather than part of the score. The ratchet has a score-shaped form, so
   preflight sets a hard capability floor rather than something to maximise.

DGM also independently confirms the replay problem we hit: a recorded response tape can validate
protocol behaviour but cannot validate a _prompt_ change. Its answer is fresh execution with
repeated samples on held-out tasks, which is the mechanism we have explicitly deferred.

## The isomorphic-git comparison prototype

A throwaway spike comparing our hand-written codec against isomorphic-git is parked, unmerged, on
the branch `prototype/isogit-comparison`. It is recorded here so it stays findable rather than
being lost with the branch.

It established that the two produce **byte-identical objects** given identical inputs — trees
matched immediately, and commits matched once a trailing-newline convention was aligned, which
turned out to be a real if minor bug in ours. It also measured that isomorphic-git's stored bytes
are zlib-compressed at path keys, so `sha1(stored) != oid`, and corrected an earlier finding of
mine: counting _calls_ suggested four filesystem methods sufficed, but isomorphic-git _binds_ all
ten when it constructs its wrapper, so a four-method shim fails before anything runs.

Its verdict — keep the codec — has since been overtaken by the decision to adopt
`@cloudflare/computer` and stop home-rolling. The measurements remain valid.
