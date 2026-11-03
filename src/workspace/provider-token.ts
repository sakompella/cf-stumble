const TOKEN_KEY = "orb:provider-token-sha256";

const TOKEN_BYTES = 32;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return hex(new Uint8Array(digest));
}

export async function mintProviderToken(storage: DurableObjectStorage): Promise<string> {
  const token = hex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await storage.put(TOKEN_KEY, await sha256(token));

  return token;
}

export async function providerTokenMatches(
  storage: DurableObjectStorage,
  presented: string | null,
): Promise<boolean> {
  if (presented === null) return false;

  const stored = await storage.get<string>(TOKEN_KEY);

  return stored !== undefined && stored === (await sha256(presented));
}
