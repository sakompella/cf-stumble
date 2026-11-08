export const STARTUP_CHECK_MESSAGE = "Run the startup check.";

export const STARTUP_CHECK_RESUMED_MESSAGE = "Run the startup check on the resumed conversation.";

export const STARTUP_CHECK_COMMAND = `scratch="$(mktemp -d)" && cd "$scratch" && printf 'startup-check-%s\\n' ran && cd / && rm -rf "$scratch"`;

export const STARTUP_CHECK_OUTPUT = "startup-check-ran";

export const STARTUP_CHECK_ISOLATE_COMMAND = "echo startup-check-isolate";

export const STARTUP_CHECK_CONTAINER_COMMAND = "node --version";

export const STARTUP_CHECK_REPLY = "startup-check-passed";

export function startupCheckStep(toolCallId: string): string {
  return toolCallId.split(":")[0] ?? toolCallId;
}
