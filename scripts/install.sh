#!/bin/sh
# omnexx installer: curl -fsSL https://omnexx.org/install.sh | sh
#
# Installs the omnexx CLI from npm. Needs Node.js 22 or newer; if it is missing or too old,
# this says how to get it rather than installing a runtime behind your back.
# Set OMNEXX_VERSION to pin a version (default: latest).
set -eu

VERSION="${OMNEXX_VERSION:-latest}"
MIN_NODE=22

say() { printf '%s\n' "$*"; }
fail() { printf 'omnexx install: %s\n' "$*" >&2; exit 1; }

node_hint() {
  case "$(uname -s)" in
    Darwin) say "  brew install node        (or https://nodejs.org)" ;;
    Linux) say "  https://nodejs.org/en/download  (or your package manager, or: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22)" ;;
    *) say "  https://nodejs.org" ;;
  esac
}

if ! command -v node >/dev/null 2>&1; then
  say "omnexx needs Node.js $MIN_NODE or newer, and node isn't installed. Get it with:"
  node_hint
  say "then run this installer again."
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt "$MIN_NODE" ]; then
  say "omnexx needs Node.js $MIN_NODE or newer; you have $(node --version). Upgrade with:"
  node_hint
  exit 1
fi

command -v npm >/dev/null 2>&1 || fail "npm is missing (it ships with Node.js; reinstall Node)"

say "Installing omnexx@$VERSION with npm…"
if npm install -g "omnexx@$VERSION"; then
  :
else
  # A root-owned global prefix: install under the user's home instead of asking for sudo.
  prefix="$HOME/.omnexx-npm"
  say "The global npm folder isn't writable; installing into $prefix instead."
  npm install -g --prefix "$prefix" "omnexx@$VERSION" || fail "npm install failed (see above)"
  case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *) say "Add omnexx to your PATH:  export PATH=\"$prefix/bin:\$PATH\"  (put it in ~/.zshrc or ~/.bashrc)" ;;
  esac
fi

say ""
say "omnexx is installed. Next:"
say "  omnexx doctor          check your setup"
say "  omnexx --ollama        chat with a free local model (needs https://ollama.com)"
say "  omnexx                 open omnexx and paste an API key to get started"
