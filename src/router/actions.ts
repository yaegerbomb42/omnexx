/**
 * What a model call is for. The router picks a model per action; the set is stable so routing
 * logs stay comparable across versions. Routing happens per cycle or side call, never per turn:
 * switching models mid-cycle would throw away the prompt cache.
 */
export const ROUTE_ACTIONS = [
  'plan',
  'replan',
  'split',
  'read-explore',
  'edit-small',
  'edit-large',
  'refactor',
  'debug-failure',
  'write-tests',
  'docs',
  'summarize',
  'compact',
  'browser-step',
  'review-diff',
  'intent-infer',
  'beyond-ideate',
  'commit-message',
] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export type Role = 'planner' | 'worker' | 'cheap';

/** The role whose chain handles an action when nothing better is known (today's behaviour). */
export const ACTION_ROLE: Record<RouteAction, Role> = {
  plan: 'planner',
  replan: 'planner',
  split: 'planner',
  'intent-infer': 'planner',
  'beyond-ideate': 'planner',
  'review-diff': 'planner',
  'read-explore': 'worker',
  'edit-small': 'worker',
  'edit-large': 'worker',
  refactor: 'worker',
  'debug-failure': 'worker',
  'write-tests': 'worker',
  docs: 'worker',
  'browser-step': 'worker',
  summarize: 'cheap',
  compact: 'cheap',
  'commit-message': 'cheap',
};

/** One line the judge reads to understand the action. */
export const ACTION_HINT: Record<RouteAction, string> = {
  plan: 'write the initial multi-milestone plan for a large goal (hard reasoning)',
  replan: 'revise the plan after new evidence (hard reasoning)',
  split: 'split a stuck task into smaller tasks (hard reasoning)',
  'intent-infer': 'infer what the user actually wants built from a short prompt and the repo',
  'beyond-ideate': 'propose the most valuable improvements after the goal is met',
  'review-diff': 'review a diff for correctness and risk',
  'read-explore': 'explore and read code to answer a question; few edits',
  'edit-small': 'a small, well-specified code change (one or two files)',
  'edit-large': 'a large feature change across several files',
  refactor: 'restructure code while keeping tests green',
  'debug-failure': 'fix failing tests or a rejected attempt; needs careful debugging',
  'write-tests': 'write or extend tests',
  docs: 'write or update documentation',
  'browser-step': 'drive a browser to check a UI',
  summarize: 'summarize text',
  compact: 'compress a transcript',
  'commit-message': 'write a commit message',
};
