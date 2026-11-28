import type { Page } from "@playwright/test";

export function startBootTiming() {
  const started = performance.now();
  const milestones: Record<string, number> = {};
  return {
    mark(name: string): void {
      milestones[name] = Math.round(performance.now() - started);
    },
    async report(page: Page) {
      const resources = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
          .filter((entry) =>
            /\.wasm$|\/api\/github\/|\/assets\/(?:boot-|.*worker)/.test(new URL(entry.name).pathname),
          )
          .map((entry) => ({
            path: new URL(entry.name).pathname,
            startMs: Math.round(entry.startTime),
            firstByteMs: Math.round(entry.responseStart),
            endMs: Math.round(entry.responseEnd),
            encodedBytes: entry.encodedBodySize,
            decodedBytes: entry.decodedBodySize,
          })),
      );
      return { milestones, resources };
    },
  };
}
