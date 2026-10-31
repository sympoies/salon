# UI package

`mountApp` accepts an optional `appName` for the rendered application title and
document title. When omitted, the rendered title remains `Agent Console`.

```ts
import { mountApp } from "@agent-console/ui/app";

mountApp(document.getElementById("root"), { appName: "Agent Console Test" });
```

`appIcon` (`{ dark, light }` URLs) replaces the header mark in the dashboard,
login and settings; `dark` is used on dark surfaces and `light` on light and
Paper surfaces. When omitted the Salon mark is shown.
