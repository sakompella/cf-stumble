import { describeStoreConformance } from "../../src/storage/conformance.js";
import { MemoryStore } from "../../src/storage/memory.js";

describeStoreConformance("MemoryStore", () => Promise.resolve(new MemoryStore()));
