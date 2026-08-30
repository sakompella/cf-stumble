export type Deadline = {
  readonly elapsed: Promise<"elapsed">;
  readonly cancel: () => void;
};

export function deadlineAfter(durationMs: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<"elapsed">((resolve) => {
    timer = setTimeout(() => {
      resolve("elapsed");
    }, durationMs);
  });

  return {
    elapsed,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}
