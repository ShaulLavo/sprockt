import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { registerLanguageServers } from "./lsp";
import { retirePreviewsIfOff } from "./preview/startup";
import "./styles.css";
import { applyStoredTheme } from "./workbench/theme";

applyStoredTheme();
retirePreviewsIfOff();

const root = document.getElementById("app");
if (!root) throw new Error("index.html has no #app element");
registerLanguageServers();
// No StrictMode: its doubled effects would start a second Waffle runtime, and the page allows
// one. Components that boot or attach still clean up after themselves on unmount.
createRoot(root).render(<App />);
