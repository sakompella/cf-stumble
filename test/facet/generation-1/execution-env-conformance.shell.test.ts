import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { withHostWorkspace } from "./host-workspace.js";

/**
 * A temporary directory and `/bin/sh` stand behind the real `ProjectRpcTarget`, because the suite
 * runs shell scripts (loops, redirects, `ln -s`) that the in-memory fakes cannot. `listFiles` stays
 * off: the env does not implement that optional member.
 */
registerEnvConformance({ describe, expect, it }, "Computer ExecutionEnv", withHostWorkspace);
