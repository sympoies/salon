import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { uiSource } from "./support/source.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

type Extensions = typeof import("../src/extensions.tsx");
type SlotModule = typeof import("../src/SessionSlot.tsx");
type MobileModule = typeof import("../src/MobileSessionList.tsx");

// Cards mount the xterm pane; markup tests stub it as the other card tests do.
const ssr = createUiSsrHarness([{
  name: "terminal-fixture", enforce: "pre",
  resolveId(source) { return source.endsWith("TerminalPane.tsx") ? "\0terminal-fixture" : null; },
  load(id) { return id === "\0terminal-fixture" ? "export function TerminalPane() { return null; }" : null; },
}]);
after(async () => ssr.close());

const extensions = () => ssr.loadModule<Extensions>("/src/extensions.tsx");

// A badge that reports where and with what it was rendered.
const probe = {
  id: "probe",
  sessionBadges: [{
    id: "where",
    render: (item: { readonly machine?: string; readonly role?: string | null }, context: { readonly surface: string; readonly onLineage?: () => void }): ReactNode =>
      createElement("span", {
        "data-probe": `${context.surface}:${item.machine ?? "-"}:${item.role ?? "-"}:${context.onLineage ? "lineage" : "plain"}`,
      }),
  }],
};

test("the registry rejects duplicate or malformed extension and slot ids", async () => {
  const { createUiExtensionRegistry } = await extensions();
  assert.throws(() => createUiExtensionRegistry([probe, probe]), /duplicate UI extension id "probe"/);
  assert.throws(() => createUiExtensionRegistry([{ id: "Not Kebab" }]), /invalid UI extension id/);
  assert.throws(
    () => createUiExtensionRegistry([{ id: "twice", sessionBadges: [probe.sessionBadges[0]!, probe.sessionBadges[0]!] }]),
    /duplicate sessionBadges slot "twice:where"/,
  );
  const registry = createUiExtensionRegistry([probe, { id: "other", sessionBadges: [{ id: "where", render: () => null }] }]);
  assert.deepEqual(registry.sessionBadges.map((slot) => slot.key), ["probe:where", "other:where"]);
  assert.ok(Object.isFrozen(registry) && Object.isFrozen(registry.sessionBadges));
});

test("workspace labels come from extensions; core keeps none and rejects collisions (#895)", async () => {
  const { createUiExtensionRegistry } = await extensions();
  assert.equal(createUiExtensionRegistry([]).workspaceLabels.size, 0, "core registers no workspace labels");
  const registry = createUiExtensionRegistry([
    { id: "teams", workspaceLabels: { "team-a": "Team A", "team-b": "Team B" } },
    { id: "more", workspaceLabels: { lead: "Lead" } },
  ]);
  assert.deepEqual([...registry.workspaceLabels], [["team-a", "Team A"], ["team-b", "Team B"], ["lead", "Lead"]]);
  assert.ok(Object.isFrozen(registry));
  assert.throws(() => createUiExtensionRegistry([{ id: "one", workspaceLabels: { lead: "A" } }, { id: "two", workspaceLabels: { lead: "B" } }]),
    /duplicate workspace label "lead"/);
  assert.throws(() => createUiExtensionRegistry([{ id: "bad", workspaceLabels: { "Not A Slug": "X" } }]), /invalid workspace slug "Not A Slug"/);
  assert.throws(() => createUiExtensionRegistry([{ id: "empty", workspaceLabels: { lead: " " } }]), /empty workspace label "lead"/);
});

test("machine colour defaults come from extensions; core keeps none and rejects bad entries (#918)", async () => {
  const { createUiExtensionRegistry } = await extensions();
  assert.equal(Object.keys(createUiExtensionRegistry([]).machineColorDefaults).length, 0, "core registers no host colours");
  const registry = createUiExtensionRegistry([
    { id: "hosts", machineColorDefaults: { "host-a": "#FFF68F" } },
    { id: "more", machineColorDefaults: { "host-b": "#ef5350" } },
  ]);
  assert.deepEqual({ ...registry.machineColorDefaults }, { "host-a": "#fff68f", "host-b": "#ef5350" });
  assert.ok(Object.isFrozen(registry.machineColorDefaults));
  assert.throws(() => createUiExtensionRegistry([{ id: "one", machineColorDefaults: { "host-a": "#000000" } }, { id: "two", machineColorDefaults: { "host-a": "#ffffff" } }]),
    /duplicate machine colour default "host-a"/);
  assert.throws(() => createUiExtensionRegistry([{ id: "bad", machineColorDefaults: { "host-a": "red" } }]), /invalid machine colour default "host-a"/);
});

