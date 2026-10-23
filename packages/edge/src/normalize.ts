export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asPercent(value: unknown): number | null {
  const number = asFiniteNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

export function asNonNegativeInt(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : asFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

export function objectProp(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function arrayProp(value: unknown, key: string): unknown[] {
  const object = objectProp(value);
  const prop = object?.[key];
  return Array.isArray(prop) ? prop : [];
}
