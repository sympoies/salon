import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());
const ref = (number: number, provider = "github") => ({ provider, repository: "example/project", number });

test("work references follow the current session, deduplicate the title and limit issues", async () => {
  const { SessionWorkRefs } = await ssr.loadModule<typeof import("../src/SessionWorkRefs.tsx")>("/src/SessionWorkRefs.tsx");
  const render = (title: string, work?: { program: ReturnType<typeof ref> | null; issues: ReturnType<typeof ref>[]; inherited: boolean }) =>
    renderToStaticMarkup(createElement(SessionWorkRefs, { title, work }));
  assert.equal(render("Review"), "");
  assert.equal(render("Review", { program: null, issues: [], inherited: false }), "");
  const initial = render("Review", { program: ref(1), issues: [ref(2), ref(3, "other"), ref(4), ref(5)], inherited: false });
  assert.match(initial, /project#1/);
  assert.match(initial, /href="https:\/\/github.com\/example\/project\/issues\/2"/);
  assert.match(initial, /project#3/);
  assert.doesNotMatch(initial, /issues\/3/);
  assert.match(initial, /\+1/);
  assert.doesNotMatch(initial, /project#5/);
  const updated = render("Review project#2", { program: null, issues: [ref(2), ref(8)], inherited: false });
  assert.doesNotMatch(updated, /project#2/);
  assert.match(updated, /project#8/);
  assert.equal(render("Review", { program: null, issues: [], inherited: false }), "");
  assert.match(render("Review #20", { program: null, issues: [ref(2)], inherited: false }), /project#2/);
});


test("clicking a GitHub work reference opens it externally without selecting the card", async () => {
  const window = new Window({url:"http://localhost"});
  const saved = {window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
  const opened: string[] = [];
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  let cardClicks = 0;
  try {
    const { SessionWorkRefs } = await ssr.loadModule<typeof import("../src/SessionWorkRefs.tsx")>("/src/SessionWorkRefs.tsx");
    await act(async () => root.render(createElement("div",{onClick:() => { cardClicks++; }},
      createElement(SessionWorkRefs,{work:{program:null,issues:[ref(2),ref(3,"other")],inherited:false}}))));
    const link = window.document.querySelector("a")!;
    const event = new window.MouseEvent("click",{bubbles:true,cancelable:true});
    await act(async () => { link.dispatchEvent(event); });
    assert.equal(event.defaultPrevented,true);
    assert.deepEqual(opened,["https://github.com/example/project/issues/2"]);
    assert.equal(cardClicks,0);
    assert.equal(window.document.querySelectorAll("a").length,1);
    assert.match(window.document.querySelector(".session-work-refs")!.textContent!,/project#3/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis,saved);
    window.close();
  }
});