test("copy formats come from extensions; core keeps none and rejects bad entries (#918)", async () => {
  const { createUiExtensionRegistry } = await extensions();
  assert.deepEqual(createUiExtensionRegistry([]).copyFormats, [], "core registers no copy formats");
  const value = (session: { readonly id: string }) => `watch ${session.id}`;
  const registry = createUiExtensionRegistry([
    { id: "chat", copyFormats: [{ id: "watch", label: "Copy watch command", value }] },
    { id: "more", copyFormats: [{ id: "link", label: "Copy link", value: () => null }] },
  ]);
  assert.deepEqual(registry.copyFormats.map((format) => format.id), ["watch", "link"]);
  assert.equal(registry.copyFormats[0]!.value({ id: "s1" }), "watch s1");
  assert.ok(Object.isFrozen(registry.copyFormats) && Object.isFrozen(registry.copyFormats[0]));
  const format = { id: "watch", label: "Copy watch command", value };
  assert.throws(() => createUiExtensionRegistry([{ id: "one", copyFormats: [format] }, { id: "two", copyFormats: [format] }]),
    /duplicate copy format "watch"/);
  for (const id of ["resume", "provider-session-id"]) {
    assert.throws(() => createUiExtensionRegistry([{ id: "core", copyFormats: [{ ...format, id }] }]), new RegExp(`duplicate copy format "${id}"`));
  }
  assert.throws(() => createUiExtensionRegistry([{ id: "bad", copyFormats: [{ ...format, id: "Bad id" }] }]), /invalid copy format id "Bad id"/);
  assert.throws(() => createUiExtensionRegistry([{ id: "bad", copyFormats: [{ ...format, label: " " }] }]), /empty copy format label "watch"/);
});

test("session cards offer registered copy formats; core offers only its own action (#918)", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry } = await extensions();
  const { SessionSlot } = await ssr.loadModule<SlotModule>("/src/SessionSlot.tsx");
  const session = makeSession({ id: "plain" });
  const registry = createUiExtensionRegistry([{ id: "chat", copyFormats: [{ id: "watch", label: "Copy watch command", value: (s) => `/watch ${s.id}` }] }]);
  const props = makeSessionSlotProps({ session, options: [session] });
  const html = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry }, createElement(SessionSlot, props)));
  assert.match(html, /aria-label="Copy watch command for [^"]+"/);
  assert.match(html, /title="Copy watch command"/);
  const core = renderToStaticMarkup(createElement(SessionSlot, props));
  assert.doesNotMatch(core, /session-command-copy-button/, "without extensions a session with no core copy action has no copy menu");
});

test("session cards take machine accent defaults from extensions; an override still wins (#918)", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry } = await extensions();
  const { SessionSlot } = await ssr.loadModule<SlotModule>("/src/SessionSlot.tsx");
  const session = makeSession({ machine: "host-a" });
  const registry = createUiExtensionRegistry([{ id: "hosts", machineColorDefaults: { "host-a": "#ef5350" } }]);
  const render = (props: ReturnType<typeof makeSessionSlotProps>) => renderToStaticMarkup(createElement(UiExtensionsProvider, { registry }, createElement(SessionSlot, props)));
  const html = render(makeSessionSlotProps({ session, options: [session] }));
  assert.match(html, /style="[^"]*--machine-accent:#ef5350/);
  assert.match(html, /style="[^"]*--machine-accent-rgb:239, 83, 80/);
  assert.match(render(makeSessionSlotProps({ session, options: [session], machineColors: { "host-a": "#addb67" } })), /--machine-accent:#addb67/);
  const core = renderToStaticMarkup(createElement(SessionSlot, makeSessionSlotProps({ session, options: [session] })));
  assert.match(core, /--machine-accent:#82aaff/, "without extensions every host gets the core default");
});

test("desktop session cards render registered badges with the lineage action", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry } = await extensions();
  const { SessionSlot } = await ssr.loadModule<SlotModule>("/src/SessionSlot.tsx");
  const session = makeSession({ id: "a", machine: "host-a", role: "reviewer" });
  const base = makeSessionSlotProps({ session });
  const props = { ...base, actions: { ...base.actions, onLineageMarker: () => {} } };
  const html = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry: createUiExtensionRegistry([probe]) },
    createElement(SessionSlot, props)));
  assert.match(html, /data-probe="card:host-a:reviewer:lineage"/);
  const plain = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry: createUiExtensionRegistry([probe]) },
    createElement(SessionSlot, makeSessionSlotProps({ session }))));
  assert.match(plain, /data-probe="card:host-a:reviewer:plain"/);
});

