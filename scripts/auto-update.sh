#!/bin/sh
# Daily runtime auto-update, run by .github/workflows/auto-update.yml on main.
#
# Each runtime (claude, then codex) is bumped to npm latest and verified on its
# own. A green bump is committed to main. A red bump is committed to
# auto/<runtime>-<version>, pushed and proposed as a PR, and main is reset so
# the other runtime still ships; while that branch exists the version is not
# retried. When anything was committed, the fork version <upstream>-orbital.<n>
# is bumped, tagged and pushed, and tag=<tag> is written to $GITHUB_OUTPUT.
set -eu

output=${GITHUB_OUTPUT:-/dev/null}
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
main_branch=$(git rev-parse --abbrev-ref HEAD)
committed=0

# Chained with && because attempt() runs it inside an `if`, where set -e is off.
verify() {
  npm ci --ignore-scripts \
    && npm run check \
    && npm run check:codex-assets \
    && npm run check:protocol-generated \
    && npx vitest run --config config/vitest.config.ts \
    && npm run test:contracts \
    && node release/verify-packages.mjs \
    && { [ "$1" != codex ] || cargo test --manifest-path relay/Cargo.toml --locked --quiet; }
}

attempt() {
  runtime=$1
  if [ "$runtime" = codex ]; then
    package=@openai/codex
    flag=--codex
  else
    package=@anthropic-ai/claude-agent-sdk
    flag=--claude-sdk
  fi
  current=$(node -p "require('./package.json').dependencies['$package']")
  target=$(npm view "$package@latest" version)
  if [ "$current" = "$target" ]; then
    printf '%s %s is current.\n' "$package" "$current"
    return 0
  fi
  branch="auto/$runtime-$target"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    printf '%s %s awaits the open %s PR; not retrying.\n' "$package" "$target" "$branch"
    return 0
  fi

  base=$(git rev-parse HEAD)
  log=$(mktemp)
  printf '::group::Bump %s %s -> %s\n' "$package" "$current" "$target"
  if { node scripts/bump-runtimes.mjs --only "$runtime" "$flag" "$target" && verify "$runtime"; } >"$log" 2>&1; then
    cat "$log"
    echo '::endgroup::'
    git add -A
    git commit --quiet -m "Bump $package $current -> $target" -m "Verified by $run_url"
    committed=1
    return 0
  fi
  cat "$log"
  echo '::endgroup::'
  printf '::warning::%s %s failed verification; proposing %s.\n' "$package" "$target" "$branch"
  git checkout --quiet -B "$branch"
  git add -A
  git commit --quiet --allow-empty -m "WIP: bump $package $current -> $target (verification failed)" \
    -m "Automated bump from $run_url needs manual porting before release."
  git push --quiet --force origin "$branch"
  body=$(printf 'Automated bump of `%s` from `%s` to `%s` failed verification in %s.\n\nThis usually means an upstream protocol/API change that CCodex must be ported to. Fix it on this branch; merging to main releases it on the next auto-update run.\n\n<details><summary>Last log lines</summary>\n\n```\n%s\n```\n</details>\n' \
    "$package" "$current" "$target" "$run_url" "$(tail -n 80 "$log")")
  gh pr create --base "$main_branch" --head "$branch" --title "Bump $package to $target (needs porting)" --body "$body"
  git checkout --quiet "$main_branch"
  git reset --quiet --hard "$base"
  npm ci --ignore-scripts >/dev/null
}

attempt claude
attempt codex

if [ "$committed" = 1 ]; then
  next=$(node -p "const v=require('./package.json').version;const m=/^(.*)-orbital\.(\d+)$/.exec(v);m?m[1]+'-orbital.'+(Number(m[2])+1):v+'-orbital.1'")
  node release/set-version.mjs "$next"
  git add -A
  git commit --quiet -m "Release v$next" -m "$(git log --format='- %s' "origin/$main_branch..HEAD" | grep -v '^- Release ')"
  git tag -a "v$next" -m "Release v$next"
  git push --quiet --atomic origin "HEAD:$main_branch" "v$next"
  printf 'tag=v%s\n' "$next" >> "$output"
fi
