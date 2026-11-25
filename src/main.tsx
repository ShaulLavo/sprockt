import { render } from "solid-js/web";
import { App } from "./app/App";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("index.html has no #app element");
render(() => <App />, root);
