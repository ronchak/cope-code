#!/bin/sh
set -eu

skip_build=0
skip_setup=0
for argument in "$@"; do
  case "$argument" in
    --skip-build) skip_build=1 ;;
    --skip-setup) skip_setup=1 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 64 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { printf 'Cope macOS preview installation requires Darwin.\n' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { printf 'Cope refuses root installation. Do not use sudo.\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'Node.js 24+ is required.\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm 11+ is required.\n' >&2; exit 1; }

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
npm_major=$(npm --version | awk -F. '{print $1}')
[ "$node_major" -ge 24 ] || { printf 'Node.js 24+ is required; found %s.\n' "$(node --version)" >&2; exit 1; }
[ "$npm_major" -ge 11 ] || { printf 'npm 11+ is required; found %s.\n' "$(npm --version)" >&2; exit 1; }

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
project_root=$(dirname -- "$script_directory")
expected_version=$(node -e 'const fs=require("node:fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof x.version!=="string"||x.version.length===0) process.exit(1); process.stdout.write(x.version)' "$project_root/package.json")
prefix_input=${COPE_INSTALL_PREFIX:-"${HOME}/.local"}
prefix=$(node "$script_directory/validate-macos-user-path.mjs" "$prefix_input")
umask 077
mkdir -p -- "$prefix"
prefix=$(node "$script_directory/validate-macos-user-path.mjs" "$prefix" --require-existing)

cd -- "$project_root"
if [ "$skip_build" -eq 0 ]; then
  npm ci --no-audit --no-fund
  npm run build
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/cope-install.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
npm pack --json --ignore-scripts --pack-destination "$temporary" >"$temporary/pack.json"
package_name=$(node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const x=Array.isArray(v)?v[0]:v; if(!x?.filename) process.exit(1); process.stdout.write(x.filename)' "$temporary/pack.json")
package_file="$temporary/$package_name"
[ -f "$package_file" ] || { printf 'Packed release artifact is missing.\n' >&2; exit 1; }

npm install --global --prefix "$prefix" --force --ignore-scripts --no-audit --no-fund "$package_file"
cope_command="$prefix/bin/cope"
[ -x "$cope_command" ] || { printf 'Installed cope command was not found at %s.\n' "$cope_command" >&2; exit 1; }
installed_version=$("$cope_command" --version)
[ "$installed_version" = "$expected_version" ] || { printf 'Installed version check failed: expected %s, found %s\n' "$expected_version" "$installed_version" >&2; exit 1; }

printf 'Cope %s installed for the current user.\n' "$installed_version"
printf 'Add this exact directory to PATH if needed: %s/bin\n' "$prefix"
printf 'This is an uncertified macOS preview; live use still requires the exact-tuple acceptance gates.\n'
if [ "$skip_setup" -eq 0 ]; then
  printf 'Starting manual Edge onboarding. Sign-in and MFA remain user-controlled.\n'
  "$cope_command" setup
fi
