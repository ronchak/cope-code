#!/bin/sh
set -eu

skip_build=0
skip_setup=0
update_path=1
for argument in "$@"; do
  case "$argument" in
    --skip-build) skip_build=1 ;;
    --skip-setup) skip_setup=1 ;;
    --no-path-update) update_path=0 ;;
    --help)
      printf 'Usage: %s [--skip-build] [--skip-setup] [--no-path-update]\n' "$0"
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 64 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { printf 'Cope macOS preview installation requires Darwin.\n' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { printf 'Cope refuses root installation. Do not use sudo.\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || {
  printf 'Node.js 24+ was not found. Install it with your approved package manager, reopen Terminal, and rerun this installer.\n' >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf 'npm 11+ was not found. Install the npm bundled with Node.js 24+, reopen Terminal, and rerun this installer.\n' >&2
  exit 1
}

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
npm_major=$(npm --version | awk -F. '{print $1}')
[ "$node_major" -ge 24 ] || {
  printf 'Node.js 24+ is required; found %s. Upgrade Node.js, reopen Terminal, and rerun this installer.\n' "$(node --version)" >&2
  exit 1
}
[ "$npm_major" -ge 11 ] || {
  printf 'npm 11+ is required; found %s. Upgrade npm for this Node.js installation and rerun this installer.\n' "$(npm --version)" >&2
  exit 1
}

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

configure_default_path() {
  bin_directory=$1
  case ":${PATH}:" in
    *":${bin_directory}:"*)
      printf 'Cope command directory is already on PATH: %s\n' "$bin_directory"
      return
      ;;
  esac

  home_real=$(CDPATH= cd -- "$HOME" && pwd -P)
  if [ "$prefix" != "$home_real/.local" ]; then
    printf 'Custom install prefix detected; PATH was not changed automatically.\n'
    printf 'Run Cope by its exact path or add this directory to PATH: %s\n' "$bin_directory"
    return
  fi

  profile="$HOME/.zprofile"
  if [ -L "$profile" ] || { [ -e "$profile" ] && { [ ! -f "$profile" ] || [ ! -O "$profile" ]; }; }; then
    printf 'PATH was not changed because %s is linked, non-regular, or not user-owned.\n' "$profile" >&2
    printf 'Add this directory to PATH manually: %s\n' "$bin_directory" >&2
    return
  fi

  path_line='export PATH="$HOME/.local/bin:$PATH"'
  if [ ! -e "$profile" ]; then
    umask 077
    : > "$profile"
  fi
  if ! /usr/bin/grep -Fqx "$path_line" "$profile"; then
    printf '\n# Added by the Cope installer\n%s\n' "$path_line" >> "$profile"
  fi
  printf 'Configured %s for future Terminal sessions.\n' "$profile"
  printf 'Open a new Terminal window before running cope, or run: export PATH="$HOME/.local/bin:$PATH"\n'
}

configure_source_checkout() {
  home_real=$(CDPATH= cd -- "$HOME" && pwd -P)
  if [ "$prefix" != "$home_real/.local" ]; then
    printf 'Custom install prefix detected; COPE_SOURCE_DIR was not saved automatically.\n'
    return
  fi
  profile="$HOME/.zprofile"
  if [ -L "$profile" ] || { [ -e "$profile" ] && { [ ! -f "$profile" ] || [ ! -O "$profile" ]; }; }; then
    printf 'COPE_SOURCE_DIR was not saved because %s is linked, non-regular, or not user-owned.\n' "$profile" >&2
    printf 'Add COPE_SOURCE_DIR manually before running cope update.\n' >&2
    return
  fi
  if [ ! -e "$profile" ]; then
    umask 077
    : > "$profile"
  fi
  source_line=$(node -e 'const value=JSON.stringify(process.argv[1]).replace(/\$/gu,"\\$").replace(/`/gu,"\\`"); process.stdout.write(`export COPE_SOURCE_DIR=${value}`)' "$project_root")
  if ! /usr/bin/grep -Fqx "$source_line" "$profile"; then
    printf '\n# Local checkout used by cope update\n%s\n' "$source_line" >> "$profile"
  fi
  printf 'Configured COPE_SOURCE_DIR for future Terminal sessions: %s\n' "$project_root"
}

if [ "$update_path" -eq 1 ]; then
  configure_default_path "$prefix/bin"
  configure_source_checkout
else
  printf 'PATH update skipped. Add this directory to PATH if needed: %s/bin\n' "$prefix"
fi

printf 'Cope %s installed for the current user.\n' "$installed_version"
printf 'This is an uncertified macOS preview; live use still requires the exact-tuple acceptance gates.\n'
if [ "$skip_setup" -eq 0 ]; then
  printf 'Starting guided browser setup. Sign-in and MFA remain user-controlled.\n'
  "$cope_command" setup
fi
