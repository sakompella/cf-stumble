# Brief: fix the page defects six end-to-end surfaces found

You are a code worker for the cf-stumble v0 finishing run. The orchestrator merges; you do not.

## Where to work

```
cd /home/aditya/repos/cf-stumble
git fetch origin
git worktree add /home/aditya/wt/page-fix -b work/page-fix origin/work/harness-runner
cd /home/aditya/wt/page-fix
export CF_STUMBLE_CHROME="$(command -v chromium)"
```

Branch from `origin/work/harness-runner`, which holds the case runner and the chat surface. The
five other surface branches are `origin/work/cases-{generation,sidebar,keyboard,narrow,wide}`.
Merge all five into your branch first, resolve any conflict between their case files, and run
`timeout 900 pnpm harness:browser > /tmp/harness-all.log 2>&1` to get the full picture before you
change anything.

## Read first

1. `tools/browser-harness/CASES.md`, the case contract.
2. `/home/aditya/repos/cf-stumble/.audit/v0/web-test-cases.md`, the merged case list.
3. `~/.agents/skills/poteto-mode/SKILL.md`. Work in that style.

## The findings, from five independent agents

Product defects to fix:

1. **A collapsed sidebar hides its own restore control.** Four surfaces found this independently
   (WID-2, SIDE-6, NAR-2, KEY-4). `src/page/styles.ts:30` applies `display: none` to
   `#project-sidebar` when collapsed, and the only toggle lives inside it
   (`src/page/markup-sidebar.ts:21`). After Hide there is no visible or keyboard-reachable way
   back. Fix the page so the control that collapsed the sidebar can restore it, by keyboard as well
   as by mouse. Decide the smallest shape yourself; state what you chose and why.
2. **An empty project list leaves the conversation blank** (SIDE-4). `src/page/script-projects.ts`
   returns early for an empty list without setting the conversation state, so a new owner with no
   connected project sees nothing at all. It must say to select a project first, as the case list
   requires.
3. **The generation drawer's contents measure visible while it is closed** (GEN-1).
   `src/page/markup-drawer.ts:65-86` and `src/page/styles.ts:53-54`. Find out whether the panel is
   really outside the `<details>` element or whether the case measured the wrong thing, then fix
   whichever is wrong. Say which it was.
4. **A fractional generation label is accepted** (GEN-9). `src/page/script-generations.ts:96-98`
   parses `1.5` into label 1 with `Number.parseInt` and sends a control command. It must be
   refused locally.

Two failing cases are wrong about the product, not the other way round. Correct the cases and say
so in your report:

5. **SIDE-1** expects the sidebar to say "2 connected" for a list of one repository plus the
   harness. The harness is not a connection: it needs no repository, no credential and no clone.
   The product is right. Fix the case to assert what the count means.
6. **WID-1** asserts a sidebar width of 288 pixels plus or minus 2, and the page renders 314 with
   its padding and borders. That is an implementation detail, not a behavior. Rewrite the case to
   assert what a wide viewport must actually give the user.

One failing case is a harness limitation:

7. **KEY-2** uses `page.press("Space")` to close the generation drawer, and the CDP key the harness
   sends does not toggle a native `<details>` summary. Fix the harness key handling so a real
   Space keypress reaches the page, then let the case stand. `tools/browser-harness/chrome.mts:24`
   is where the key is built. If a real browser genuinely does not toggle `details` on Space for
   this markup, say so with evidence and rewrite the case instead.

## Rules

- Fix the page, not the case, for items 1 to 4. Fix the case, not the page, for items 5 and 6.
- Do not restyle the page beyond what a fix needs. Do not add features.
- Every fix needs a test that would have caught it. The web cases are the natural home for the
  first three; item 4 belongs in the page's own unit tests too.
- Wrap every long command in `timeout` and redirect output to a file.

## The gate

`pnpm verify` green before every commit (the pre-commit hook runs it), then
`timeout 900 pnpm harness:browser > /tmp/harness-page-fix.log 2>&1`, which must end with every
case passing or with a stated, evidenced reason a case cannot pass. Push with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=store git push -u origin work/page-fix`.

## Report

Reply to your parent (`await agent_message.send(..., receiver_role='parent')`) under 450 words: the
branch and SHA, the final harness summary line, one line per finding with what you changed and why,
what the drawer defect turned out to be, and anything still failing with its evidence.
