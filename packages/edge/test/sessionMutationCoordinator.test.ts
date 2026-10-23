import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SessionMutationCoordinator } from "../src/sessionMutationCoordinator.ts";

test("session mutation coordination releases idle unique-session state", async () => {
  const coordinator = new SessionMutationCoordinator<string>();

  await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const key = `machine\u0000session-${index}`;
    await coordinator.serializeMutation(key, async () => undefined);
    await coordinator.coalescePreview(`${key}\u0000resume`, key, async () => "preview");
  }));
  await Promise.resolve();

  assert.equal(coordinator.pendingSessionCount, 0);
  assert.equal(coordinator.pendingPreviewCount, 0);
});
