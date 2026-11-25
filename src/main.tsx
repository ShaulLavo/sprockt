import { render } from "solid-js/web";
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
render(() => <App />, root);
