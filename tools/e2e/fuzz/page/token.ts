const TOKEN = /fz\d+-[0-9a-z]+-\d+/u;

export function tokenIn(text: string): string {
  return TOKEN.exec(text)?.[0] ?? "";
}
