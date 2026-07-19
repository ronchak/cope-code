#!/bin/sh
set -eu

remove_state=0
remove_profile=0
for argument in "$@"; do
  case "$argument" in
    --remove-state) remove_state=1 ;;
    --remove-profile) remove_profile=1 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 64 ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { printf 'Cope macOS preview uninstallation requires Darwin.\n' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { printf 'Cope refuses root uninstallation. Do not use sudo.\n' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf 'Node.js is required to validate removal paths.\n' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm is required to uninstall Cope.\n' >&2; exit 1; }

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
prefix_input=${COPE_INSTALL_PREFIX:-"${HOME}/.local"}
prefix=$(node "$script_directory/validate-macos-user-path.mjs" "$prefix_input")
npm uninstall --global --prefix "$prefix" @local/copilot-browser-agent
printf 'Removed the Cope package from %s. State and Edge profile were retained.\n' "$prefix"

remove_exact_directory() {
  expected=$1
  label=$2
  if [ ! -e "$expected" ]; then
    printf '%s does not exist: %s\n' "$label" "$expected"
    return
  fi
  validated=$(node "$script_directory/validate-macos-user-path.mjs" "$expected" --require-existing --validate-tree)
  [ "$validated" = "$expected" ] || { printf 'Refusing unexpected %s path.\n' "$label" >&2; exit 1; }
  rm -rf -- "$validated"
  printf 'Removed %s: %s (not recoverable by this script).\n' "$label" "$validated"
}

[ "$remove_state" -eq 0 ] || remove_exact_directory "$HOME/Library/Application Support/CopilotBrowserAgent" "Cope state"
[ "$remove_profile" -eq 0 ] || remove_exact_directory "$HOME/Library/Application Support/CopilotBrowserAgentEdgeProfile" "dedicated Edge profile"
