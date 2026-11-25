// Leaving the importer or a share link for the new workspace replaces the history entry, so
// Back returns to where the visitor came from instead of importing the repository again.
import { routePath, type Route } from "../app/routes";

export function replaceRoute(to: Route): void {
  history.replaceState(null, "", routePath(to));
  // The router follows `popstate`; replaceState does not fire one.
  dispatchEvent(new PopStateEvent("popstate"));
}
