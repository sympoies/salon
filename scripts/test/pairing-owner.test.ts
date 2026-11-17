import test from "node:test";
import { DeviceCredentialStore } from "../../packages/edge/src/deviceCredentials.ts";
import { verifyOwnerPairingLink } from "../../packages/ui/test/support/ownerPairing.ts";

test("owner link from a real pairing response round trips through native import", async () => {
  const store = new DeviceCredentialStore(":memory:", () => "main-fixture", () => true);
  const pair = store.create("owner", "main-fixture", undefined, 300_000);
  store.close();
  await verifyOwnerPairingLink(pair);
});
