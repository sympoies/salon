// UI extension points (docs/package-boundary.md#ui-extensions).
//
// A distribution entry passes extensions to `mountApp`; core never imports
// them. Core remains usable without extensions; badge slots show a plain
// role label when the session supplies one.
import { createContext, Fragment, useContext, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { normalizeSessionWorkspace, type SessionCoordinatorTree, type SessionDispatchedBy, type ProviderUsage } from "@agent-console/shared/api";
import type { FilterRecord, SessionScopeModel } from "./sessionFilters.ts";
import type { Session } from "./types.ts";
import type { SessionRole } from "@agent-console/shared/lineage";
import { createMachineColorMap, normalizeMachineColor } from "./machineColors.ts";

export {
  useSessionRefresh,
  type SessionRefreshOutcome,
  type SessionRefreshState,
  type SessionRefreshTarget,
} from "./useSessionRefresh.ts";

const EXTENSION_ID = /^[a-z][a-z0-9-]*$/;

/** Where a session badge is drawn. */
export type SessionBadgeSurface = "card" | "mobile-card" | "history";

/** The session facts a badge may read: a live session or a history row's marker item. */
export interface SessionBadgeItem {
  /** Present on live sessions; with `machine` it addresses `useSessionRefresh`. */
  readonly id?: string;
  readonly machine?: string;
  readonly role?: SessionRole | null;
  readonly dispatched_by?: SessionDispatchedBy;
  readonly coordinator_tree?: SessionCoordinatorTree;
  readonly created_at?: string;
}

export interface SessionBadgeNavigation {
  readonly session?: { readonly machine: string; readonly id: string };
  readonly scope?: string;
}
export interface SessionBadgeContext {
  readonly surface: SessionBadgeSurface;
  /** Core's lineage navigation for this session, when the surface offers one. */
  readonly onLineage?: (navigation?: SessionBadgeNavigation) => void;
}

export interface SessionBadgeSlot {
  readonly id: string;
  render(item: SessionBadgeItem, context: SessionBadgeContext): ReactNode;
}

/** The session facts a copy format may read. */
export interface CopyFormatSession {
  readonly id: string;
  readonly machine?: string;
  readonly agent?: string;
}

/** An extra entry in a session card's copy menu, after core's own action. */
export interface CopyFormat {
  /** Also the remembered menu choice, so keep it stable. */
  readonly id: string;
  readonly label: string;
  /** The text to copy, or null when the session has none. */
  value(session: CopyFormatSession): string | null | undefined;
}

// Ids of core's own copy action (sessionCardCopy.ts).
const CORE_COPY_IDS = ["resume", "provider-session-id"];

/** An installed distribution's device-local ordering policy. */
export interface SessionOrdering {
  subscribe(listener: () => void): () => void;
  snapshot(): string;
  fixed(): boolean;
  order<T extends Session>(sessions: readonly T[]): T[];
}

export interface SettingsPanelSlot {
  readonly id: string;
  render(): ReactNode;
}

export interface SessionActionContext {
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
  readonly resumeAvailable: boolean;
  resume(): Promise<void>;
  reportError(message: string | null): void;
}
export interface SessionActionSlot {
  readonly id: string;
  available(session: Session, context: SessionActionContext): boolean;
  render(session: Session, context: SessionActionContext): ReactNode;
}

export interface UiExtension {
  readonly id: string;
  readonly sessionBadges?: readonly SessionBadgeSlot[];
  readonly sessionActions?: readonly SessionActionSlot[];
  readonly diagnosticProbes?: readonly { readonly name: string; readonly route: string }[];
  readonly usageProviders?: (providers: readonly ProviderUsage[]) => ProviderUsage[];
  readonly sessionOrdering?: SessionOrdering;
  readonly sessionScopes?: (records: readonly FilterRecord[], ext?: Readonly<Record<string, unknown>>) => SessionScopeModel;
  readonly onSessionList?: (ext?: Readonly<Record<string, unknown>>) => void;
  readonly settingsPanels?: readonly SettingsPanelSlot[];
  readonly appProviders?: readonly ComponentType<{ readonly children?: ReactNode; readonly permissions: ReadonlySet<string> }>[];
  /** Display names for workspace slugs; core shows the slug itself (#895). */
  readonly workspaceLabels?: Readonly<Record<string, string>>;
  /** Default badge colors for named hosts; core gives every host one color (#918). */
  readonly machineColorDefaults?: Readonly<Record<string, string>>;
  /** Extra session card copy formats; core offers only its own action (#918). */
  readonly copyFormats?: readonly CopyFormat[];
}

export interface UiExtensionRegistry {
  readonly extensions: readonly UiExtension[];
  readonly diagnosticProbes: readonly { readonly name: string; readonly route: string }[];
  readonly sessionActions: readonly (SessionActionSlot & { readonly key: string })[];
  readonly usageProviders?: (providers: readonly ProviderUsage[]) => ProviderUsage[];
  readonly sessionOrdering?: SessionOrdering;
  readonly sessionScopes?: (records: readonly FilterRecord[], ext?: Readonly<Record<string, unknown>>) => SessionScopeModel;
  readonly onSessionList?: (ext?: Readonly<Record<string, unknown>>) => void;
  readonly settingsPanels: readonly (SettingsPanelSlot & { readonly key: string })[];
  readonly appProviders: readonly ComponentType<{ readonly children?: ReactNode; readonly permissions: ReadonlySet<string> }>[];
  /** Badge slots in registration order; `key` is `<extension id>:<slot id>`. */
  readonly sessionBadges: readonly (SessionBadgeSlot & { readonly key: string })[];
  /** Workspace slug to display name, in registration order. */
  readonly workspaceLabels: ReadonlyMap<string, string>;
  /** Host to default badge color, lowercase `#rrggbb`. */
  readonly machineColorDefaults: Readonly<Record<string, string>>;
  /** Copy formats in registration order. */
  readonly copyFormats: readonly CopyFormat[];
}

export function createUiExtensionRegistry(extensions: readonly UiExtension[]): UiExtensionRegistry {
  const ids = new Set<string>();
  const badgeKeys = new Set<string>();
  const diagnosticProbes: { readonly name: string; readonly route: string }[] = [];
  const sessionActions: (SessionActionSlot & { key: string })[] = [];
  const sessionBadges: (SessionBadgeSlot & { readonly key: string })[] = [];
  const workspaceLabels = new Map<string, string>();
  const machineColorDefaults = createMachineColorMap();
  const copyIds = new Set(CORE_COPY_IDS);
  const copyFormats: CopyFormat[] = [];
  const settingsPanels: (SettingsPanelSlot & { key: string })[] = [];
  const appProviders: ComponentType<{ readonly children?: ReactNode; readonly permissions: ReadonlySet<string> }>[] = [];
  let usageProviders: UiExtension["usageProviders"];
  let sessionOrdering: SessionOrdering | undefined;
  let sessionScopes: UiExtension["sessionScopes"];
  let onSessionList: UiExtension["onSessionList"];
  for (const extension of extensions) {
    if (!EXTENSION_ID.test(extension.id)) throw new Error(`invalid UI extension id "${extension.id}"`);
    if (ids.has(extension.id)) throw new Error(`duplicate UI extension id "${extension.id}"`);
    ids.add(extension.id);
    diagnosticProbes.push(...extension.diagnosticProbes ?? []);
    if (extension.usageProviders) {
      if (usageProviders) throw new Error("multiple usage presentation policies");
      usageProviders = extension.usageProviders;
    }
    if (extension.sessionScopes) {
      if (sessionScopes) throw new Error("multiple session scope policies");
      sessionScopes = extension.sessionScopes;
    }
    if (extension.onSessionList) {
      if (onSessionList) throw new Error("multiple session list observers");
      onSessionList = extension.onSessionList;
    }
    if (extension.sessionOrdering) {
      if (sessionOrdering) throw new Error("multiple session ordering policies");
      sessionOrdering = extension.sessionOrdering;
    }
    for (const action of extension.sessionActions ?? []) {
      const key = `${extension.id}:${action.id}`;
      if (sessionActions.some(slot => slot.key === key)) throw new Error(`duplicate session action "${key}"`);
      sessionActions.push({ ...action, key });
    }
    for (const panel of extension.settingsPanels ?? []) {
      const key = `${extension.id}:${panel.id}`;
      if (settingsPanels.some(slot => slot.key === key)) throw new Error(`duplicate settings panel "${key}"`);
      settingsPanels.push({ ...panel, key });
    }
    appProviders.push(...extension.appProviders ?? []);
    for (const slot of extension.sessionBadges ?? []) {
      const key = `${extension.id}:${slot.id}`;
      if (badgeKeys.has(key)) throw new Error(`duplicate sessionBadges slot "${key}"`);
      badgeKeys.add(key);
      sessionBadges.push(Object.freeze({ id: slot.id, key, render: slot.render.bind(slot) }));
    }
    for (const [slug, label] of Object.entries(extension.workspaceLabels ?? {})) {
      if (normalizeSessionWorkspace(slug) !== slug) throw new Error(`invalid workspace slug "${slug}"`);
      if (workspaceLabels.has(slug)) throw new Error(`duplicate workspace label "${slug}"`);
      if (typeof label !== "string" || !label.trim()) throw new Error(`empty workspace label "${slug}"`);
      workspaceLabels.set(slug, label);
    }
    for (const [machine, color] of Object.entries(extension.machineColorDefaults ?? {})) {
      const normalized = normalizeMachineColor(color);
      if (!normalized) throw new Error(`invalid machine colour default "${machine}"`);
      if (Object.hasOwn(machineColorDefaults, machine)) throw new Error(`duplicate machine colour default "${machine}"`);
      machineColorDefaults[machine] = normalized;
    }
    for (const format of extension.copyFormats ?? []) {
      if (!EXTENSION_ID.test(format.id)) throw new Error(`invalid copy format id "${format.id}"`);
      if (copyIds.has(format.id)) throw new Error(`duplicate copy format "${format.id}"`);
      if (typeof format.label !== "string" || !format.label.trim()) throw new Error(`empty copy format label "${format.id}"`);
      copyIds.add(format.id);
      copyFormats.push(Object.freeze({ id: format.id, label: format.label, value: format.value.bind(format) }));
    }
  }
  return Object.freeze({ diagnosticProbes: Object.freeze(diagnosticProbes), usageProviders, sessionActions: Object.freeze(sessionActions), sessionScopes, onSessionList, sessionOrdering, settingsPanels: Object.freeze(settingsPanels), appProviders: Object.freeze(appProviders), extensions: Object.freeze([...extensions]), sessionBadges: Object.freeze(sessionBadges),
    workspaceLabels: workspaceLabels as ReadonlyMap<string, string>, machineColorDefaults: Object.freeze(machineColorDefaults),
    copyFormats: Object.freeze(copyFormats) });
}

const EMPTY_REGISTRY = createUiExtensionRegistry([]);
const UiExtensionsContext = createContext<UiExtensionRegistry>(EMPTY_REGISTRY);

export function UiExtensionsProvider({ registry, children }: { readonly registry: UiExtensionRegistry; readonly children?: ReactNode }) {
  return <UiExtensionsContext.Provider value={registry}>{children}</UiExtensionsContext.Provider>;
}

export function useUiExtensions(): UiExtensionRegistry {
  return useContext(UiExtensionsContext);
}

/** Every registered session badge for one session on one surface. */
export function SessionBadges({ item, surface, onLineage }: {
  readonly item: SessionBadgeItem;
  readonly surface: SessionBadgeSurface;
  readonly onLineage?: (navigation?: SessionBadgeNavigation) => void;
}) {
  const { sessionBadges } = useUiExtensions();
  if (sessionBadges.length === 0) return item.role ? <span className="session-role-chip">{item.role}</span> : null;
  const context: SessionBadgeContext = onLineage ? { surface, onLineage } : { surface };
  return <>{sessionBadges.map((slot) => <Fragment key={slot.key}>{slot.render(item, context)}</Fragment>)}</>;
}

const subscribeNone = () => () => {};
const emptySnapshot = () => "";
export function useSessionOrdering() {
  const { sessionOrdering } = useUiExtensions();
  const revision = useSyncExternalStore(sessionOrdering?.subscribe ?? subscribeNone, sessionOrdering?.snapshot ?? emptySnapshot, emptySnapshot);
  return { policy: sessionOrdering, fixed: sessionOrdering?.fixed() ?? false, revision };
}

export function ExtensionSettingsPanels() {
  const { settingsPanels } = useUiExtensions();
  return <>{settingsPanels.map(slot => <Fragment key={slot.key}>{slot.render()}</Fragment>)}</>;
}

export function ExtensionAppProviders({ children, permissions }: { readonly children?: ReactNode; readonly permissions: ReadonlySet<string> }) {
  const { appProviders } = useUiExtensions();
  return appProviders.reduceRight<ReactNode>((content, Provider, index) => <Provider key={index} permissions={permissions}>{content}</Provider>, children);
}

/** Distribution actions for the failed-start surface, with core's recovery fallback. */
export function SessionActions({ session, context, children }: { readonly session: Session; readonly context: SessionActionContext; readonly children?: ReactNode }) {
  const { sessionActions } = useUiExtensions();
  const available = sessionActions.filter(slot => slot.available(session, context));
  return available.length ? <>{available.map(slot => <Fragment key={slot.key}>{slot.render(session, context)}</Fragment>)}</> : children;
}
