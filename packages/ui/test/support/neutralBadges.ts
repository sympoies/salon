import { createElement } from "react";
import { coordinatorTreeRole } from "../../src/coordinatorTree.ts";
import type { UiExtension } from "../../src/extensions.tsx";
import { createUiSsrHarness, type UiSsrHarnessOptions } from "./ssr.ts";
import type { Plugin } from "vite";

// Geometry/navigation fixtures contribute an ordinary badge through the real registry.
const badge: UiExtension = { id: "fixture", sessionBadges: [{ id: "role", render: (item, context) => { const role = item.role ?? coordinatorTreeRole(item); return role ?
  createElement("button", { type: "button", className: `control-icon control-icon--identity fixture-marker fixture-marker--${role}`,
    style: { "--icon-size": "var(--icon-role-size)", fontSize: "var(--text-sm)" },
    "aria-label": role[0]!.toUpperCase() + role.slice(1),
    onClick: event => { event.stopPropagation(); context.onLineage?.({ scope: "fixture" }); } },
    createElement("svg", { viewBox: "0 0 24 24", "aria-hidden": true }, createElement("path", { d: "m12 3 9 9-9 9-9-9Z" }))) : null; } }] };
export function createBadgeSsrHarness(options: readonly Plugin[] | UiSsrHarnessOptions = []) {
  return createUiSsrHarness({ ...(Array.isArray(options) ? { plugins: options } : options), extensions: [badge] });
}
