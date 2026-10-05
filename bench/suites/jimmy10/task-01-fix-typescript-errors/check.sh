#!/usr/bin/env bash
set -euo pipefail

# Check that typecheck passes and tests pass
npm run typecheck && npm test