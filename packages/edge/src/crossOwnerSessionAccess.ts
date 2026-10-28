import type { AccessStore } from "./accessStore.ts";
import type { CrossOwnerSessionAccessRule } from "./config.ts";

const MAX_LINEAGE_NODES = 256;

/**
 * Whether `viewer` may see and message a session that another principal owns,
 * by machine and session id. Null when no rule names the viewer. A session
 * qualifies when its owner is a rule's `owner` and it is a selected session or
 * descends from one through the recorded dispatcher or launcher lineage. The
 * result reads ownership only; it never claims, binds or repairs a grant.
 * Build one per request: grants are read through to the store once per session.
 */
export function sessionViewerAccess(
  rules: readonly CrossOwnerSessionAccessRule[] | undefined,
  store: AccessStore | null,
  viewerId: string,
): ((machine: string, sessionId: string) => boolean) | null {
  const mine = (rules ?? []).filter(rule => rule.viewer === viewerId);
  if (!store || !mine.length) return null;
  const grants = new Map<string, ReturnType<AccessStore["sessionGrant"]>>();
  const grantOf = (machine: string, sessionId: string) => {
    const key = JSON.stringify([machine, sessionId]);
    if (!grants.has(key)) grants.set(key, store.sessionGrant(machine, sessionId));
    return grants.get(key);
  };
  return (machine, sessionId) => {
    const owner = grantOf(machine, sessionId)?.principalId;
    const selectors = mine.filter(rule => rule.owner === owner).flatMap(rule => rule.sessions);
    if (!selectors.length) return false;
    const pending = [{ machine, sessionId }];
    const seen = new Set<string>();
    while (pending.length && seen.size < MAX_LINEAGE_NODES) {
      const node = pending.pop()!;
      const key = JSON.stringify([node.machine, node.sessionId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (selectors.some(s => s.machine === node.machine && s.session_id === node.sessionId)) return true;
      const grant = grantOf(node.machine, node.sessionId);
      for (const parent of [grant?.dispatcher, grant?.launcher]) {
        if (parent) pending.push({ machine: parent.machine, sessionId: parent.sessionId });
      }
    }
    return false;
  };
}
