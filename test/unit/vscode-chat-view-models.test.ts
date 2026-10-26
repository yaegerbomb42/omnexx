import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../vscode/src/chatView.js';
import type { ServerMessage } from '../../vscode/src/chatProcess.js';

const h = vi.hoisted(() => {
  function makeEmitter<T>() {
    const listeners = new Set<(e: T) => void>();
    return {
      event: (listener: (e: T) => void): { dispose: () => void } => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
      fire(e: T): void {
        for (const listener of [...listeners]) listener(e);
      },
    };
  }
  class FakeServer {
    static instances: FakeServer[] = [];
    running = false;
    sent: Record<string, unknown>[] = [];
    private readonly emitter = makeEmitter<ServerMessage>();
    readonly onMessage = this.emitter.event;
    constructor() {
      FakeServer.instances.push(this);
    }
    send(cmd: Record<string, unknown>): void {
      this.sent.push(cmd);
    }
    fire(message: ServerMessage): void {
      this.emitter.fire(message);
    }
    restart(): void {
      this.running = false;
    }
    dispose(): void {
      this.sent.length = 0;
    }
  }
  return { FakeServer };
});

vi.mock('../../vscode/src/chatProcess.js', () => ({
  ChatProcess: h.FakeServer,
}));

vi.mock('vscode', () => {
  class MockUri {
    readonly fsPath: string;
    constructor(fsPath = '') {
      this.fsPath = fsPath;
    }
    static file(fsPath: string): MockUri {
      return new MockUri(fsPath);
    }
  }
  class MockIcon {
    readonly value: string;
    constructor(value = '') {
      this.value = value;
    }
  }
  return {
    Uri: MockUri,
    ThemeIcon: MockIcon,
    ThemeColor: MockIcon,
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: () => false, update: () => Promise.resolve(undefined) }),
      findFiles: () => Promise.resolve([]),
      asRelativePath: (u: unknown) => String(u),
      fs: {},
    },
    window: {},
    commands: {},
    env: {},
    ConfigurationTarget: { Global: 1 },
  };
});

interface Listed {
  items: { ref: string; provider: string; model: string }[];
  unreachable: string[];
}

const MODELS = [{ ref: 'p:m', provider: 'p', model: 'm' }];

const reply = (items: typeof MODELS): ServerMessage => ({
  type: 'models',
  items,
  unreachable: [],
});

describe('modelsWaiter: a pending resolver per request', () => {
  beforeEach(() => {
    h.FakeServer.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeProvider = () =>
    new ChatViewProvider({} as never) as unknown as {
      listModels: () => Promise<Listed>;
    };

  it('resolves every pending request when one models reply arrives', async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    const server = h.FakeServer.instances[0];
    if (!server) throw new Error('test server not created');
    const first = provider.listModels();
    const second = provider.listModels();
    expect(server.sent).toHaveLength(2);
    server.fire(reply(MODELS));
    await expect(first).resolves.toEqual({ items: MODELS, unreachable: [] });
    await expect(second).resolves.toEqual({ items: MODELS, unreachable: [] });
  });

  it('a timeout removes only its own pending request', async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    const server = h.FakeServer.instances[0];
    if (!server) throw new Error('test server not created');
    const first = provider.listModels();
    await vi.advanceTimersByTimeAsync(5000);
    const second = provider.listModels();
    const firstTookTooLong = expect(first).rejects.toThrow(/too long/);
    await vi.advanceTimersByTimeAsync(10000);
    await firstTookTooLong;
    server.fire(reply(MODELS));
    await expect(second).resolves.toEqual({ items: MODELS, unreachable: [] });
  });
});
