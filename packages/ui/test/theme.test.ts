import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import {
  THEME_META_COLORS,
  THEME_MODE_STORAGE_KEY,
  createThemeController,
  loadThemeMode,
  resolveTheme,
  saveThemeMode,
} from "../src/theme.ts";
import { setPrincipalStorageNamespace, type StorageLike } from "../src/storage.ts";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function fakeMedia(initialDark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media = {
    matches: initialDark,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => void listeners.delete(listener),
  };
  return {
    queries: [] as string[],
    listeners,
    matchMedia(query: string) { this.queries.push(query); return media as unknown as MediaQueryList; },
    setDark(dark: boolean) { media.matches = dark; for (const listener of [...listeners]) listener({ matches: dark }); },
  };
}

function documentWithMeta(meta = true): Document {
  const { document } = new Window({ url: "http://localhost" });
  if (meta) document.head.innerHTML = '<meta name="theme-color" content="#011627">';
  return document as unknown as Document;
}
const themeColor = (document: Document) => document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

test("System follows the OS preference while Dark and Paper ignore it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "paper");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("paper", true), "paper");
});

test("the stored choice defaults to System and survives only valid values, per device", () => {
  const storage = memoryStorage();
  assert.equal(loadThemeMode(storage), "system");
  storage.values.set(THEME_MODE_STORAGE_KEY, "sepia");
  assert.equal(loadThemeMode(storage), "system");
  setPrincipalStorageNamespace("fixture-principal");
  try {
    assert.equal(saveThemeMode("paper", storage), true);
    assert.equal(storage.values.get(THEME_MODE_STORAGE_KEY), "paper", "the device choice is not scoped to a signed-in principal");
    assert.equal(loadThemeMode(storage), "paper");
  } finally {
    setPrincipalStorageNamespace(null);
  }
  const unavailable: StorageLike = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadThemeMode(unavailable), "system");
  assert.equal(saveThemeMode("dark", unavailable), false);
});

test("the controller applies the resolved theme and theme-color at start", () => {
  const document = documentWithMeta();
  const media = fakeMedia(false);
  const controller = createThemeController({ document, matchMedia: q => media.matchMedia(q), storage: memoryStorage() });
  assert.deepEqual(media.queries, ["(prefers-color-scheme: dark)"]);
  assert.deepEqual(controller.getState(), { mode: "system", resolved: "paper" });
  assert.equal(document.documentElement.getAttribute("data-theme"), "paper");
  assert.equal(document.documentElement.getAttribute("data-theme-mode"), "system");
  assert.equal(themeColor(document), THEME_META_COLORS.paper);
  assert.equal(THEME_META_COLORS.paper, "#f4f3ed");
});

test("switching applies live, persists, notifies, and creates a missing theme-color meta", () => {
  const document = documentWithMeta(false);
  const storage = memoryStorage();
  const controller = createThemeController({ document, matchMedia: q => fakeMedia(false).matchMedia(q), storage });
  const seen: string[] = [];
  controller.subscribe(() => seen.push(controller.getState().resolved));
  controller.setMode("dark");
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(document.documentElement.getAttribute("data-theme-mode"), "dark");
  assert.equal(themeColor(document), THEME_META_COLORS.dark);
  assert.equal(document.querySelectorAll('meta[name="theme-color"]').length, 1);
  assert.equal(storage.values.get(THEME_MODE_STORAGE_KEY), "dark");
  controller.setMode("paper");
  assert.deepEqual(seen, ["dark", "paper"]);
  assert.equal(themeColor(document), THEME_META_COLORS.paper);
  const restored = createThemeController({ document: documentWithMeta(), matchMedia: q => fakeMedia(true).matchMedia(q), storage });
  assert.equal(restored.getState().resolved, "paper", "a stored explicit choice wins over the OS preference after restart");
});

test("System follows OS changes live; an explicit choice does not; dispose stops following", () => {
  const document = documentWithMeta();
  const media = fakeMedia(true);
  const controller = createThemeController({ document, matchMedia: q => media.matchMedia(q), storage: memoryStorage() });
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  media.setDark(false);
  assert.equal(document.documentElement.getAttribute("data-theme"), "paper");
  assert.equal(themeColor(document), THEME_META_COLORS.paper);
  controller.setMode("dark");
  media.setDark(false);
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  controller.setMode("system");
  assert.equal(document.documentElement.getAttribute("data-theme"), "paper");
  controller.dispose();
  assert.equal(media.listeners.size, 0);
});

test("without matchMedia, System keeps the existing dark appearance", () => {
  const document = documentWithMeta();
  const controller = createThemeController({ document, storage: memoryStorage() });
  assert.equal(controller.getState().resolved, "dark");
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
});

test("server rendering without a document reports the default dark look and touches nothing", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
  try {
    const { installTheme } = await import("../src/theme.ts");
    const controller = installTheme();
    assert.deepEqual(controller.getState(), { mode: "system", resolved: "dark" });
    controller.setMode("paper");
    assert.deepEqual(controller.getState(), { mode: "system", resolved: "dark" });
  } finally {
    if (saved) Object.defineProperty(globalThis, "document", saved); else delete (globalThis as { document?: unknown }).document;
  }
});
