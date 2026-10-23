/**
 * Role presentation catalog owned by the coordinator (`roles/catalog.json`) and carried in
 * the board membership file. Icons are static 24x24 geometry: a fixed element
 * and attribute allowlist, never markup, so no catalog value can run or fetch.
 */
export const ROLE_CATALOG_SCHEMA = "agent-console.role-catalog.v1";

const ICON_TAGS = new Set(["path", "circle", "rect", "polygon"]);
const ICON_ATTRIBUTES = new Set([
  "d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "points", "fill", "stroke", "stroke-width", "transform",
]);
// Geometry, numbers, colors and `var(--token, #hex)` only; no quotes, escapes or resource references.
const ICON_VALUE = /^[-\w\s.,#%()]{1,512}$/;
const ROLE_ID = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?$/;

export type RoleIconElement = { readonly tag: string } & Readonly<Record<string, string>>;

export interface RoleCatalogEntry {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly name: { readonly zh: string; readonly en: string };
  readonly icon: readonly RoleIconElement[];
}

export interface RoleCatalog {
  readonly schema_version: typeof ROLE_CATALOG_SCHEMA;
  readonly roles: readonly RoleCatalogEntry[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

function roleId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && ROLE_ID.test(value) ? value : undefined;
}

function iconElement(value: unknown): RoleIconElement | undefined {
  const raw = record(value);
  if (!raw || typeof raw.tag !== "string" || !ICON_TAGS.has(raw.tag)) return undefined;
  const element: Record<string, string> = { tag: raw.tag };
  for (const [key, attribute] of Object.entries(raw)) {
    if (key === "tag") continue;
    if (!ICON_ATTRIBUTES.has(key) || typeof attribute !== "string" || !ICON_VALUE.test(attribute) || /url\s*\(/i.test(attribute)) {
      return undefined;
    }
    element[key] = attribute;
  }
  return element as RoleIconElement;
}

function entry(value: unknown): RoleCatalogEntry | undefined {
  const raw = record(value);
  const id = roleId(raw?.id);
  const name = record(raw?.name);
  const zh = label(name?.zh);
  const en = label(name?.en);
  const aliases = Array.isArray(raw?.aliases) && raw.aliases.length <= 8 ? raw.aliases.map(roleId) : undefined;
  const icon = Array.isArray(raw?.icon) && raw.icon.length > 0 && raw.icon.length <= 24 ? raw.icon.map(iconElement) : undefined;
  if (!id || !zh || !en || !aliases || aliases.some(alias => !alias) || !icon || icon.some(element => !element)) return undefined;
  return { id, aliases: aliases as string[], name: { zh, en }, icon: icon as RoleIconElement[] };
}

/** Invalid entries are dropped one by one; an unknown schema or shape drops the catalog. */
export function normalizeRoleCatalog(value: unknown): RoleCatalog | undefined {
  const raw = record(value);
  if (raw?.schema_version !== ROLE_CATALOG_SCHEMA || !Array.isArray(raw.roles) || raw.roles.length > 64) return undefined;
  return { schema_version: ROLE_CATALOG_SCHEMA, roles: raw.roles.flatMap(role => entry(role) ?? []) };
}
