const DIGITS = /^[0-9]+$/u;

export function parseCount(text: string | undefined): number | undefined {
  if (text === undefined || !DIGITS.test(text)) return undefined;

  const value = Number(text);

  return Number.isSafeInteger(value) ? value : undefined;
}