test("a badge can address its session and use the refresh hook from the extensions entry", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry, useSessionRefresh } = await extensions();
  const { SessionSlot } = await ssr.loadModule<SlotModule>("/src/SessionSlot.tsx");
  const RefreshIcon = ({ target }: { readonly target: { readonly machine: string; readonly id: string } }) =>
    createElement("button", { "data-refresh": `${target.machine}:${target.id}:${useSessionRefresh().state.status}` });
  const refresher = {
    id: "refresher",
    sessionBadges: [{
      id: "role-icon",
      render: (item: { readonly machine?: string; readonly id?: string }): ReactNode =>
        item.machine && item.id ? createElement(RefreshIcon, { target: { machine: item.machine, id: item.id } }) : null,
    }],
  };
  const html = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry: createUiExtensionRegistry([refresher]) },
    createElement(SessionSlot, makeSessionSlotProps({ session: makeSession({ id: "a", machine: "host-a" }) }))));
  assert.match(html, /data-refresh="host-a:a:idle"/);
});

test("phone session cards render registered badges", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry } = await extensions();
  const { MobileSessionList } = await ssr.loadModule<MobileModule>("/src/MobileSessionList.tsx");
  const sessions = [makeSession({ id: "b", machine: "host-b", role: null })];
  const html = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry: createUiExtensionRegistry([probe]) },
    createElement(MobileSessionList, {
      sessions, options: sessions, machineColors: {}, reachableMachineNames: new Set(["host-b"]),
      activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null, autoResumePendingKey: null,
      accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0,
      onScrollTopChange() {}, onOpen() {}, editingTitleKey: null, beginTitleEdit() {}, saveTitleEdit: async () => {},
      cancelTitleEdit() {}, onRetitle() {}, onNewSession() {}, onSelectSession() {}, onResume() {},
      onAutoResume: async () => true, onAccount: async () => {}, onLineageMarker() {},
    })));
  assert.match(html, /data-probe="mobile-card:host-b:-:lineage"/);
});

test("history rows mount the badge slot for the history surface", () => {
  const source = uiSource("HistoryPanel.tsx");
  assert.match(source, /<SessionBadges\s+item=\{marker\}\s+surface="history"\s*\/>/);
});

test("without extensions cards show a plain role chip without private marker presentation", async () => {
  const { UiExtensionsProvider, createUiExtensionRegistry } = await extensions();
  const { SessionSlot } = await ssr.loadModule<SlotModule>("/src/SessionSlot.tsx");
  const props = makeSessionSlotProps({ session: makeSession({ id: "c", machine: "host-c", role: "coordinator" }) });
  const bare = renderToStaticMarkup(createElement(SessionSlot, props));
  const empty = renderToStaticMarkup(createElement(UiExtensionsProvider, { registry: createUiExtensionRegistry([]) },
    createElement(SessionSlot, props)));
  assert.equal(empty, bare);
  assert.doesNotMatch(bare, /data-probe|class="role-icon"/);
  assert.ok(bare.includes('session-role-chip">coordinator</span>'));
});

test("the default entry mounts the app through mountApp with no extensions", async () => {
  const main = uiSource("main.tsx");
  assert.match(main, /import \{ mountApp \} from "\.\/mountApp\.tsx";/);
  assert.match(main, /mountApp\(document\.getElementById\("root"\), \{ extensions: \[\] \}\)/);
  const mount = uiSource("mountApp.tsx");
  assert.match(mount, /import "\.\/styles\.css";/, "a distribution entry gets the core styles through mountApp");
  assert.match(mount, /createUiExtensionRegistry\(options\.extensions \?\? \[\]\)/);
  assert.match(mount, /<UiExtensionsProvider registry=\{registry\}>/);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports?: Record<string, { source: string }> };
  for (const [subpath, target] of Object.entries({ "./app": "./src/mountApp.tsx", "./extensions": "./src/extensions.tsx", "./vite": "./vite.shared.ts" })) {
    assert.equal(manifest.exports?.[subpath]?.source, target);
  }
});
