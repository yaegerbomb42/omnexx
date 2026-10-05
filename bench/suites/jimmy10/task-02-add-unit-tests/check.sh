#!/usr/bin/env bash
set -euo pipefail

# Check that tests pass and coverage is at least 90% for calculator.ts
npm test
# vitest coverage output includes a summary - we check the coverage for calculator.ts specifically
# For the check script, we just ensure tests pass; coverage threshold is in vitest.config.ts