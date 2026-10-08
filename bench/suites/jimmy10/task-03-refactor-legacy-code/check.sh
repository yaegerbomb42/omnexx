#!/usr/bin/env bash
set -euo pipefail

# Check that typecheck passes (after refactoring to .ts) and tests pass
npm run typecheck && npm test