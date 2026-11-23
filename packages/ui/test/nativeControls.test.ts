import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSync, Visitor, type JSXAttribute } from "oxc-parser";

const source = new URL("../src/", import.meta.url);
const styledInputTypes = new Set(["email", "password", "search", "tel", "text", "url"]);
const nonvisualInputTypes = new Set(["hidden"]);
const themeClasses: Readonly<Record<string, readonly string[]>> = {
  checkbox: ["control-checkbox"],
  color: ["settings-color-input"],
  file: ["conversation-file-input", "terminal-file-input"],
};

function attributeValue(attribute: JSXAttribute): string | undefined {
  const value = attribute.value;
  const literal = value?.type === "JSXExpressionContainer" ? value.expression : value;
  if (literal?.type === "Literal" && typeof literal.value === "string") return literal.value;
}

test("native form controls use the shared theme or an explicitly styled trigger", () => {
  const offenders: string[] = [];
  const files = readdirSync(source, { recursive: true }).filter(file => /\.[jt]sx?$/.test(file)).sort();
  for (const file of files) {
    const text = readFileSync(new URL(file, source), "utf8");
    const { program, errors } = parseSync(file, text);
    assert.deepEqual(errors, [], `parse ${file}`);
    new Visitor({
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        if (tag !== "input" && tag !== "select") return;
        const report = (reason: string) => offenders.push(`${file}:${text.slice(0, node.start).split("\n").length}: ${reason}`);
        if (tag === "select") {
          if (file !== "AppSelect.tsx") report("use AppSelect for a themed select popup");
          return;
        }
        const attrs = new Map(node.attributes.flatMap(attr =>
          attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" ? [[attr.name.name, attr]] : []));
        const type = attrs.has("type") ? attributeValue(attrs.get("type")!) : "text";
        if (!type) {
          report("declare a static input type so its theme coverage can be checked");
          return;
        }
        if (styledInputTypes.has(type) || nonvisualInputTypes.has(type)) return;
        // These existing checkboxes have their own themed option rows and focus rings.
        const description = attrs.get("aria-describedby");
        if (file === "Dashboard.tsx" && type === "checkbox" && description &&
          ["close-session-star-description", "close-session-delete-description"].includes(attributeValue(description) ?? "")) return;
        const classAttr = attrs.get("className");
        const classes = classAttr ? (attributeValue(classAttr) ?? "").split(/\s+/) : [];
        if (!themeClasses[type]?.some(name => classes.includes(name))) {
          report(`add theme coverage for input type="${type}"`);
        }
      },
    }).visit(program);
  }
  assert.deepEqual(offenders, []);
});
