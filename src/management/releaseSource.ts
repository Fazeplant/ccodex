import { compatibilityManifest } from "../compatibility/probe.js";
import { runtimePlatformKey } from "../runtime/dependencies.js";

// This fork ships through GitHub Releases instead of the npm registry. Every
// release attaches the npm-packed main and relay tarballs, so setup and update
// install the exact tarball pair for one version and platform.
export const RELEASE_REPOSITORY = process.env.CCODEX_RELEASE_REPO ?? "Fazeplant/ccodex";

const VERSION = /^\d+\.\d+\.\d+(?:[-+].+)?$/u;

function tarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function releaseTarballSpecs(
  version: string,
  platformKey = runtimePlatformKey(),
  repository = RELEASE_REPOSITORY,
): readonly [main: string, relay: string] {
  const relay = compatibilityManifest().relayPackages[platformKey];
  if (!relay) throw new Error(`CCodex has no relay package for platform ${platformKey}.`);
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return [`${base}/${tarballName("@gkorepanov/ccodex", version)}`, `${base}/${tarballName(relay, version)}`];
}

export async function latestReleaseVersion(repository = RELEASE_REPOSITORY): Promise<string> {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ccodex-update" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${url}`);
  const tag = ((await response.json()) as { tag_name?: unknown }).tag_name;
  const version = typeof tag === "string" ? tag.replace(/^v/u, "") : "";
  if (!VERSION.test(version)) throw new Error(`GitHub returned an invalid latest release tag: ${String(tag)}`);
  return version;
}
