import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [reportsDir, outputPath, version = "unknown"] = process.argv.slice(2);
if (!reportsDir || !outputPath) throw new Error("Usage: node report.mjs REPORTS_DIR OUTPUT.md [VERSION]");

const reports = readdirSync(reportsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(reportsDir, name), "utf8")));

const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const details = (value) => escape(JSON.stringify(value));
const lines = [
  `# Container E2E — ${version}`,
  "",
  "## Image build",
  "",
  "The image used `node:22-bookworm` with a non-root user. It installed the main and Linux x64 GNU relay tarballs together with `npm install --prefix <stage> --include=optional --ignore-scripts --save=false`, then invoked the staged `ccodex setup --staged <stage> --version <version>`. This is the same staged activation path used by `scripts/install.sh`; ordinary dependencies, including pinned `@openai/codex` 0.153.3, were resolved by npm during the image build.",
  "",
  "No credentials or live host sockets/state were mounted. Every scenario used an independent writable copy of the Claude projects directory and a fresh container HOME.",
  "",
  "## Scenario matrix",
  "",
  "| Scenario | Result | Checks passed |",
  "|---|---:|---:|",
];

for (const report of reports) {
  lines.push(`| ${escape(report.scenario)} | ${report.ok ? "PASS" : "FAIL"} | ${report.checks.filter((check) => check.ok).length}/${report.checks.length} |`);
}

for (const report of reports) {
  lines.push("", `## ${report.scenario}`, "", "| Check | OK | Details |", "|---|---:|---|");
  for (const check of report.checks) {
    lines.push(`| ${escape(check.name)} | ${check.ok ? "yes" : "no"} | ${details(check.details)} |`);
  }
  lines.push("", "### Timings", "", "```json", JSON.stringify(report.timings, null, 2), "```");
}

const failures = reports.flatMap((report) => report.checks
  .filter((check) => !check.ok)
  .map((check) => ({ scenario: report.scenario, check })));
const evidence = reports.flatMap((report) => (report.evidence ?? []).map((item) => ({ scenario: report.scenario, item })));
lines.push("", "## Product findings", "");
if (failures.length === 0) {
  lines.push("No product failures were observed.");
} else {
  for (const failure of failures) {
    lines.push(`- **${escape(failure.scenario)} / ${escape(failure.check.name)}** — ${details(failure.check.details)}`);
  }
}
if (evidence.length > 0) {
  lines.push("", "### Failure evidence", "");
  for (const { scenario, item } of evidence) lines.push(`- ${escape(scenario)}: \`${details(item)}\``);
}

lines.push("", "## Not verified", "");
const incomplete = reports.filter((report) => report.checks.some((check) => check.name === "scenario_completed" && !check.ok));
lines.push("Real model turns and authenticated provider operations were out of scope; no credentials were supplied.");
if (incomplete.length > 0) {
  lines.push(`Later checks in ${incomplete.map(({ scenario }) => scenario).join(", ")} could not run after the recorded blocking failure.`);
}
lines.push("");

writeFileSync(outputPath, lines.join("\n"), "utf8");
process.stdout.write(`${basename(outputPath)}\n`);
