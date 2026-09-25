// Moves the pinned Codex CLI and Claude Agent SDK / Claude Code to the given
// versions (default: npm latest) and regenerates every derived artifact:
// lockfiles, vendored Codex assets, generated protocol, Rust toolchain and
// third-party notices. Version-keyed overlays are registered for the new Codex
// release; their find/replace guards fail loudly when upstream changed shape,
// and the caller must run the full check/test/relay suite before releasing.
//
// Usage: node scripts/bump-runtimes.mjs [--only codex|claude] [--codex X.Y.Z] [--claude-sdk X.Y.Z]
//        [--github-output FILE]
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./codex-assets.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const run = (command, commandArgs, stdio = "inherit") =>
  execFileSync(command, commandArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", stdio, "inherit"] });
const capture = (command, commandArgs) => run(command, commandArgs, "pipe");
const npmView = (spec, field) => {
  const value = JSON.parse(capture("npm", ["view", spec, field, "--json"]));
  return Array.isArray(value) ? value.at(-1) : value;
};
const STABLE = /^\d+\.\d+\.\d+$/u;
const read = (path) => readFileSync(join(root, path), "utf8");
const write = (path, content) => writeFileSync(join(root, path), content);
const readJson = (path) => JSON.parse(read(path));
const writeJson = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`);

function replaceIn(path, find, replace) {
  const content = read(path);
  const updated = content.replace(find, replace);
  if (updated === content) throw new Error(`Expected ${String(find)} in ${path}.`);
  write(path, updated);
}

// Excluded files are regenerated below or keep historical version keys.
const CODEX_VERSION_EXCLUDES = new Set([
  "package-lock.json",
  "relay/Cargo.lock",
  "legal/THIRD_PARTY_NOTICES.md",
  "scripts/codex-assets.mjs",
  "scripts/generate-response-item-schema.mjs",
]);

function replaceCodexVersion(from, to) {
  const pattern = new RegExp(`(?<![\\d.])${from.replaceAll(".", "\\.")}(?![\\d])`, "gu");
  const files = capture("git", ["grep", "-l", "-F", "--", from]).trim().split("\n").filter(Boolean)
    .filter((path) => !CODEX_VERSION_EXCLUDES.has(path) && !path.startsWith("src/codex/generated/"));
  for (const path of files) write(path, read(path).replace(pattern, to));
  return files;
}

function syncRustToolchain(tag) {
  const upstream = capture("curl", [
    "-fsSL", `https://raw.githubusercontent.com/openai/codex/${tag}/codex-rs/rust-toolchain.toml`,
  ]);
  const channel = /^channel\s*=\s*"(\d+\.\d+)\.\d+"/mu.exec(upstream);
  if (!channel) throw new Error(`Cannot read the Rust channel of Codex ${tag}.`);
  const full = /^channel\s*=\s*"([^"]+)"/mu.exec(upstream)[1];
  if (read("rust-toolchain.toml").includes(`channel = "${full}"`)) return undefined;
  replaceIn("rust-toolchain.toml", /^channel = "[^"]+"/mu, `channel = "${full}"`);
  replaceIn("release/Dockerfile.relay", /^FROM rust:\d+\.\d+-bullseye/mu, `FROM rust:${channel[1]}-bullseye`);
  return full;
}

const pkg = readJson("package.json");
const current = {
  codex: pkg.dependencies["@openai/codex"],
  sdk: pkg.dependencies["@anthropic-ai/claude-agent-sdk"],
};
const only = option("--only");
if (only !== undefined && only !== "codex" && only !== "claude") throw new Error("--only must be codex or claude.");
const target = {
  codex: only === "claude" ? current.codex : option("--codex") ?? npmView("@openai/codex", "dist-tags.latest"),
  sdk: only === "codex" ? current.sdk : option("--claude-sdk") ?? npmView("@anthropic-ai/claude-agent-sdk", "dist-tags.latest"),
};
for (const [name, version] of Object.entries(target)) {
  if (!STABLE.test(version)) throw new Error(`Refusing non-stable ${name} version ${version}.`);
}

const changes = [];
if (target.sdk !== current.sdk) {
  const claudeCode = npmView(`@anthropic-ai/claude-agent-sdk@${target.sdk}`, "claudeCodeVersion");
  if (!STABLE.test(claudeCode ?? "")) throw new Error(`SDK ${target.sdk} declares no stable claudeCodeVersion.`);
  const compatibility = readJson("config/compatibility.json");
  replaceIn(
    "README.md",
    `| \`${compatibility.claudeAgentSdk}\` / \`${compatibility.claudeCode}\` |`,
    `| \`${target.sdk}\` / \`${claudeCode}\` |`,
  );
  pkg.dependencies["@anthropic-ai/claude-agent-sdk"] = target.sdk;
  writeJson("package.json", pkg);
  writeJson("config/compatibility.json", { ...compatibility, claudeAgentSdk: target.sdk, claudeCode });
  changes.push(`Claude Agent SDK ${current.sdk} -> ${target.sdk} (Claude Code ${claudeCode})`);
}

if (target.codex !== current.codex) {
  const tag = `rust-v${target.codex}`;
  const ref = capture("git", ["ls-remote", "https://github.com/openai/codex.git", `refs/tags/${tag}`]).split(/\s+/u)[0];
  if (!/^[0-9a-f]{40}$/u.test(ref ?? "")) throw new Error(`Codex tag ${tag} was not found.`);
  replaceIn(
    "scripts/codex-assets.mjs",
    "\n};\n\nexport function pinnedCodexRef",
    `\n  // ${tag}\n  "${ref}": RESULT_AS_VALUE_OVERLAY,\n};\n\nexport function pinnedCodexRef`,
  );
  replaceIn(
    "scripts/generate-response-item-schema.mjs",
    `  "${current.codex}": RESPONSE_ITEM_SERDE_OVERLAY,\n};`,
    `  "${current.codex}": RESPONSE_ITEM_SERDE_OVERLAY,\n  "${target.codex}": RESPONSE_ITEM_SERDE_OVERLAY,\n};`,
  );
  replaceCodexVersion(current.codex, target.codex);
  writeJson("config/compatibility.json", { ...readJson("config/compatibility.json"), codexGitRevision: ref });
  run(process.execPath, [join(root, "scripts", "update-codex-pin.mjs"), ref]);
  const toolchain = syncRustToolchain(tag);
  changes.push(`Codex ${current.codex} -> ${target.codex} (${tag})${toolchain ? `, Rust ${toolchain}` : ""}`);
}

const summary = changes.join("; ");
if (changes.length > 0) {
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  if (target.codex !== current.codex) {
    run("npm", ["run", "generate:protocol"]);
    run("cargo", ["update", "--manifest-path", "relay/Cargo.toml", "--workspace"]);
  }
  run("npm", ["run", "generate:notices"]);
}
console.log(summary || `Codex ${current.codex} and Claude Agent SDK ${current.sdk} are current.`);
const githubOutput = option("--github-output");
if (githubOutput) {
  appendFileSync(githubOutput, `changed=${changes.length > 0}\nsummary=${summary}\ncodex=${target.codex}\nsdk=${target.sdk}\n`);
}
