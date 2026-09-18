#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output_dir=${1:-"$repo_root/experiments/2026_09_18_claude_native_source_of_truth/outputs/container_e2e"}

version=${CCODEX_E2E_VERSION:-0.4.26-dev.20260918.1}
main_tgz=${CCODEX_E2E_MAIN_TGZ:-"$HOME/.ccodex/dev-packages/gkorepanov-ccodex-$version.tgz"}
relay_tgz=${CCODEX_E2E_RELAY_TGZ:-"$HOME/.ccodex/dev-packages/gkorepanov-ccodex-relay-linux-x64-gnu-$version.tgz"}
claude_projects=${CCODEX_E2E_CLAUDE_PROJECTS:-"$HOME/.claude/projects"}
state_backup=${CCODEX_E2E_STATE_BACKUP:-"$HOME/.ccodex/state/backups/state-pre-native-2026-09-18.sqlite"}
handoffs_backup=${CCODEX_E2E_HANDOFFS_BACKUP:-"$HOME/.ccodex/state/backups/handoffs-pre-native-2026-09-18.sqlite"}

for required in "$main_tgz" "$relay_tgz" "$claude_projects" "$state_backup" "$handoffs_backup"; do
  if [ ! -e "$required" ]; then
    echo "missing required E2E input" >&2
    exit 2
  fi
done

mkdir -p "$output_dir"
work_dir=$(mktemp -d /tmp/ccodex-container-e2e.XXXXXX)
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

build_context="$work_dir/build"
mkdir -p "$build_context"
cp "$repo_root/scripts/e2e/Containerfile" "$build_context/Containerfile"
cp -a "$repo_root/scripts/e2e/lib" "$build_context/lib"
cp -a "$repo_root/scripts/e2e/scenarios" "$build_context/scenarios"
cp "$repo_root/scripts/e2e/report.mjs" "$build_context/report.mjs"
cp "$repo_root/scripts/e2e/prepare.mjs" "$build_context/prepare.mjs"
cp "$main_tgz" "$build_context/main.tgz"
cp "$relay_tgz" "$build_context/relay.tgz"

uid=$(id -u)
gid=$(id -g)
image="localhost/ccodex-e2e:${version}"
podman build --pull=false \
  --build-arg E2E_UID="$uid" \
  --build-arg E2E_GID="$gid" \
  --build-arg MAIN_TGZ=main.tgz \
  --build-arg RELAY_TGZ=relay.tgz \
  --build-arg CCODEX_VERSION="$version" \
  --tag "$image" "$build_context"

base_projects="$work_dir/base-projects"
mkdir -p "$base_projects"
cp -a "$claude_projects/." "$base_projects/"

overall=0
for scenario in fresh_install migration restart_determinism; do
  scenario_home="$work_dir/$scenario/home"
  mkdir -p "$scenario_home/.claude/projects" "$scenario_home/.ccodex/state"
  cp -a --reflink=auto "$base_projects/." "$scenario_home/.claude/projects/"
  if [ "$scenario" = migration ]; then
    cp "$state_backup" "$scenario_home/.ccodex/state/state.sqlite"
    cp "$handoffs_backup" "$scenario_home/.ccodex/state/handoffs.sqlite"
  fi

  json_tmp="$work_dir/$scenario.json"
  stderr_tmp="$work_dir/$scenario.stderr"
  set +e
  podman run --rm --userns=keep-id --user 0:0 \
    --volume "$scenario_home:/work/home:Z" \
    --env HOME=/work/home \
    --env CCODEX_HOME=/work/home/.ccodex \
    --env CODEX_HOME=/work/home/.codex \
    --env CLAUDE_CONFIG_DIR=/work/home/.claude \
    --env CCODEX_RPC_CAPTURE=0 \
    --env CCODEX_LOG_PROMPTS=0 \
    --env CCODEX_DEBUG_CAPTURE=0 \
    --env E2E_UID="$uid" \
    --env E2E_GID="$gid" \
    --env SCENARIO="$scenario" \
    --env PATH=/work/home/.ccodex/bin:/usr/local/bin:/usr/bin:/bin \
    "$image" sh -eu -c 'cp -a -n /opt/e2e-home/. "$HOME"/; node /opt/e2e/prepare.mjs; exec /usr/sbin/runuser -u e2e --preserve-environment -- node "/opt/e2e/scenarios/$SCENARIO.mjs"' \
    >"$json_tmp" 2>"$stderr_tmp"
  container_status=$?
  set -e

  if node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!value.scenario || !Array.isArray(value.checks)) process.exit(1)' "$json_tmp" 2>/dev/null; then
    cp "$json_tmp" "$output_dir/$scenario.json"
  else
    printf '%s\n' "{\"scenario\":\"$scenario\",\"ok\":false,\"checks\":[{\"name\":\"container_execution\",\"ok\":false,\"details\":{\"exitCode\":$container_status,\"error\":\"container produced no valid JSON report; stderr withheld for privacy\"}}],\"timings\":{},\"evidence\":[]}" >"$output_dir/$scenario.json"
  fi
  if [ "$container_status" -ne 0 ] || ! node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ok ? 0 : 1)' "$output_dir/$scenario.json"; then
    overall=1
  fi
done

node "$repo_root/scripts/e2e/report.mjs" "$output_dir" "$output_dir/summary.md" "$version" >/dev/null
exit "$overall"
