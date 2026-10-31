import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { withHostWorkspace } from "./host-workspace.js";

registerEnvConformance({ describe, expect, it }, "Computer ExecutionEnv", withHostWorkspace);
