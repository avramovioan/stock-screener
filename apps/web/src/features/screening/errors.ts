export type ApiErrorKind = "network" | "rls_denied" | "rate_limited" | "server";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface RawFailure {
  status: number;
  code?: string | undefined;
  message: string;
}

export function toApiError(f: RawFailure): ApiError {
  if (f.status === 0) return new ApiError("network", f.message, 0);
  if (f.status === 429) return new ApiError("rate_limited", f.message, 429);
  if (f.status === 401 || f.status === 403 || f.code === "42501") {
    return new ApiError("rls_denied", f.message, f.status);
  }
  return new ApiError("server", f.message, f.status);
}

export function describeApiError(kind: ApiErrorKind): string {
  switch (kind) {
    case "network":
      return "Check your connection and try again.";
    case "rate_limited":
      return "Too many requests. Wait a minute and try again.";
    case "rls_denied":
      return "You are not allowed to read this data.";
    default:
      return "Something went wrong while loading this data.";
  }
}

/** Message for any thrown value, for ErrorState. */
export function errorText(e: unknown): string {
  return describeApiError(e instanceof ApiError ? e.kind : "server");
}
