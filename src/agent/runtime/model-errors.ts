export type ModelSourceErrorKind = "exhausted" | "error";

export class ModelSourceError extends Error {
  readonly kind: ModelSourceErrorKind;

  constructor(kind: ModelSourceErrorKind, detail: string, cause?: unknown) {
    if (cause === undefined) {
      super(detail);
    } else {
      super(detail, { cause });
    }
    this.name = "ModelSourceError";
    this.kind = kind;
  }
}

export function modelSourceExhausted(detail: string): ModelSourceError {
  return new ModelSourceError("exhausted", detail);
}

export function isModelSourceError(error: unknown): error is ModelSourceError {
  return error instanceof ModelSourceError;
}
