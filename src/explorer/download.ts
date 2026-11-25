/** Hands `blob` to the browser as a download named `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by the time this fires; revoking sooner can cancel it in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
