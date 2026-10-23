// Edge extension points (docs/package-boundary.md#edge-extensions).
//
// A distribution entry builds extensions (reading its own environment) and
// passes them to createEdgeServer; core never imports them. Extension routes
// run only after core authentication, permission, machine-scoping and CSRF
// checks, and can never shadow a core route.
import type { BoardView } from "./board/query.ts";
import type { ProviderUsage } from "@agent-console/shared/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_CONSOLE_PERMISSIONS } from "@agent-console/shared/api";
import { matchApiRoute } from "./apiRoutes.ts";
import { matchPath } from "./http.ts";

export type EdgeRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface EdgeRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: EdgeRouteMethod;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly principal: { readonly id: string; readonly permissions: readonly string[] };
  readonly requestId: string;
  sendJson(status: number, body: unknown): void;
  readJsonBody(limitBytes?: number): Promise<unknown>;
}

export interface EdgeRoute {
  readonly id: string;
  /**
   * `matchPath` syntax under /api/; new routes should use /api/ext/<extension id>/.
   * Core scopes `:machine` to machines the principal may use and, in multi-user
   * mode, `:machine` + `:id` to sessions the principal owns, as for core routes.
   */
  readonly pattern: string;
  readonly methods: readonly EdgeRouteMethod[];
  /** A core permission or one this extension declares; multi-user principals need it. */
  readonly permission: string;
  handle(ctx: EdgeRouteContext): Promise<void> | void;
}

export interface EdgeCapabilityContext {
  readonly principal: { readonly id: string; readonly permissions: readonly string[] };
  /** Whether the principal holds a permission; single-user and open access hold every one. */
  can(permission: string): boolean;
}

export interface EdgeDecorationContext {
  readonly principal: { readonly id: string; readonly permissions: readonly string[] };
  readonly global: boolean;
  readonly multiUser: boolean;
  readonly machines: readonly string[];
  can(permission: string): boolean;
  /** Token-free ownership lookup for scoped display metadata. */
  ownerOf(machine: string, sessionId: string): string | undefined;
}

