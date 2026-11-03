function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export async function providerTokenMatches(
  expected: string | undefined,
  presented: string | null,
): Promise<boolean> {
  if (expected === undefined || expected === "" || presented === null) return false;

  const [expectedDigest, presentedDigest] = await Promise.all([
    sha256(expected),
    sha256(presented),
  ]);

  return crypto.subtle.timingSafeEqual(expectedDigest, presentedDigest);
}
