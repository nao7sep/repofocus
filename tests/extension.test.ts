import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import type { RepoFocusExtensionApi } from '../src/extension';
import { selectionModeCommands, visibilityCommandPrefix } from '../src/visibilityCommandResolver';

const host = vi.hoisted(() => ({
  api: {} as unknown,
  execute: async (_command: string): Promise<void> => {},
  commands: [] as string[],
  mode: 'multiple',
  listeners: new Set<(event: { affectsConfiguration(key: string): boolean }) => unknown>(),
}));

vi.mock('vscode', () => ({
  ExtensionMode: { Development: 2 },
  version: 'fixture',
  extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => host.api } }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  commands: {
    executeCommand: (command: string) => host.execute(command),
    getCommands: async () => host.commands,
    registerCommand: () => ({ dispose() {} }),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (_key: string, fallback: unknown) => section === 'scm' ? host.mode : fallback,
    }),
    asRelativePath: (path: string) => path,
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(key: string): boolean }) => unknown) => {
      host.listeners.add(listener);
      return { dispose: () => host.listeners.delete(listener) };
    },
  },
}));

let runtime: RepoFocusExtensionApi | undefined;
let subscriptions: { dispose(): void }[] = [];
afterEach(async () => {
  try {
    await runtime?.shutdown();
    subscriptions.forEach(subscription => subscription.dispose());
    host.listeners.clear();
    runtime = undefined;
  } finally {
    vi.useRealTimers();
  }
});

async function activateFixture() {
  const names = ['alpha', 'beta'];
  const visible = new Set(names);
  let selected: string | undefined = names[0];
  let shuttingDown = false;
  const shutdownCommands: string[] = [];
  const event = () => ({ dispose() {} });
  const repositories = names.map(name => ({
    rootUri: { fsPath: `/${name}`, toString: () => `file:///${name}` },
    state: {
      HEAD: { name: 'main', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 0 },
      remotes: [{ name: 'origin' }], rebaseCommit: undefined,
      mergeChanges: [], indexChanges: [], workingTreeChanges: [], untrackedChanges: [],
      onDidChange: event,
    },
    ui: { get selected() { return selected === name; }, onDidChange: event },
    status: async () => {},
  }));
  const toggles = names.map((_, index) => `${visibilityCommandPrefix}scm${index}`);
  host.mode = 'multiple';
  host.api = {
    state: 'initialized', repositories,
    onDidChangeState: event, onDidOpenRepository: event, onDidCloseRepository: event,
  };
  host.commands = [selectionModeCommands.single, selectionModeCommands.multiple, ...toggles];
  host.execute = async command => {
    if (command === 'setContext') return;
    if (shuttingDown) shutdownCommands.push(command);
    if (command === selectionModeCommands.single || command === selectionModeCommands.multiple) {
      host.mode = command === selectionModeCommands.single ? 'single' : 'multiple';
      visible.clear();
      (host.mode === 'single' ? names.slice(0, 1) : names).forEach(name => visible.add(name));
      selected = names[0];
      host.listeners.forEach(listener => listener({
        affectsConfiguration: key => key === 'scm.repositories.selectionMode',
      }));
      return;
    }
    const target = names[toggles.indexOf(command)];
    if (!target) throw new Error(`Unexpected command: ${command}`);
    if (shuttingDown && target === 'alpha') throw new Error('Host failed to re-show alpha');
    if (visible.delete(target)) {
      if (selected === target) selected = names.find(name => visible.has(name));
    } else visible.add(target);
  };
  subscriptions = [];
  const context = {
    subscriptions, extensionMode: 1, extension: { packageJSON: { version: 'fixture' } },
    workspaceState: { get: () => true, update: async () => {} },
  } as unknown as ExtensionContext;
  const { activate } = await import('../src/extension');
  runtime = await activate(context);
  return { names, visible, repositories, toggles, shutdownCommands, beginShutdown: () => { shuttingDown = true; } };
}

it('keeps the native reset owner alive for the final shutdown fallback after a failed re-show', async () => {
  vi.useFakeTimers();
  const { names, visible, repositories, toggles, shutdownCommands, beginShutdown } = await activateFixture();
  const settled = runtime!.waitForSettled();
  await vi.advanceTimersByTimeAsync(1_000);
  await settled;
  expect(repositories.every(repository => runtime!.isHiddenByRepoFocus(repository))).toBe(true);
  expect(visible.size).toBe(0);

  beginShutdown();
  const shutdown = runtime!.shutdown();
  expect(runtime!.shutdown()).toBe(shutdown);
  await shutdown;

  expect(shutdownCommands.slice(0, 2)).toEqual(expect.arrayContaining(toggles));
  expect(shutdownCommands.slice(2)).toEqual([selectionModeCommands.single, selectionModeCommands.multiple]);
  expect([...visible]).toEqual(names);
  expect(host.mode).toBe('multiple');
  expect(vi.getTimerCount()).toBe(0);
});

it('drains an already-started reset during shutdown without starting another mapping run', async () => {
  vi.useFakeTimers();
  const { names, visible, repositories } = await activateFixture();
  const execute = host.execute;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const commands: string[] = [];
  host.execute = async command => {
    commands.push(command);
    await execute(command);
    if (command === selectionModeCommands.single) await held;
  };
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(commands).toEqual([selectionModeCommands.single]);
    const shutdown = runtime!.shutdown();
    let stopped = false;
    void shutdown.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    // The owned transition finishes all-visible; disposed mapping never probes or filters it.
    expect(commands).toEqual([selectionModeCommands.single, selectionModeCommands.multiple]);
    expect([...visible]).toEqual(names);
    expect(repositories.some(repository => runtime!.isHiddenByRepoFocus(repository))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
  }
});
