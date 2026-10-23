import { mountApp } from "@agent-console/ui/app";
import type { UiExtension } from "@agent-console/ui/extensions";

const extension: UiExtension = {
  id: "fixture",
  settingsPanels: [{ id: "details", render: () => <p>Installed package consumer</p> }],
};
mountApp(document.getElementById("root"), { extensions: [extension] });
