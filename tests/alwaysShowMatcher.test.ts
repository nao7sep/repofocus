import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateAlwaysShowPatterns } from '../src/alwaysShow';
import { AlwaysShowMatcher, AlwaysShowTimeoutError } from '../src/alwaysShowMatcher';
import type { AlwaysShowWorkerRequest } from '../src/alwaysShowWorkerProtocol';

class FakeWorker extends EventEmitter {
  readonly requests: AlwaysShowWorkerRequest[] = [];
  readonly terminate = vi.fn(async () => 1);
  unref(): void {}
  postMessage(request: AlwaysShowWorkerRequest): void {
    this.requests.push(request);
    if (request.kind === 'configure') queueMicrotask(() => this.emit('message', { kind: 'ready' }));
  }
}

const owners: AlwaysShowMatcher[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.dispose();
    await owner.waitForIdle();
  }
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const workers: FakeWorker[] = [];
  const owner = new AlwaysShowMatcher({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    matchTimeoutMilliseconds: 100,
  });
  owners.push(owner);
  owner.configure(validateAlwaysShowPatterns(['repo*']));
  return { owner, workers };
}

describe('AlwaysShowMatcher ownership', () => {
  it('coalesces Git events and caches the result until a fresh configuration', async () => {
    const { owner, workers } = fixture();
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    owner.evaluate('one', '/work/repo', oldCallback);
    for (let index = 0; index < 100; index++) owner.evaluate('one', '/work/repo', currentCallback);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].requests.map(request => request.kind)).toEqual(['configure', 'match']);

    workers[0].emit('message', { kind: 'match', matches: true });
    await owner.waitForIdle();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(currentCallback).toHaveBeenCalledOnce();
    expect(owner.evaluate('one', '/work/repo', currentCallback)).toEqual({ kind: 'matched', matches: true });
    expect(workers).toHaveLength(1);
    expect(workers[0].requests).toHaveLength(2);
  });

  it('waits for real termination before replacing an obsolete settings generation', async () => {
    const { owner, workers } = fixture();
    const oldCallback = vi.fn();
    const currentCallback = vi.fn();
    owner.evaluate('one', '/work/repo', oldCallback);
    await vi.advanceTimersByTimeAsync(0);
    let exited!: (code: number) => void;
    workers[0].terminate.mockImplementation(() => new Promise(resolve => { exited = resolve; }));
    owner.configure(validateAlwaysShowPatterns(['other']));
    owner.evaluate('one', '/work/repo', currentCallback);
    workers[0].emit('message', { kind: 'match', matches: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    expect(oldCallback).not.toHaveBeenCalled();

    exited(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(workers[1].requests[0]).toMatchObject({ kind: 'configure', patterns: ['other'] });
    workers[1].emit('message', { kind: 'match', matches: false });
    await owner.waitForIdle();
    expect(currentCallback).toHaveBeenCalledOnce();
    expect(owner.evaluate('one', '/work/repo', currentCallback)).toEqual({ kind: 'matched', matches: false });
  });

  it('discards a result for a closed repository even when the same path reopens', async () => {
    const { owner, workers } = fixture();
    const closed = vi.fn();
    const reopened = vi.fn();
    owner.evaluate('one', '/work/repo', closed);
    await vi.advanceTimersByTimeAsync(0);
    owner.forget('one');
    owner.evaluate('one', '/work/repo', reopened);
    workers[0].emit('message', { kind: 'match', matches: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).not.toHaveBeenCalled();
    expect(reopened).not.toHaveBeenCalled();
    workers[0].emit('message', { kind: 'match', matches: false });
    await owner.waitForIdle();
    expect(reopened).toHaveBeenCalledOnce();
    expect(owner.evaluate('one', '/work/repo', reopened)).toEqual({ kind: 'matched', matches: false });
  });

  it('caches a timed-out match and serves unrelated work only after termination', async () => {
    const { owner, workers } = fixture();
    const failed = vi.fn();
    owner.evaluate('slow', '/work/repo', failed);
    owner.evaluate('other', '/work/other', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    let exited!: (code: number) => void;
    workers[0].terminate.mockImplementation(() => new Promise(resolve => { exited = resolve; }));
    await vi.advanceTimersByTimeAsync(100);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
    exited(1);
    await vi.advanceTimersByTimeAsync(0);
    const result = owner.evaluate('slow', '/work/repo', failed);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.error).toBeInstanceOf(AlwaysShowTimeoutError);
    expect(failed).toHaveBeenCalledOnce();
    workers[1].emit('message', { kind: 'match', matches: true });
    await owner.waitForIdle();
    expect(workers[1].requests.filter(request => request.kind === 'match')).toHaveLength(1);
    expect(owner.evaluate('other', '/work/other', vi.fn())).toEqual({ kind: 'matched', matches: true });
  });

  it('retains a generation failure without restarting on subsequent Git events', async () => {
    const error = new Error('worker could not start');
    const createWorker = vi.fn(() => { throw error; });
    const owner = new AlwaysShowMatcher({ createWorker });
    owners.push(owner);
    owner.configure(validateAlwaysShowPatterns(['repo']));
    owner.evaluate('one', 'repo', vi.fn());
    await owner.waitForIdle();
    expect(owner.evaluate('one', 'repo', vi.fn())).toEqual({ kind: 'failed', error });
    expect(owner.evaluate('two', 'other', vi.fn())).toEqual({ kind: 'failed', error });
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it('stops locally without callbacks, restarts or leftover deadlines', async () => {
    const { owner, workers } = fixture();
    const changed = vi.fn();
    owner.evaluate('one', 'repo', changed);
    await vi.advanceTimersByTimeAsync(0);
    owner.dispose();
    workers[0].emit('message', { kind: 'match', matches: true });
    await owner.waitForIdle();
    expect(changed).not.toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('needs no worker for an empty or malformed setting', () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const owner = new AlwaysShowMatcher({ createWorker });
    owners.push(owner);
    owner.configure(validateAlwaysShowPatterns([42]));
    expect(owner.evaluate('one', 'repo', vi.fn())).toEqual({ kind: 'matched', matches: false });
    expect(createWorker).not.toHaveBeenCalled();
  });
});

describe('real bundled always-show worker', () => {
  let root: string;
  let workerPath: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'repofocus-worker-test-'));
    workerPath = join(root, 'alwaysShowWorker.cjs');
    await build({ entryPoints: ['src/alwaysShowWorker.ts'], outfile: workerPath, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([
    ['+(a|aa)b', 'a'.repeat(36) + 'c'],
    ['a*'.repeat(18) + 'b', 'a'.repeat(100) + 'c'],
  ])('terminates expensive matching for %s while the host stays responsive', async (pattern, path) => {
    const workers: Worker[] = [];
    let matchStarted!: () => void;
    const started = new Promise<void>(resolve => { matchStarted = resolve; });
    const owner = new AlwaysShowMatcher({
      createWorker: () => {
        expect(workers.every(worker => worker.threadId === -1)).toBe(true);
        const worker = new Worker(workerPath);
        workers.push(worker);
        const postMessage = worker.postMessage.bind(worker);
        worker.postMessage = request => {
          postMessage(request);
          if (request.kind === 'match' && request.path === path) matchStarted();
        };
        return worker;
      },
      matchTimeoutMilliseconds: 100,
    });
    owners.push(owner);
    owner.configure(validateAlwaysShowPatterns([pattern, 'ordinary']));
    const failed = vi.fn();
    owner.evaluate('slow', path, failed);
    owner.evaluate('other', 'ordinary', vi.fn());
    await started;
    // This timer runs in the calling thread while the regex occupies the worker.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failed).not.toHaveBeenCalled();
    await owner.waitForIdle();
    const result = owner.evaluate('slow', path, failed);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.error).toBeInstanceOf(AlwaysShowTimeoutError);
    expect(workers[0].threadId).toBe(-1);
    expect(owner.evaluate('other', 'ordinary', vi.fn())).toEqual({ kind: 'matched', matches: true });
    owner.dispose();
    await owner.waitForIdle();
    expect(workers.every(worker => worker.threadId === -1)).toBe(true);
  });
});
