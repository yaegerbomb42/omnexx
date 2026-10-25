import { task } from '@trigger.dev/sdk';

/**
 * Minimal smoke-test task used to verify the Trigger.dev setup end to end.
 * Run it from the dashboard or with `npx trigger.dev@latest dev`.
 */
export const helloWorld = task({
  id: 'hello-world',
  run: async (payload: { name?: string }) => {
    const name = payload.name ?? 'world';

    return {
      message: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
    };
  },
});
