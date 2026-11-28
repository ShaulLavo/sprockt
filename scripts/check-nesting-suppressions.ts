import { existsSync, readFileSync } from "node:fs";
import { parseSync } from "vite";
import lintConfig from "../.oxlintrc.json";

const NESTING_RULES = new Set(["max-depth", "no-nested-ternary", "no-else-return"]);
const DISABLE_DIRECTIVE = /^(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)/;

function isNestingRule(rule: string): boolean {
  return NESTING_RULES.has(rule.slice(rule.lastIndexOf("/") + 1));
}

function disablesNesting(comment: string): boolean {
  const text = comment.trimStart();
  const directive = DISABLE_DIRECTIVE.exec(text);
  if (!directive) return false;
  const [rules = ""] = text.slice(directive[0].length).split("--", 1);
  const names = rules.split(/[\s,]+/).filter(Boolean);
  return names.length === 0 || names.some(isNestingRule);
}

export function nestingSuppressions(file: string, source: string): string[] {
  if (!source.includes("-disable")) return [];
  return parseSync(file, source)
    .comments.filter(({ value }) => disablesNesting(value))
    .map(({ start }) => `${file}:${source.slice(0, start).split("\n").length}`);
}

if (import.meta.main) {
  const config: {
    readonly rules: object;
    readonly overrides?: readonly { readonly files: readonly string[]; readonly rules?: object }[];
  } = lintConfig;
  const overrides = (config.overrides ?? []).flatMap(({ files, rules = {} }) =>
    Object.keys(rules)
      .filter(isNestingRule)
      .map((rule) => `.oxlintrc.json: ${rule} (${files.join(", ")})`),
  );
  const listing = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.cjs",
  ]);
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  const files = new Set(listing.stdout.toString().split("\0").filter(Boolean));
  const directives = Array.from(files)
    .filter(existsSync)
    .flatMap((file) => nestingSuppressions(file, readFileSync(file, "utf8")));
  const violations = overrides.concat(directives);
  if (violations.length > 0) {
    console.error(`Remove nesting rule suppressions:\n${violations.join("\n")}`);
    process.exitCode = 1;
  }
}
