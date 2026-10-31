export function hasErrnoCode(value: unknown): value is { code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  );
}
