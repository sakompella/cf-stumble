# Prior art

Findings from surveying what already exists, after a reasonable suspicion that both of this
project's central choices were reinventing wheels. Two of them were, and the survey changed two
decisions and corrected three claims.

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
the three originally given in D1. Every mature implementation of this idea separates format from
storage exactly as we do; the only JS one is abandoned; the maintained alternatives either hard-code
a filesystem layout or are in another language.

One real escape hatch was found: direct `isomorphic-git` plus a transient `FsClient` and
`readObject({ format: "wrapped" })` can extract exact object bytes for our store. That would remove
the codec while keeping the invariant, at the cost of retaining a filesystem shim and zlib. Worth
knowing; not obviously worth doing.

## Nix: three places we diverge, now deliberately

Read from Nix source rather than documentation, and it corrects claims made in
`docs/generations.md`:

- **Nix skips creating a generation when the output path is unchanged.** We always allocate,
  because our unit is the _attempt_ rather than the _result_ — re-attempting an identical commit is
  a meaningful event when the thing being attempted is a facet load that might fail transiently.
  A deliberate divergence, not an oversight.
- **Nix generation numbers can be reused** after pruning the highest generation. Ours never are.
  Ours is the stronger guarantee and we keep it, since attempt records are evidence.
- **A failed Nix _build_ creates no generation; a failed _activation_ consumes one**, because
  `nix-env --set` switches the profile before `switch-to-configuration` runs. Our "allocate the
  number and write the row before invoking the loader" matches the activation case, which is the
  case we are actually modelling. Good news: the model was right for the right reason.

libostree's `deployserial` turned out **not** to be a global attempt counter — it is only unique per
repeated deployment of one commit. Its useful ideas are retention controls (`--retain-pending`,
`--retain-rollback`, pinning) and the atomic swap between two boot directories.

## Self-modifying agents: the Darwin Gödel Machine

The closest complete system is the **Darwin Gödel Machine**
([paper](https://arxiv.org/abs/2505.22954), [code](https://github.com/jennyzzt/dgm)): an archive of
self-modified agent variants with parent lineage, each run in Docker under time limits, evaluated by
fresh benchmark execution.

Three things it learned that we had not:

1. **Cheap gates before expensive evaluation.** DGM rejects a candidate that fails to compile _or
   that has lost its ability to edit code_, before spending anything on benchmarks. A candidate
   that can no longer use its own `edit` primitive is a dead end regardless of its score. We had no
   such gate; this became the preflight slice.
2. **Keep weaker branches; parent selection is not greedy.** Later improvements can emerge from
   candidates that scored badly. Our model prunes nothing, so we are accidentally fine here, but it
   is a reason not to add aggressive pruning later.
3. **Optimising one benchmark amplifies brittle and unsafe behaviour**, so safety checks belong as a
   _separate objective_ rather than as part of the score. Our ratchet is score-shaped by nature, so
   preflight is deliberately a hard capability floor rather than something to maximise.

DGM also independently confirms the replay problem we hit: a recorded response tape can validate
protocol behaviour but cannot validate a _prompt_ change. Its answer is fresh execution with
repeated samples on held-out tasks, which is the mechanism we have explicitly deferred.
