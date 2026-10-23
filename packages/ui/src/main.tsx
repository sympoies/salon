import { mountApp } from "./mountApp.tsx";

// Core's own entry. A distribution entry calls mountApp with its extensions.
mountApp(document.getElementById("root"), { extensions: [] });
