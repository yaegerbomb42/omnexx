#!/bin/sh
# Print the Homebrew formula for a published omnexx version:
#   scripts/brew-formula.sh 0.5.0 > ../homebrew-omnexx/Formula/omnexx.rb
# Reads the tarball from npm, so run it after the release is on npm.
set -eu

VERSION="${1:?usage: scripts/brew-formula.sh <version>}"
case "$VERSION" in
  *[!0-9.]* | "") echo "brew-formula: not a version: $VERSION" >&2; exit 1 ;;
  *) ;;
esac
URL="https://registry.npmjs.org/omnexx/-/omnexx-${VERSION}.tgz"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL "$URL" -o "$TMP" || { echo "brew-formula: omnexx@$VERSION is not on npm" >&2; exit 1; }
SHA="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
sed -e "s|@URL@|$URL|" -e "s|@SHA256@|$SHA|" "$DIR/packaging/homebrew/omnexx.rb.in"
