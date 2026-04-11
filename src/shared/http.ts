export type RouteSet = {
  status?: number | string;
  headers?: Record<string, string> | unknown;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.length) {
    return false;
  }
  return value.every((item) => typeof item === "string" && !!item.trim());
}

export function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getErrorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const parsed = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(parsed) && parsed >= 100) {
      return parsed;
    }
  }
  return fallback;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
