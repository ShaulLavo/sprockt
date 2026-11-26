// Preview pane strings. Placeholders until the copy pass; `{…}` marks a value filled in at use.
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
  serverElsewhere: "Dev server running in another tab on port {port}",
  stopElsewhere: "The dev server runs in another tab. Stop it there.",
  serverStarting: "Starting",
  stopAction: "Stop dev server",
  viewport: "Viewport",
  desktop: "Desktop viewport",
  tablet: "Tablet viewport",
  phone: "Phone viewport",
  errors: "Errors in the preview: {count}",
  startServer: "Start dev server",
  stopServer: "Dev server running on port {port}. Click to stop.",
  openInTab: "Open preview in new tab",
  unavailable: "Previews are not available in this browser.",
  starting: "Starting the dev server. The preview will load once a port opens.",
  empty: "No dev server is running yet. Start one in the terminal to preview it here.",
  /** The same moment for a project the pane can start itself; the Start button follows it. */
  emptyStartable: "No dev server is running yet. Start it to preview this project here.",
  nothingToStart: "Nothing to start in this project.",
  serverEnded: "The dev server stopped. Its last output:",
  restartHeld:
    "The server was restarted {restarts} times in {seconds} seconds, so your last change is not in it yet. Save again in a moment, or stop and start the server.",
} as const;
