import { describe, expect, it } from 'vitest';
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
} from '../../../src/providers/types.js';
import { emptyUsage } from '../../../src/providers/types.js';
import { Chat } from '../../../src/tui/chat.js';
import { modelsFetch, testIO } from '../../support/connect.js';

/** Calls connect_provider with whatever key placeholder it was shown, then answers. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  readonly seen: CompletionRequest[] = [];
  complete(req: CompletionRequest): Promise<CompletionResponse> {
    return Promise.resolve(this.reply(req));
  }

  private reply(req: CompletionRequest): CompletionResponse {
    this.seen.push(structuredClone(req));
    const base = { stopReason: 'end_turn' as const, usage: emptyUsage(), model: req.model };
    if (this.seen.length === 1) {
      const first = req.messages[0]?.content[0];
      const placeholder = /<key-\d+>/.exec(first?.type === 'text' ? first.text : '')?.[0];
      return {
        ...base,
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'connect_provider',
            input: { target: 'groq', key: placeholder },
          },
        ],
      };
    }
    return { ...base, content: [{ type: 'text', text: 'groq is connected' }] };
  }
}

describe('chat', () => {
  it('connects a provider through a tool without the model ever seeing the key', async () => {
    const seen: string[] = [];
    const io = await testIO(modelsFetch(['llama-4'], seen), { ANTHROPIC_API_KEY: 'sk-ant-test' });
    const provider = new ScriptedProvider();
    io.makeProvider = () => provider;
    const chat = await Chat.open(io, 'anthropic:sonnet');
    const said: string[] = [];
    await chat.send('add groq, key gsk_abcdefghijklmnopqrstuvwxyz', (l) => said.push(l));
    expect(said).toEqual(['· connect_provider', 'groq is connected']);
    expect(JSON.stringify(provider.seen)).not.toContain('gsk_abcdef');
    expect(seen[0]).toContain('Bearer gsk_abcdefghijklmnopqrstuvwxyz');
    const result = provider.seen[1]?.messages[2]?.content[0];
    expect(result?.type === 'tool_result' && result.content).toContain('llama-4');
  });
});
