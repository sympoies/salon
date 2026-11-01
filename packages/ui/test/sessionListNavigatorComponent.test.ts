import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { CLEAR_SESSION_FILTERS, type SessionFilters } from "../src/sessionFilters.ts";
import type { SessionListNavigatorProps } from "../src/SessionListNavigator.tsx";
const ssr = createUiSsrHarness();

after(async () => ssr.close());

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): {
  readonly window: Window;
  readonly root: Root;
  readonly container: HTMLElement;
  cleanup(): Promise<void>;
} {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    window,
    root,
    container,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, previous);
    },
  };
}


async function loadNavigator() { return (await ssr.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx")).SessionListNavigator; }
const base: SessionListNavigatorProps = { filters: CLEAR_SESSION_FILTERS, machines: ["host-a", "host-b"], harnesses: [{id:"codex",label:"Codex"}],
 resultCount: 4, mobile: true, page: 1, pageCount: 2, onPageChange: () => {}, onChange: () => {} };
async function mount(options: Partial<SessionListNavigatorProps> = {}) {
 const Navigator = await loadNavigator(), dom = installDom(); cleanupStack.push(dom.cleanup);
 const commits: SessionFilters[] = [];
 const pages: number[] = [];
 function Harness() { const [filters,setFilters] = useState(options.filters ?? CLEAR_SESSION_FILTERS); return createElement(Navigator, {...base,...options,filters,onPageChange:(page:number)=>{pages.push(page);},onChange:(next:SessionFilters)=>{ commits.push(next);setFilters(next); }}); }
 await act(async()=>{dom.root.render(createElement(Harness));await new Promise(resolve=>setTimeout(resolve,0));});
 return {...dom,commits,pages};
}
const button = (container: ParentNode, name: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item=>item.textContent?.trim()===name);assert.ok(found,name);return found; };
async function click(element: HTMLElement) { await act(async()=>{element.click();await new Promise(resolve=>setTimeout(resolve,0));}); }

test("desktop pagination always shows: one page or no sessions render 1 / 1 with every pager control disabled; a phone hides it", async()=>{
 const Navigator=await loadNavigator();
 for (const mobile of [false,true]) {
  for (const pageCount of [0,1]) {
   const single=renderComponent(Navigator,{...base,mobile,page:1,pageCount});
   if (mobile) { assert.doesNotMatch(single,/session-list-pagination/,`phone pageCount ${pageCount} hides the pager`); continue; }
   assert.match(single,/class="session-list-pagination" role="group" aria-label="Page 1 of 1"/,`pageCount ${pageCount} keeps the pager`);
   assert.match(single,/aria-label="Previous page" disabled=""/,`pageCount ${pageCount}: previous is disabled`);
   assert.match(single,/aria-label="Next page" disabled=""/,`pageCount ${pageCount}: next is disabled`);
   assert.match(single,/aria-label="Choose page, currently 1 of 1"[^>]*disabled=""[^>]*>1 \/ 1</,`pageCount ${pageCount}: the label reads 1 / 1 and opens no picker`);
  }
  const multiplePages=renderComponent(Navigator,{...base,mobile,page:1,pageCount:2});
  assert.match(multiplePages,/class="session-list-pagination" role="group" aria-label="Page 1 of 2"/);
 }
});

test("page label opens a page picker, selecting a page jumps and closes it, arrows still step",async()=>{
 const dom=await mount({page:2,pageCount:5});
 const label=dom.container.querySelector<HTMLButtonElement>(".session-list-page-label");
 assert.ok(label,"the page label is an interactive picker control");
 assert.equal(label.getAttribute("aria-expanded"),"false");
 await click(label);
 assert.equal(dom.container.querySelectorAll('[role="menuitem"]').length,5);
 await click(button(dom.container,"Page 4"));
 assert.deepEqual(dom.pages,[4]);
 assertNoElement(dom.container,'[role="menu"]');
 await click(dom.container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!);
 assert.deepEqual(dom.pages,[4,3]);
});

test("Hosts and Roles start expanded with accurate summaries and toggle compact choices",async()=>{
 const props={...base,roles:["analyst","reviewer"],filters:{...CLEAR_SESSION_FILTERS,hosts:["host-a"],roles:["reviewer",null]},open:true};
 const dom=await mount(props);
 const sections=[...dom.container.querySelectorAll<HTMLDetailsElement>('[data-filter-dimension="hosts"], [data-filter-dimension="roles"]')];
 assert.equal(sections.length,2,"Hosts and Roles each have a collapsible section");
 assert.ok(sections.every(section=>section.open),"both sections start expanded");
 assert.match(sections[0]!.querySelector("summary")!.textContent!,/Hosts\s+1 of 2/);
 assert.match(sections[1]!.querySelector("summary")!.textContent!,/Roles\s+2 of 3/);
 for (const section of sections) {
  assert.ok(section.querySelectorAll(".session-filter-choice").length>0,"choices use the compact choice grid");
  await click(section.querySelector("summary")!);
  assert.equal(section.open,false);
  await click(section.querySelector("summary")!);
  assert.equal(section.open,true);
 }
});

test("role choices select No role and Roles chip removes only that dimension",async()=>{
 const dom=await mount({roles:["analyst","reviewer"],filters:{...CLEAR_SESSION_FILTERS,hosts:["host-a"],roles:["reviewer"]},open:true});
 const roleSection=dom.container.querySelector<HTMLDetailsElement>('.session-filter-multi-select[data-filter-dimension="roles"]');
 assert.ok(roleSection,"Roles choices are available");
 const noRole=roleSection.querySelector<HTMLInputElement>('input[value=""]');
 assert.ok(noRole,"the no-role session choice is represented explicitly");
 assert.equal(noRole.checked,false);
 await click(noRole);
 await click(button(dom.container,"Apply filters"));
 assert.deepEqual(dom.commits.at(-1)?.roles,[null,"reviewer"]);
 const rolesChip=dom.container.querySelector<HTMLButtonElement>('.session-filter-chip[aria-label^="Remove Roles:"]');
 assert.ok(rolesChip,"a narrowed role selection is removable by dimension");
 await click(rolesChip);
 assert.equal(dom.commits.at(-1)?.roles,null);
 assert.deepEqual(dom.commits.at(-1)?.hosts,["host-a"],"removing Roles preserves the unrelated host restriction");
});

test("status controls render four named groups with category counts", async()=>{
 const html=renderComponent(await loadNavigator(),{...base,countsAvailable:true,statusCounts:{working:7,waiting:3,attention:2,stopped:4}});
 assert.match(html,/data-status-group="working"[^>]*aria-label="Working: 7 sessions"[\s\S]*?<span class="session-status-count-label">Working<\/span>/);
 assert.match(html,/data-status-group="waiting"[^>]*aria-label="Waiting: 3 sessions"[\s\S]*?<span class="session-status-count-label">Waiting<\/span>/);
 assert.match(html,/data-status-group="attention"[^>]*aria-label="Needs attention: 2 sessions"[\s\S]*?<span class="session-status-count-label">Attention<\/span>/);
 assert.match(html,/data-status-group="stopped"[^>]*aria-label="Stopped: 4 sessions"[\s\S]*?<span class="session-status-count-label">Stop<\/span>/);
});

test("default dimensions do not count as filters and narrowed hosts show their names", async()=>{
 const Navigator=await loadNavigator();
 const machines=["moss","cedar","mesa"];
 const defaults=renderComponent(Navigator,{...base,machines,filters:{...CLEAR_SESSION_FILTERS}});
 assert.doesNotMatch(defaults,/aria-label="Remove Hosts:/);
 const allSelected=renderComponent(Navigator,{...base,machines,filters:{...CLEAR_SESSION_FILTERS,hosts:machines}});
 assert.doesNotMatch(allSelected,/aria-label="Remove Hosts:/,"all selected hosts are not an active condition");
 const beforeLoad=renderComponent(Navigator,{...base,machines:[],filters:{...CLEAR_SESSION_FILTERS,hosts:["moss"]}});
 assert.doesNotMatch(beforeLoad,/aria-label="Remove Hosts:/,"an empty host inventory does not create a misleading chip");
 const narrowed=renderComponent(Navigator,{...base,machines,filters:{...CLEAR_SESSION_FILTERS,hosts:["moss","cedar"]}});
 assert.match(narrowed,/aria-label="Remove Hosts: moss, cedar"/);
 assert.match(narrowed,/Hosts: moss, cedar/,"narrowing remains visible as a host-group chip");
});

test("stale selected hosts remain visible as an active filter condition", async()=>{
 const html=renderComponent(await loadNavigator(),{...base,filters:{...CLEAR_SESSION_FILTERS,hosts:["host-a","stale-host"]}});
 assert.match(html,/aria-label="Remove Hosts: host-a, stale-host"/,
  "a stale selection remains represented while it still excludes a live host");
});

test("closed filters keep removable restrictions and excluded-host coverage inside the open panel", async()=>{
 const Navigator=await loadNavigator();
 const filters={...CLEAR_SESSION_FILTERS,hosts:["host-a"],harness:"codex",repo:"agent-console"};
 const closedHtml=renderComponent(Navigator,{...base,filters});
 assert.match(closedHtml,/aria-label="Remove Hosts: host-a"/);
 assert.doesNotMatch(closedHtml,/class="session-filter-panel/);
 const html=renderComponent(Navigator,{...base,filters,open:true});
 assert.match(html,/Remove Hosts: host-a/);assert.match(html,/Remove Harness: Codex/);assert.match(html,/Remove Repository: agent-console/);
 assert.match(html,/1 host excluded by your filter/);assert.match(html,/Show all hosts/);assert.match(html,/Clear all/);assert.match(html,/class="session-filter-panel[^>]*role="dialog"/);
});
test("search bar renders each active filter as an individually removable chip",async()=>{
 const filters={...CLEAR_SESSION_FILTERS,hosts:["host-a"],harness:"codex"};
 const closed=renderComponent(await loadNavigator(),{...base,filters});
 assert.match(closed,/class="session-filter-search-icon"/);
 assert.match(closed,/class="session-filter-search-chips"[^>]*aria-label="Active session filters"/);
 assert.match(closed,/aria-label="Remove Hosts: host-a"/);
 assert.match(closed,/aria-label="Remove Harness: Codex"/);
 assert.doesNotMatch(closed,/session-filter-compact-state/);
 const dom=await mount({filters});
 await click(dom.container.querySelector<HTMLButtonElement>('[aria-label="Remove Harness: Codex"]')!);
 assert.deepEqual(dom.commits.at(-1),{...filters,harness:null},"removing one chip preserves the other condition");
});
test("empty search bar has a placeholder and no condition chip",async()=>{
 const html=renderComponent(await loadNavigator(),base);
 assert.match(html,/Filter sessions/);
 assert.doesNotMatch(html,/All 2 hosts shown|class="session-filter-coverage"|session-filter-chip/);
 assert.doesNotMatch(html,/session-filter-chips|host excluded by your filter|Show all hosts|>Clear all</);
});
test("closed filters signal pending notices on the trigger",async()=>{
 const Navigator=await loadNavigator();
 for(const [props,noticeText] of [
  [{notice:"Host list is temporarily incomplete."},"Notice: Host list is temporarily incomplete."],
  [{migrationNotice:true},"Notice: Host filter notice available."],
 ] as const){
  const html=renderComponent(Navigator,{...base,...props});
  assert.ok(html.includes(noticeText),noticeText);
  assert.match(html,/class="session-filter-notice-indicator" aria-hidden="true">!<\/span>/);
 }
});
test("drafts wait for Apply filters; Escape discards and restores focus",async()=>{
 const dom=await mount();const trigger=dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!;await click(trigger);
 const harness=dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
 await act(async()=>{harness.value="codex";harness.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 assert.equal(dom.commits.length,0);await click(button(dom.container,"Apply filters"));assert.equal(dom.commits[0]?.harness,"codex");
 await click(trigger);await act(async()=>{dom.container.querySelector('[role="dialog"]')!.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
 assert.equal(Boolean(dom.container.querySelector('[role="dialog"]')),false);assert.equal(dom.window.document.activeElement===trigger,true);
});
test("search bar opens and closes the existing filter panel by click or keyboard",async()=>{
 for (const options of [{}, {board:true,mobile:true}]) {
  const dom=await mount(options);const toggle=dom.container.querySelector<HTMLElement>(".session-filters-trigger")!;
  assert.equal(toggle.getAttribute("aria-expanded"),"false");
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"),"true");
  assert.equal(Boolean(dom.container.querySelector('[role="dialog"]')),true);
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"),"false");
 }
});
test("empty space around the chips opens the same filter panel",async()=>{
 const dom=await mount();
 await click(dom.container.querySelector<HTMLElement>(".session-filter-searchbar")!);
 assert.equal(Boolean(dom.container.querySelector('[role="dialog"]')),true);
});
test("Clear all removes every dimension",async()=>{
 const birth="2030-01-01T00:00:00Z";
 const dom=await mount({open:true,filters:{hosts:["host-a"],harness:"codex",repo:"repo",state:"closed",since:"7d"}});
 assert.match(dom.container.textContent??"",/Hosts: host-a/);await click(button(dom.container,"Clear all"));assert.deepEqual(dom.commits[0],CLEAR_SESSION_FILTERS);
});
test("a host chip resets only host coverage and a single host can be isolated",async()=>{
 const dom=await mount({filters:{...CLEAR_SESSION_FILTERS,harness:"codex"}});await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 const second=dom.container.querySelector<HTMLInputElement>('input[value="host-b"]')!;await click(second);await click(button(dom.container,"Apply filters"));
 assert.deepEqual(dom.commits[0]?.hosts,["host-b"]);await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 await click(button(dom.container,"Hosts: host-b ×"));assert.equal(dom.commits.at(-1)?.hosts,null);assert.equal(dom.commits.at(-1)?.harness,"codex");
});
test("applying after removing an active chip preserves the committed removal",async()=>{
 const dom=await mount({filters:{...CLEAR_SESSION_FILTERS,hosts:["host-a"],harness:"codex"}});
 await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 await click(button(dom.container,"Hosts: host-a ×"));
 assert.equal(dom.commits.at(-1)?.hosts,null);
 await click(button(dom.container,"Apply filters"));
 assert.equal(dom.commits.at(-1)?.hosts,null,"Apply must not restore the chip's stale host restriction");
 assert.equal(dom.commits.at(-1)?.harness,"codex");
});
test("removing an active chip preserves unrelated draft edits",async()=>{
 const dom=await mount({filters:{...CLEAR_SESSION_FILTERS,hosts:["host-a"]},harnesses:[{id:"codex",label:"Codex"},{id:"claude",label:"Claude"}]});
 await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 const harness=dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
 await act(async()=>{harness.value="claude";harness.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 await click(button(dom.container,"Hosts: host-a ×"));
 await click(button(dom.container,"Apply filters"));
 assert.equal(dom.commits.at(-1)?.hosts,null);
 assert.equal(dom.commits.at(-1)?.harness,"claude","chip reset must keep the unrelated harness draft");
});
test("status count changes preserve unrelated filter drafts",async()=>{
 const dom=await mount({harnesses:[{id:"codex",label:"Codex"},{id:"claude",label:"Claude"}],statusCounts:{working:2,waiting:0,attention:0,stopped:0}});
 await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 const harness=dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
 await act(async()=>{harness.value="claude";harness.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 await click(dom.container.querySelector<HTMLButtonElement>('[data-status-group="working"]')!);
 await click(button(dom.container,"Apply filters"));
 assert.equal(dom.commits.at(-1)?.harness,"claude");
 assert.equal(dom.commits.at(-1)?.statusGroup,"working");
});
test("mobile sheet traps Tab and desktop paging remains circular",async()=>{
 const dom=await mount({mobile:true});await click(dom.container.querySelector<HTMLButtonElement>(".session-filters-trigger")!);
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
 const panel=dom.container.querySelector<HTMLElement>('[role="dialog"]')!;assert.equal(panel.getAttribute("aria-modal"),"true");
 const controls=[...panel.querySelectorAll<HTMLElement>("button,select,input")];const first=controls[0]!,last=controls.at(-1)!;
 await act(async()=>{last.focus();last.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));});
 assert.equal(dom.window.document.activeElement===first,true);
 const pages:number[]=[];const Navigator=await loadNavigator();await act(async()=>dom.root.render(createElement(Navigator,{...base,page:2,onPageChange:next=>pages.push(next)})));
 await click(dom.container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!);assert.deepEqual(pages,[3]);
});

for (const mobile of [false, true]) {
 test(`${mobile ? "mobile" : "desktop"} facets show zeros and update drafts and refreshed records before Apply`, async()=>{
  const Navigator = await loadNavigator(), dom = installDom(); cleanupStack.push(dom.cleanup);
  const rows = [
   {machine:"host-a",session_id:"a",created_at:"2030-01-01T00:00:00Z",provider:"codex",role:"reviewer" as const},
   {machine:"host-b",session_id:"b",created_at:"2030-01-01T00:00:00Z",provider:"claude"},
  ];
  const props = {...base, mobile, open:true, records:rows, roles:["reviewer","tester"],
   harnesses:[{id:"codex",label:"Codex"},{id:"claude",label:"Claude"}],onChange(){assert.fail("draft changes must wait for Apply");}};
  // Workspace names come from a distribution's UI extension (#895); these are neutral.
  const { createUiExtensionRegistry, UiExtensionsProvider } = await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
  const registry = createUiExtensionRegistry([{ id: "teams", workspaceLabels: { lead: "Lead", "team-b": "Team B", "team-a": "Team A" } }]);
  const view = (next: SessionListNavigatorProps) => createElement(UiExtensionsProvider, { registry }, createElement(Navigator, next));
  await act(async()=>{dom.root.render(view(props));});
  const labels = () => [...dom.container.querySelectorAll(".session-filter-choice")].map(el=>el.textContent?.trim());
  const harness = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
  assert.deepEqual([...harness.options].map(option=>option.textContent),["All harnesses (2)","Codex (1)","Claude (1)"]);
  assertNoElement(dom.container,'select[aria-label="Scope"]',"no Scope field is offered");
  assert.deepEqual(labels(),["Lead (0)","Team B (0)","Team A (0)","Unassigned (2)","host-a (1)","host-b (1)","No role (1)","reviewer (1)","tester (0)"]);
  await act(async()=>{harness.value="claude";harness.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
  assert.deepEqual(labels(),["Lead (0)","Team B (0)","Team A (0)","Unassigned (1)","host-a (0)","host-b (1)","No role (1)","reviewer (0)","tester (0)"]);
  assert.equal(harness.options[0]!.textContent,"All harnesses (2)","own dimension remains ignored");
  await act(async()=>{dom.root.render(view({...props,records:[...rows,{...rows[1]!,session_id:"new"}]}));});
  assert.equal(harness.value,"claude","refresh preserves the unsaved draft");
  assert.deepEqual(labels(),["Lead (0)","Team B (0)","Team A (0)","Unassigned (2)","host-a (0)","host-b (2)","No role (2)","reviewer (0)","tester (0)"]);
 });
}

test("filters open immediately with placeholders until a usable snapshot replaces errors", async()=>{
 const Navigator=await loadNavigator(),dom=installDom();cleanupStack.push(dom.cleanup);
 const props={...base,open:true};
 await act(async()=>{dom.root.render(createElement(Navigator,props));});
 const harness=()=>dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
 assert.equal(harness().options[0]!.textContent,"All harnesses (–)");
 assert.equal(harness().disabled,false);
 await act(async()=>{dom.root.render(createElement(Navigator,{...props,records:[]}));});
 assert.equal(harness().options[0]!.textContent,"All harnesses (0)","a successful empty snapshot is zero");
 await act(async()=>{dom.root.render(createElement(Navigator,{...props,records:undefined}));});
 assert.equal(harness().options[0]!.textContent,"All harnesses (–)","error/reconnect never shows a stale count");
});

const facetSection = (container: ParentNode, dimension: string) => {
  const section = container.querySelector<HTMLDetailsElement>(`.session-filter-multi-select[data-filter-dimension="${dimension}"]`);
  assert.ok(section, `${dimension} section is available`);
  return section;
};

test("Hosts all state checks nothing, and the first pick isolates that host", async () => {
  const dom = await mount({ machines: ["host-a", "host-b", "host-c"], open: true });
  const section = facetSection(dom.container, "hosts");
  await click(section.querySelector("summary")!);
  const boxes = [...section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every(box => !box.checked), "the all state renders no host as picked");
  assert.match(section.querySelector("summary")!.textContent!, /All hosts \(/);
  await click(boxes[1]!);
  await click(button(dom.container, "Apply filters"));
  assert.deepEqual(dom.commits.at(-1)?.hosts, ["host-b"]);
});

test("further host picks add, and removing the last host returns to all, never an empty filter", async () => {
  const dom = await mount({ machines: ["host-a", "host-b", "host-c"], filters: { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"] }, open: true });
  const section = facetSection(dom.container, "hosts");
  await click(section.querySelector("summary")!);
  const box = (machine: string) => section.querySelector<HTMLInputElement>(`input[value="${machine}"]`)!;
  await click(box("host-c"));
  await click(button(dom.container, "Apply filters"));
  assert.deepEqual(dom.commits.at(-1)?.hosts, ["host-a", "host-c"]);
  await click(box("host-a"));
  await click(box("host-c"));
  await click(button(dom.container, "Apply filters"));
  assert.equal(dom.commits.at(-1)?.hosts, null, "removing the last host returns to all");
  assert.ok(dom.commits.every(commit => commit.hosts === null || commit.hosts.length > 0), "no commit carries an empty host selection");
});

test("the Hosts all control resets the group to all", async () => {
  const dom = await mount({ machines: ["host-a", "host-b"], filters: { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"] }, open: true });
  const section = facetSection(dom.container, "hosts");
  await click(section.querySelector("summary")!);
  await click(button(section, "All hosts"));
  await click(button(dom.container, "Apply filters"));
  assert.equal(dom.commits.at(-1)?.hosts, null);
});

test("a narrowed host selection shows as a Hosts chip naming the value", async () => {
  const dom = await mount({ machines: ["host-a", "host-b"], filters: { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"] }, open: true });
  assert.ok(dom.container.querySelector('.session-filter-chip[aria-label="Remove Hosts: host-a"]'), "the chip names the selected host");
});

test("the first role pick isolates that role and the all state checks no role", async () => {
  const dom = await mount({ roles: ["analyst", "reviewer"], open: true });
  const section = facetSection(dom.container, "roles");
  await click(section.querySelector("summary")!);
  const boxes = [...section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.ok(boxes.every(box => !box.checked), "the all state renders no role as picked");
  await click(section.querySelector<HTMLInputElement>('input[value="analyst"]')!);
  await click(button(dom.container, "Apply filters"));
  assert.deepEqual(dom.commits.at(-1)?.roles, ["analyst"]);
});

test("Apply keeps a host restriction while the host inventory is still empty", async () => {
  const dom = await mount({ machines: [], filters: { ...CLEAR_SESSION_FILTERS, hosts: ["moss"] }, open: true });
  const harness = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
  await act(async () => { harness.value = "codex"; harness.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await click(button(dom.container, "Apply filters"));
  assert.deepEqual(dom.commits.at(-1)?.hosts, ["moss"], "an unloaded host inventory must not drop the host restriction");
  assert.equal(dom.commits.at(-1)?.harness, "codex");
});

test("title-area counts keep staged filter edits and return inside the inactive dashboard", async () => {
 const Navigator=await loadNavigator(),dom=installDom();cleanupStack.push(dom.cleanup);
 const target=dom.window.document.createElement("div");target.id="mac-titlebar-counts";dom.window.document.body.append(target);
 const commits:SessionFilters[]=[];
 function Host({active}:{active:boolean}) {
  const[filters,setFilters]=useState(CLEAR_SESSION_FILTERS);
  return createElement(Navigator,{...base,mobile:false,statusCountsTarget:active?target:null,filters,
   onChange(next:SessionFilters){commits.push(next);setFilters(next);}});
 }
 await act(async()=>dom.root.render(createElement(Host,{active:true})));
 assert.equal(target.querySelectorAll('.session-status-count').length,4);
 assertNoElement(dom.container,'.session-status-count');
 await click(dom.container.querySelector<HTMLButtonElement>('.session-filter-search-open')!);
 const harness=dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
 await act(async()=>{harness.value="codex";harness.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
 const working=target.querySelector<HTMLButtonElement>('[data-status-group="working"]')!;
 await act(async()=>working.dispatchEvent(new dom.window.Event("pointerdown",{bubbles:true})));
 await click(working);
 assert.ok(dom.container.querySelector('.session-filter-panel'),"portal pointerdown must not dismiss the panel");
 assert.equal(commits.at(-1)?.statusGroup,"working");assert.equal(commits.at(-1)?.harness,null,"only the status applies immediately");
 await click(button(dom.container,"Apply filters"));
 assert.equal(commits.at(-1)?.harness,"codex");assert.equal(commits.at(-1)?.statusGroup,"working");
 await act(async()=>dom.root.render(createElement(Host,{active:false})));
 assert.equal(target.querySelectorAll('.session-status-count').length,0,"inactive Dashboard leaves no interactive counts outside its inert subtree");
 assert.equal(dom.container.querySelectorAll('.session-status-count').length,4);
});
