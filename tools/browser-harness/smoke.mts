import { runHarness } from "./run.mjs";

/**
 * The fast plumbing check: the smoke case only, through the same runner.
 *
 * It exists as its own entrypoint because it is the thing to run when the question is whether the
 * harness itself works — a missing Chromium, a stub that will not start, a page that no longer
 * loads — rather than whether the page behaves.
 */
process.exitCode = await runHarness(["--only", "SMOKE"]);
