import type { DomainErrorCode } from "../../shared/types.ts";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: unknown;

  constructor(code: DomainErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function domainError(code: DomainErrorCode, message: string, details?: unknown): never {
  throw new DomainError(code, message, details ?? null);
}
