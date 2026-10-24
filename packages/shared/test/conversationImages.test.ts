import { strict as assert } from "node:assert";
import { test } from "node:test";
import { conversationImageFilename, normalizeConversationImages } from "../src/conversationImages.ts";

test("image selectors reject paths, URLs and malformed indices", () => {
  const id = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  assert.deepEqual(normalizeConversationImages([
    {id:"https://example.invalid/a.png"}, {id:"../../private"}, {id:id.replace(".0.0.",".0.16.")},
    {id,path:"/private/image.png",data:"private"}, null,
  ]),[{id}]);
});

test("image selectors accept the daemon's quoted upload reference form", () => {
  const id = `${"a".repeat(16)}.0.u0-0.${"b".repeat(32)}`;
  assert.deepEqual(normalizeConversationImages([{id}]), [{id}]);
  for (const selector of ["u-0", "u0-", "u00-1", "u18446744073709551616-0", "u0-18446744073709551616"]) {
    assert.deepEqual(normalizeConversationImages([{id: `${"a".repeat(16)}.0.${selector}.${"b".repeat(32)}`}]), []);
  }
});

test("image filenames preserve Unicode and spaces but cannot contain paths or controls", () => {
  assert.equal(conversationImageFilename('inline; filename="original plot.png"'),"original plot.png");
  assert.equal(conversationImageFilename("inline; filename=fallback.png; filename*=UTF-8''%E5%9C%96.png"),"圖.png");
  for (const header of [null,"inline","inline; filename=../private.png","inline; filename*=UTF-8''%0a.png",'inline; filename="C:\\\\private.png"',"inline; filename*=UTF-8''%zz",`inline; filename=${"a".repeat(1024)}`]) {
    assert.equal(conversationImageFilename(header),undefined,header ?? "missing");
  }
});
