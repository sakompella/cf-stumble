import { parseArgs } from "node:util";
import { lifecycleFuzz } from "./lifecycle.mts";
import { withStage } from "./stage.mts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: String(Date.now() % 1_000_000) },
    minutes: { type: "string", default: "30" },
    stage: { type: "string" },
    keep: { type: "boolean", default: false },
    "ops-check": { type: "boolean", default: false },
  },
});

const passed = await withStage(
  "lifecycle",
  {
    seed: Number(values.seed),
    minutes: Number(values.minutes),
    stage: values.stage,
    keep: values.keep,
    opsCheck: values["ops-check"],
  },
  lifecycleFuzz,
);

console.error(`fuzz lifecycle: ${passed ? "PASS" : "FAIL"}`);

process.exitCode = passed ? 0 : 1;
