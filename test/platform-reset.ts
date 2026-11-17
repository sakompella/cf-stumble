export function platformReset(message: string): Error {
  return Object.assign(new Error(message), { retryable: true });
}

export const CODE_UPDATE_RESET = platformReset(
  "Durable Object reset because its code was updated.",
);

export const STORAGE_RESET = platformReset(
  "Internal error in Durable Object storage caused object to be reset; reference = abc",
);
