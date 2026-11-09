import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { checked, commits, facet, FACET_COMPATIBILITY_METHOD } from "../helpers.js";
import { expectFailedCandidate } from "../generation-reads.js";

afterEach(async () => {
  await reset();
});

const answered = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: "message",
  model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }],
});

test("a candidate whose thrown failure carries a secret gets a report without the secret", async () => {
  const secret = "ghp_0123456789abcdef0123";

  const { control, label, result } = await checked(
    "startup-check-secret-failure",
    commits.secretFailure,
    facet(`${FACET_COMPATIBILITY_METHOD}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { throw new Error("leaked ${secret}"); }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "conversation-failed" } });

  if (!result.ok) {
    throw new Error("a labeled generation must produce a startup-check report");
  }

  expect(result.report.reason).not.toContain(secret);
  await expectFailedCandidate(control, label);
});

test("a candidate whose long reply carries a secret gets a redacted, bounded report", async () => {
  const secret = "ghp_0123456789abcdef0123";
  const reply = `${secret}${"a".repeat(600)}`;

  const view = `${JSON.stringify([
    ["r", { conversation: { id: 1 }, entries: [answered(1, reply), answered(2, reply)], docs: {} }],
  ])}\n`;

  const { control, label, result } = await checked(
    "startup-check-secret-reply",
    commits.secretReply,
    facet(`${FACET_COMPATIBILITY_METHOD}
  async attach() {}
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit() { return 1; }
  async events() { return new Response(${JSON.stringify(view)}).body; }`),
  );

  expect(result).toMatchObject({ ok: true, report: { stage: "conversation-failed" } });

  if (!result.ok) {
    throw new Error("a labeled generation must produce a startup-check report");
  }

  expect(result.report.reason).toContain("[redacted]");
  expect(result.report.reason).not.toContain(secret);
  expect(
    result.report.reason,
    "the candidate-supplied text stays within the excerpt bound",
  ).not.toContain("a".repeat(400));
  await expectFailedCandidate(control, label);
});
