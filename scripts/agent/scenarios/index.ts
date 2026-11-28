import { githubImportAndShareScenario } from "./github-import-and-share.ts";
import { githubRealRepoScenario } from "./github-real-repo.ts";
import { landingDesktopMobileScenario } from "./landing-desktop-mobile.ts";
import { mobileWorkbenchScenario } from "./mobile-workbench.ts";
import { starterDevServerScenario } from "./starter-dev-server.ts";
import type { AgentScenario } from "./types.ts";
import { workbenchTabsAndExplorerScenario } from "./workbench-tabs-and-explorer.ts";

export const SCENARIOS: readonly AgentScenario[] = [
  landingDesktopMobileScenario,
  starterDevServerScenario,
  workbenchTabsAndExplorerScenario,
  mobileWorkbenchScenario,
  githubImportAndShareScenario,
  githubRealRepoScenario,
];

export function findScenario(name: string): AgentScenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
