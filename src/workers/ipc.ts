/**
 * Message pipes between a parent agent and its workers. A pipe is two endpoints wired to each
 * other; everything on the wire is one envelope shape — a caller-chosen kind, an opaque
 * payload, a correlation id, and an optional replyTo — so the same envelope can later ride a
 * stdio or socket transport unchanged. This module ships only the in-process transport:
 * delivery is synchronous and in send order, which makes parent/worker exchanges trivial to
 * reason about and to test. request() layers call-and-response on top of the envelope by
 * correlating a reply's replyTo with the request's id.
 */
import { StateError } from '../errors.js';

/** Envelope kinds with built-in meaning; application messages use their own kind strings. */
export const IpcKind = {
  /** A one-way application message (the default for send()). */
  Event: 'event',
  /** Stamp for replies sent through reply(): request() resolves on any replyTo match. */
  Reply: 'reply',
  /** Stamp for failure replies sent through replyError(): request() rejects with the message. */
  Error: 'error',
} as const;

/** One message on the pipe. Ids are unique per endpoint and never reused. */
export interface IpcEnvelope<T = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly payload: T;
  readonly replyTo?: string;
}

/** What a caller hands to send(): the endpoint stamps the id. */
export interface IpcMessageInput<T = unknown> {
  kind: string;
  payload: T;
  replyTo?: string;
}

/** request() waited longer than its timeout for a reply that never came. */
export class IpcTimeoutError extends StateError {
  readonly kind: string;
  readonly timeoutMs: number;

  constructor(kind: string, timeoutMs: number) {
    super(`ipc request "${kind}" timed out after ${timeoutMs}ms`, 'check the peer is listening');
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

/** The pipe (or the peer end of it) is closed: sends throw it, pending requests reject with it. */
export class IpcClosedError extends StateError {
  constructor(what: string) {
    super(`ipc pipe is closed (${what})`, 'create a new pipe pair instead of reopening this one');
  }
}

/** The peer answered a request with an error reply; carries the message it sent back. */
export class IpcRemoteError extends StateError {
  constructor(message: string) {
    super(`ipc peer replied with an error: ${message}`);
  }
}

type MessageHandler = (envelope: IpcEnvelope) => void;

interface PendingRequest {
  resolve: (envelope: IpcEnvelope) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * One end of a pipe. Create both ends with createPipePair(); an endpoint is useless alone.
 * Close is one-sided: a closed endpoint rejects its own pending requests and refuses to send,
 * and the transport refuses to deliver into it, so the peer's sends fail fast instead of
 * vanishing.
 */
export class PipeEndpoint {
  private peer: PipeEndpoint | undefined;
  private readonly handlers = new Set<MessageHandler>();
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private closed = false;

  /** Endpoint label ("a"/"b") prefixes message ids so a trace shows which side sent what. */
  constructor(private readonly label: string) {}

  /** Wire this endpoint to its peer. Only createPipePair() calls this. */
  link(peer: PipeEndpoint): void {
    this.peer = peer;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stamp and deliver a message to the peer. Returns the envelope as sent. */
  send<T>(input: IpcMessageInput<T>): IpcEnvelope<T> {
    this.assertOpen('send');
    const envelope = this.stamp(input);
    this.transmit(envelope);
    return envelope;
  }

  /** Reply to a received envelope: the reply's replyTo points back at it. */
  reply<T>(to: IpcEnvelope, payload: T): IpcEnvelope<T> {
    return this.send({ kind: IpcKind.Reply, payload, replyTo: to.id });
  }

  /** Fail a received envelope's request: the requester's promise rejects with the message. */
  replyError(to: IpcEnvelope, message: string): IpcEnvelope<{ message: string }> {
    return this.send({ kind: IpcKind.Error, payload: { message }, replyTo: to.id });
  }

  /**
   * Send a request and wait for the peer's reply (matched by replyTo). Resolves with the
   * reply envelope; rejects with IpcRemoteError on an error reply, IpcTimeoutError when no
   * reply arrives within timeoutMs, and IpcClosedError if this endpoint closes first.
   */
  async request<T>(
    kind: string,
    payload: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<IpcEnvelope<T>> {
    this.assertOpen('request');
    const sent = this.stamp({ kind, payload });
    // Register before transmitting: in-process delivery is synchronous, so a fast peer's
    // reply can arrive during transmit() and would be lost if we registered after it.
    const reply = new Promise<IpcEnvelope<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sent.id);
        reject(new IpcTimeoutError(kind, timeoutMs));
      }, timeoutMs);
      timer.unref();
      this.pending.set(sent.id, {
        resolve: (envelope) => {
          resolve(envelope as IpcEnvelope<T>);
        },
        reject,
        timer,
      });
    });
    try {
      this.transmit(sent);
    } catch (err) {
      // Delivery failed (peer closed): don't leave the request pending behind us.
      const pending = this.pending.get(sent.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(sent.id);
      }
      throw err;
    }
    return reply;
  }

  /** Listen for every envelope delivered to this endpoint. Returns an unsubscribe handle. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Shut this end down: pending requests reject and every later send throws. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new IpcClosedError('endpoint closed with requests in flight');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Transport entry point: the peer's send() lands here. Not for application code. */
  deliver(envelope: IpcEnvelope): void {
    if (this.closed) throw new IpcClosedError('peer endpoint is closed');
    const pending = envelope.replyTo !== undefined ? this.pending.get(envelope.replyTo) : undefined;
    if (pending && envelope.replyTo !== undefined) {
      this.pending.delete(envelope.replyTo);
      clearTimeout(pending.timer);
      if (envelope.kind === IpcKind.Error) {
        const payload = envelope.payload as { message?: unknown } | null;
        pending.reject(
          new IpcRemoteError(typeof payload?.message === 'string' ? payload.message : 'unknown'),
        );
      } else {
        pending.resolve(envelope);
      }
    }
    // Handlers see every message, replies included: observability beats cleverness here.
    for (const handler of this.handlers) handler(envelope);
  }

  private assertOpen(what: string): void {
    if (this.closed) throw new IpcClosedError(`cannot ${what} on a closed endpoint`);
    if (!this.peer) throw new IpcClosedError('endpoint is not linked to a peer');
  }

  /** Assign the next id to a message. Split from transmit() so request() can register first. */
  private stamp<T>(input: IpcMessageInput<T>): IpcEnvelope<T> {
    return {
      id: `${this.label}:${++this.counter}`,
      kind: input.kind,
      payload: input.payload,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    };
  }

  /** Hand a stamped envelope to the peer's deliver(). The peer enforces its own closed state. */
  private transmit(envelope: IpcEnvelope): void {
    this.peer?.deliver(envelope);
  }
}

/** Two endpoints connected to each other: [a, b]; a.send lands on b and vice versa. */
export function createPipePair(): [PipeEndpoint, PipeEndpoint] {
  const a = new PipeEndpoint('a');
  const b = new PipeEndpoint('b');
  a.link(b);
  b.link(a);
  return [a, b];
}
