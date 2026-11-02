export const STARTUP_CHECK_COMMAND = `scratch="$(mktemp -d)" && cd "$scratch" && printf 'startup-check-%s\\n' ran && cd / && rm -rf "$scratch"`;

export const STARTUP_CHECK_OUTPUT = "startup-check-ran";

export const STARTUP_CHECK_REPLY = "startup-check-passed";
