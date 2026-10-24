import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeConversationImages } from "../src/conversationImages.ts";

test("image selectors reject paths, URLs and malformed indices", () => {
  const id = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  assert.deepEqual(normalizeConversationImages([
    {id:"https://example.invalid/a.png"}, {id:"../../private"}, {id:id.replace(".0.0.",".0.16.")},
    {id,path:"/private/image.png",data:"private"}, null,
  ]),[{id}]);
});
