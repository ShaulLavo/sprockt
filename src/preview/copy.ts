// Preview pane strings, synced with copy/ui.json. `{…}` marks a value filled in at use.
export const ui = {
  preview: "Preview",
  back: "Back",
  forward: "Forward",
  reload: "Reload preview",
  url: "Preview URL",
  switchPort: "Switch preview port",
  /** A port, as the picker and the title bar's dev server pill both print it. */
  port: ":{port}",
  serverRunning: "Dev server running on port {port}",
  serverElsewhere: "Dev server running on port {port} in another tab",
  stopElsewhere: "Dev server is running in another tab. Stop it there.",
  serverStarting: "Starting",
  stopAction: "Stop dev server",
  viewport: "Preview viewport",
  desktop: "Desktop viewport",
  tablet: "Tablet viewport",
  phone: "Phone viewport",
  errors: "Preview errors: {count}",
  startServer: "Start dev server",
  stopServer: "Stop dev server on port {port}",
  selectTarget: "Select workspace app or script",
  openInTab: "Open preview in new tab",
  unavailable:
    "Previews are unavailable in this window. Enable service workers or open Sprockt in a regular window.",
  starting: "Starting the dev server. The preview will load once a port opens.",
  empty: "No dev server is running yet. Start one in the terminal to preview it here.",
  /** The same moment for a project the pane can start itself; the Start button follows it. */
  emptyStartable: "No dev server is running yet. Start one to preview this project.",
  nothingToStart: "No dev script or server entry file found in this project.",
  serverEnded: "The dev server stopped.",
  restartHeld:
    "Auto-restart paused after {restarts} restarts in {seconds} seconds, so your latest edit is not live yet. Save again in a moment, or stop and start the server.",
} as const;
