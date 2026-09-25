#!/bin/sh
set -eu

repository=${CCODEX_RELEASE_REPO:-Fazeplant/ccodex}
home=${CCODEX_HOME:-"$HOME/.ccodex"}

fail() {
  printf 'CCodex install failed: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -ne 0 ] || fail 'do not run this installer as root or with sudo.'
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) relay=relay-darwin-arm64 ;;
  Linux:aarch64|Linux:arm64) relay=relay-linux-arm64-gnu ;;
  Linux:x86_64) relay=relay-linux-x64-gnu ;;
  *) fail "unsupported platform $(uname -s)/$(uname -m); supported: macOS arm64 or Linux glibc arm64/x64." ;;
esac
if [ "$(uname -s)" = Linux ]; then
  if (ldd --version 2>&1 || true) | grep -qi musl || ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then
    fail 'Alpine/musl is not supported; use a glibc-based Linux distribution such as Ubuntu or Debian.'
  fi
  glibc_line=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'a glibc-based Linux distribution is required.'
  glibc=$(printf '%s\n' "$glibc_line" | awk '{print $2}')
  [ -n "$glibc" ] || fail 'could not determine the host glibc version.'
  major=${glibc%%.*}
  minor=${glibc#*.}; minor=${minor%%.*}
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 31 ]; } ||
    fail "glibc >=2.31 is required, found $glibc."
fi
command -v node >/dev/null 2>&1 || fail 'Node.js >=22.13 is missing. Install Node.js 22 or 24 LTS.'
node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>=22&&M<27&&(M!==22||m>=13)?0:1)' ||
  fail "Node.js $(node --version) is unsupported. Install Node.js 22 or 24 LTS."
command -v npm >/dev/null 2>&1 || fail 'npm >=10 is missing. Reinstall Node.js 22 or 24 LTS.'
[ "$(npm --version | cut -d. -f1)" -ge 10 ] || fail 'npm >=10 is required. Run: npm install -g npm@latest'

command -v curl >/dev/null 2>&1 || fail 'curl is required to resolve the latest release.'
version=${CCODEX_VERSION:-$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).tag_name).replace(/^v/,"")))')}
[ -n "$version" ] || fail "could not resolve the latest release of $repository."
release="https://github.com/$repository/releases/download/v$version"
stage="$home/staging/bootstrap-$version-$$"
umask 077
mkdir -p "$home/staging"
tarballs="$stage.tarballs"
trap 'rm -rf "$stage" "$tarballs"' EXIT HUP INT TERM
# npm >= 12 refuses remote tarball specs by default, so install downloaded files.
mkdir -p "$tarballs"
for name in "gkorepanov-ccodex-$version.tgz" "gkorepanov-ccodex-$relay-$version.tgz"; do
  curl -fsSL -o "$tarballs/$name" "$release/$name" || fail "could not download $release/$name."
done
npm install --prefix "$stage" --include=optional --ignore-scripts --save=false \
  "$tarballs/gkorepanov-ccodex-$version.tgz" "$tarballs/gkorepanov-ccodex-$relay-$version.tgz"
rm -rf "$tarballs"
"$stage/node_modules/.bin/ccodex" setup --staged "$stage" --version "$version"
trap - EXIT HUP INT TERM
printf 'CCodex %s installed. Open a new shell.\n' "$version"
