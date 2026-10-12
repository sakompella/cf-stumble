import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import {
  savedTranscript,
  textEntry,
  withToolResult,
  type TranscriptEntry,
} from "../../../src/page/client/transcript.js";

/**
 * The saved reader against the rule a running turn applies one frame at a time: a tool result
 * finishes the latest block with its id, or opens one at the end. Ids come from a small pool, so
 * repeats, orphans, and interleaving happen often.
 */

type Drawn =
  | Readonly<{ kind: "text"; role: string; content: string }>
  | Readonly<{ kind: "tool"; toolCallId: string; toolName: string; isError: boolean }>
  | Readonly<{ kind: "invalid"; json: string }>;

const ROLES = ["user", "assistant", "custom", "system"] as const;

const INVALID = ["null", "7", "{}", '"text"', '{"role":3}'] as const;

function drawMessage(tc: hegel.TestCase): Drawn {
  const kind = tc.draw(gs.sampledFrom(["text", "tool", "invalid"] as const));

  if (kind === "text") {
    return {
      kind,
      role: tc.draw(gs.sampledFrom(ROLES)),
      content: tc.draw(gs.text({ maxSize: 4 })),
    };
  }

  if (kind === "tool") {
    return {
      kind,
      toolCallId: tc.draw(gs.sampledFrom(["a", "b", "c", ""])),
      toolName: tc.draw(gs.sampledFrom(["read", "write"])),
      isError: tc.draw(gs.booleans()),
    };
  }

  return { kind, json: tc.draw(gs.sampledFrom(INVALID)) };
}

function stored(message: Drawn): string {
  if (message.kind === "invalid") return message.json;

  if (message.kind === "text")
    return JSON.stringify({ role: message.role, content: message.content });

  const { toolCallId, toolName, isError } = message;

  return JSON.stringify({ role: "toolResult", toolCallId, toolName, isError, content: "out" });
}

const WHO: Readonly<Record<(typeof ROLES)[number], readonly [string, string]>> = {
  user: ["user", "you"],
  assistant: ["assistant", "assistant"],
  custom: ["system", "custom"],
  system: ["system", "system"],
};

function oneAtATime(messages: readonly Drawn[]): readonly TranscriptEntry[] {
  let transcript: readonly TranscriptEntry[] = [];

  for (const message of messages) {
    if (message.kind === "text") {
      const role = ROLES.find((known) => known === message.role) ?? "system";
      const [entryRole, who] = WHO[role];
      transcript = [...transcript, textEntry(entryRole, who, message.content)];
    } else if (message.kind === "tool") {
      const { toolCallId, toolName, isError } = message;
      const result = { toolCallId, toolName, isError, content: "out", isTruncated: false };
      transcript = withToolResult(transcript, result);
    }
  }

  return transcript;
}

test("a saved conversation reads as its results applied one at a time", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 24 }));
      const messages = Array.from({ length: count }, () => drawMessage(tc));
      const saved = `[${messages.map(stored).join(",")}]`;

      expect(Option.getOrThrow(savedTranscript(saved))).toStrictEqual(oneAtATime(messages));
    },
    { testCases: 300 },
  );
});
