const BEARER_PREFIX = "Bearer ";

export function authorizeSupervisorRequest(
  request: Request,
  configuredSecret?: string,
): boolean {
  if (configuredSecret === undefined || configuredSecret.length === 0) {
    return false;
  }
  const supplied = request.headers.get("authorization");
  if (supplied === null || supplied.length === 0) {
    return false;
  }
  return constantTimeEqual(supplied, `${BEARER_PREFIX}${configuredSecret}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
