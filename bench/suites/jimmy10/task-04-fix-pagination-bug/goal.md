# Task: Fix the Pagination Bug

Users report that the last page of results is sometimes missing and that page 1 repeats an item
from page 0. Fix `paginate` in `src/paginate.js`. Pages are 1-based. Keep the existing API.

## Success Criteria

- `npm test` passes
- Every item appears on exactly one page; `totalPages` is right for any size and page size