export interface EdgeExtension {
  readonly id: string;
  /** Repository roots from before explicit coordinator roles; display migration only. */
  readonly legacyCoordinatorRepositories?: readonly string[];
  /** Scoped display metadata. Core response fields win over returned metadata. */
  decorateSessions?(ctx: EdgeDecorationContext, sessions: Array<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined;
  decorateBoard?(ctx: EdgeDecorationContext, view: BoardView): Readonly<Record<string, unknown>> | undefined;
  /** Compose the in-flight usage read, then core applies host visibility scoping. */
  decorateUsage?(ctx: EdgeDecorationContext, providers: Promise<ProviderUsage[]>, refresh: boolean): Promise<ProviderUsage[]>;
  /** Principal permissions this extension introduces; principals may then be configured with them. */
  readonly permissions?: readonly string[];
  /** Declared permissions the distribution exposes in authenticated client identity. */
  readonly clientPermissions?: readonly string[];
  readonly routes?: readonly EdgeRoute[];
  /** Flags the session list's `capabilities` gains for this principal; a core flag of the same name wins. */
  sessionCapabilities?(ctx: EdgeCapabilityContext): Readonly<Record<string, unknown>> | undefined;
}

export interface RegisteredEdgeRoute extends EdgeRoute {
  /** `<extension id>:<route id>` */
  readonly key: string;
}

export interface EdgeRouteMatch {
  /** Absent when the path matches but no route on it accepts the method. */
  readonly route?: RegisteredEdgeRoute;
  readonly methodAllowed: boolean;
  readonly params: Readonly<Record<string, string>>;
}

export interface EdgeExtensionRegistry {
  readonly extensions: readonly EdgeExtension[];
  /** Permissions declared by extensions, in registration order. */
  readonly permissions: readonly string[];
  readonly routes: readonly RegisteredEdgeRoute[];
  match(path: string, method: string): EdgeRouteMatch | null;
  /** The extensions' session list capabilities, in registration order; an earlier one keeps its key. */
  sessionCapabilities(ctx: EdgeCapabilityContext): Readonly<Record<string, unknown>>;
}

const EXTENSION_ID = /^[a-z][a-z0-9-]*$/;
const ROUTE_ID = /^[a-z][a-z0-9-]*$/;
const PERMISSION = /^[a-z][a-z0-9_]*$/;
const METHODS = new Set<string>(["GET", "POST", "PUT", "DELETE"]);
const CORE_PERMISSIONS = new Set<string>(AGENT_CONSOLE_PERMISSIONS);

/** A concrete path that a pattern matches, for overlap checks. */
function samplePath(pattern: string): string {
  return pattern.split("/").map((part) => part.startsWith(":") ? "x" : part).join("/");
}

function overlaps(a: EdgeRoute, b: EdgeRoute): boolean {
  return (matchPath(a.pattern, samplePath(b.pattern)) !== null || matchPath(b.pattern, samplePath(a.pattern)) !== null)
    && a.methods.some((method) => b.methods.includes(method));
}

export function createEdgeExtensionRegistry(extensions: readonly EdgeExtension[]): EdgeExtensionRegistry {
  const ids = new Set<string>();
  const permissions: string[] = [];
  const routes: RegisteredEdgeRoute[] = [];
  for (const extension of extensions) {
    if (!EXTENSION_ID.test(extension.id)) throw new Error(`invalid edge extension id "${extension.id}"`);
    if (ids.has(extension.id)) throw new Error(`duplicate edge extension id "${extension.id}"`);
    ids.add(extension.id);
    for (const permission of extension.permissions ?? []) {
      if (!PERMISSION.test(permission)) throw new Error(`${extension.id}: invalid permission "${permission}"`);
      if (CORE_PERMISSIONS.has(permission)) throw new Error(`${extension.id}: permission "${permission}" is a core permission`);
      if (permissions.includes(permission)) throw new Error(`${extension.id}: permission "${permission}" is already declared`);
      permissions.push(permission);
    }
    const own = new Set(extension.permissions ?? []);
    for (const permission of extension.clientPermissions ?? []) {
      if (!own.has(permission)) throw new Error(`${extension.id}: undeclared client permission "${permission}"`);
    }
    const routeIds = new Set<string>();
    for (const route of extension.routes ?? []) {
      const key = `${extension.id}:${route.id}`;
      if (!ROUTE_ID.test(route.id) || routeIds.has(route.id)) throw new Error(`${key}: invalid or duplicate route id`);
      routeIds.add(route.id);
      if (!route.pattern.startsWith("/api/")) throw new Error(`${key}: pattern ${route.pattern} must start with /api/`);
      if (route.methods.length === 0 || !route.methods.every((method) => METHODS.has(method))) {
        throw new Error(`${key}: methods must be a non-empty subset of GET, POST, PUT, DELETE`);
      }
      if (typeof route.permission !== "string") throw new Error(`${key}: permission is required`);
      if (!CORE_PERMISSIONS.has(route.permission) && !own.has(route.permission)) {
        throw new Error(`${key}: undeclared permission "${route.permission}"`);
      }
      if (matchApiRoute(samplePath(route.pattern), route.methods[0]!)) {
        throw new Error(`${key}: pattern ${route.pattern} collides with core route`);
      }
      const clash = routes.find((other) => overlaps(other, route));
      if (clash) throw new Error(`${key}: pattern ${route.pattern} collides with extension route ${clash.key}`);
      routes.push(Object.freeze({ ...route, key }));
    }
  }
  return Object.freeze({
    extensions: Object.freeze([...extensions]),
    permissions: Object.freeze(permissions),
    routes: Object.freeze(routes),
    match(path: string, method: string): EdgeRouteMatch | null {
      let pathMatch: Readonly<Record<string, string>> | null = null;
      for (const route of routes) {
        const params = matchPath(route.pattern, path);
        if (!params) continue;
        if ((route.methods as readonly string[]).includes(method)) return { route, methodAllowed: true, params };
        pathMatch ??= params;
      }
      return pathMatch ? { methodAllowed: false, params: pathMatch } : null;
    },
    sessionCapabilities(ctx: EdgeCapabilityContext): Readonly<Record<string, unknown>> {
      const capabilities: Record<string, unknown> = {};
      for (const extension of extensions) {
        for (const [key, value] of Object.entries(extension.sessionCapabilities?.(ctx) ?? {})) {
          if (!Object.hasOwn(capabilities, key)) capabilities[key] = value;
        }
      }
      return capabilities;
    },
  });
}
