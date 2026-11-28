import { importRealRepo } from "../scripts/agent/scenarios/github-real-repo";
import { test } from "./helpers";

test("a real GitHub repo imports, installs with Bun and starts its preview", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "A single real GitHub and npm request flow covers the network integration",
  );
  test.setTimeout(300_000);
  if (!baseURL) throw new Error("The import requires the running Sprockt server");
  const report = await importRealRepo(page, baseURL, 120_000);
  await test.info().attach("github-cold-boot", {
    body: JSON.stringify(report),
    contentType: "application/json",
  });
});
