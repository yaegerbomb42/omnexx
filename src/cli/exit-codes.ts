/** Plan §5.1. Scripts rely on these, so they never change meaning. */
export const EXIT = {
  ok: 0,
  error: 1,
  needsHuman: 2,
  budgetStop: 3,
  userStop: 4,
} as const;
