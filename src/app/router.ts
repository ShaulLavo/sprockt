import { createSignal, type Accessor } from "solid-js";
import { parseRoute, routePath, type Route } from "./routes";

const [route, setRoute] = createSignal<Route>(parseRoute(location.pathname));

addEventListener("popstate", () => setRoute(parseRoute(location.pathname)));

export const currentRoute: Accessor<Route> = route;

/** Client-side navigation: the page is not reloaded, so a running workspace survives only if kept. */
export function navigate(to: Route): void {
  history.pushState(null, "", routePath(to));
  setRoute(to);
}
