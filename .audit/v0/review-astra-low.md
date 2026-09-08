# Astra review of the v0 repair plan

Based on the supplied reviews of `7818f8d` and the hp brief. This is a review of their evidence, not a fresh code audit or verification run.

## 1. Are these the right next six moves?

Yes. Merge the reviewed renderer, then fix turn lifetime and credit before treating any successful demo as meaningful evidence; the remaining three proof repairs are appropriate. Add a parallel, local run of the pinned x64 Computer image now that hp can run it, measuring tool availability and two clean builds through the real adapter where possible, without paid services or unauthorized GitHub access. Keep the consolidated plan's steps 7 and 8 explicit after the hp brief's six: revise Q7 using those results, then schedule T11 only after its dependencies; local container success does not prove Cloudflare deployment behavior. Land and run the browser harness rather than treating removal of its advertised command as completion, and include the missing saved-compaction-to-replacement-generation test before release.

## 2. Is the turn lifetime repair deep enough?

The proposed ownership is correct, but propagated cancellation is only a request until the execution boundary enforces it. One admitted turn should own its absolute deadline and immutable generation/preparation snapshot, and replacement admission must not allow an old command or late start to keep writing. Require termination of in-flight commands and rejection of further tool dispatch under the superseded lease; if the runtime cannot establish that, block replacement or isolate its writable state rather than assuming an abort signal stopped it. This needs a deeper workspace execution contract if that contract is absent, not a new scheduler or a Supervisor rewrite; test a delayed start and an already-running writer, including lease expiry without cooperative cleanup.

## 3. Is the repeated false diff proof a testing or design problem?

Both, with an immediate testing-discipline failure: importing the production command as the fake's oracle recreates the precise defect the task was meant to remove. Use the production execution path against a temporary Git repository and require the `cat` mutation to fail, while retaining useful framing and policy tests. The design also lacks a settled meaning for "the turn's diff": `git diff HEAD` omits untracked files, includes earlier dirt, and can hide edits committed during the turn. Define the baseline and file coverage first, then bind those cases with real Git; killing one mutation alone does not establish that contract.

## 4. Should v0 shrink?

Keep the functional criteria. Owner isolation, real coding, saved conversation, safe replacement, reproducible generation switching, and restart persistence are the product's minimum promise, not optional polish made expendable by a large test count. Q7 is an authorization blocker, not evidence that those requirements are excessive, and known-good policy expansion remains outside v0 even though false attribution must be fixed. The only sensible separation is public publication from criterion 10: propose a privately retained recording as technical completion, with publication still explicitly blocked on Q5 and any scope change left to the owner.

The highest-leverage action is to prove at the workspace execution boundary that a superseded turn cannot write after its replacement is admitted, then make that invariant govern the lifetime repair.
