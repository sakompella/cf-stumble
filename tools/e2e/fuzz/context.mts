import type { Owner } from "../owner-api.mts";
import type { Target } from "../target.mts";

export type Finding = Readonly<{
  area: string;
  oracle: string;
  reproduction: string;
  detail: string;
}>;

export type FuzzContext = Readonly<{
  area: string;
  seed: number;
  deadlineMs: number;
  signal: AbortSignal;
  owner: Owner;
  password: string;
  target: Target;
  secrets: readonly string[];
  log: (line: string) => void;
}>;

export type Fuzzer = (context: FuzzContext) => Promise<readonly Finding[]>;
