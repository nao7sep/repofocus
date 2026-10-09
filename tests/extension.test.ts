import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import type { RepoFocusExtensionApi } from '../src/extension';
import { describeUnsavedFiltering } from '../src/userMessages';
import { selectionModeCommands, visibilityCommandPrefix } from '../src/visibilityCommandResolver';

const host = vi.hoisted(() => ({
  api: {} as unknown,
  execute: async (_command: string): Promise<void> => {},
  commands: [] as string[],
  mode: 'multiple',
  listeners: new Set<(event: { affectsConfiguration(key: string): boolean }) => unknown>(),
  handlers: new Map<string, () => Promise<void>>(),
  warnings: [] as string[],
  errors: [] as string[],
  saveStoredValue: async (_value: unknown): Promise<void> => {},
}));

vi.mock('vscode', () => ({
  ExtensionMode: { Development: 2 },
  version: 'fixture',
  extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => host.api } }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showErrorMessage: async (message: string) => { host.errors.push(message); },
    showInformationMessage: async () => undefined,
    showWarningMessage: async (message: string) => { host.warnings.push(message); },
  },
  commands: {
    executeCommand: (command: string) => host.execute(command),
    getCommands: async () => host.commands,
    registerCommand: (command: string, handler: () => Promise<void>) => {
      host.handlers.set(command, handler);
      return { dispose: () => host.handlers.delete(command) };
    },
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
/** VS Code disposes subscriptions synchronously, after it has cut the extension's connection. */
function stopLikeHost(): void {
  subscriptions.forEach(subscription => subscription.dispose());
}

afterEach(() => {
  try {
    stopLikeHost();
    host.listeners.clear();
    host.warnings = [];
    host.errors = [];
    host.saveStoredValue = async () => {};
    runtime = undefined;
  } finally {
    vi.useRealTimers();
  }
});

async function activateFixture() {
  const names = ['alpha', 'beta'];
  const visible = new Set(names);
  let selected: string | undefined = names[0];
  const commands: string[] = [];
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
    commands.push(command);
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
    if (visible.delete(target)) {
      if (selected === target) selected = names.find(name => visible.has(name));
    } else visible.add(target);
  };
  subscriptions = [];
  const context = {
    subscriptions, extensionMode: 1, extension: { packageJSON: { version: 'fixture' } },
    workspaceState: { get: () => true, update: (_key: string, value: unknown) => host.saveStoredValue(value) },
  } as unknown as ExtensionContext;
  const { activate } = await import('../src/extension');
  runtime = await activate(context);
  return { names, visible, repositories, toggles, commands };
}

it('issues no host command and leaves no timer once stopped', async () => {
  vi.useFakeTimers();
  const { visible, repositories, commands } = await activateFixture();
  const settled = runtime!.waitForSettled();
  await vi.advanceTimersByTimeAsync(1_000);
  await settled;
  expect(repositories.every(repository => runtime!.isHiddenByRepoFocus(repository))).toBe(true);
  const issued = commands.length;

  stopLikeHost();
  await vi.advanceTimersByTimeAsync(60_000);

  // Repositories hidden at stop stay hidden: VS Code no longer runs this
  // extension's commands, so stopping cannot re-show them.
  expect(commands).toHaveLength(issued);
  expect(visible.size).toBe(0);
  expect(host.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending mapping run when stopped before it starts', async () => {
  vi.useFakeTimers();
  const { commands } = await activateFixture();

  stopLikeHost();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(commands).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('starts nothing further when stopped during a reset', async () => {
  vi.useFakeTimers();
  const { repositories, commands } = await activateFixture();
  const execute = host.execute;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  host.execute = async command => {
    await execute(command);
    if (command === selectionModeCommands.single) await held;
  };
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(commands).toEqual([selectionModeCommands.single]);

    stopLikeHost();
    release();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(commands).toEqual([selectionModeCommands.single]);
    expect(repositories.some(repository => runtime!.isHiddenByRepoFocus(repository))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
  }
});

it('keeps a toggle that VS Code cannot save and warns that it may not be remembered', async () => {
  vi.useFakeTimers();
  const { repositories } = await activateFixture();
  const settled = runtime!.waitForSettled();
  await vi.advanceTimersByTimeAsync(1_000);
  await settled;
  host.saveStoredValue = async () => { throw new Error('storage failed'); };

  const toggle = host.handlers.get('repofocus.toggle')!();
  await vi.advanceTimersByTimeAsync(1_000);
  await toggle;

  expect(runtime!.isFilteringEnabled()).toBe(false);
  expect(repositories.some(repository => runtime!.isHiddenByRepoFocus(repository))).toBe(false);
  expect(host.warnings).toEqual([describeUnsavedFiltering(false)]);
  expect(host.errors).toEqual([]);
});

it('shows no message for a toggle that a later toggle has already replaced', async () => {
  vi.useFakeTimers();
  await activateFixture();
  const settled = runtime!.waitForSettled();
  await vi.advanceTimersByTimeAsync(1_000);
  await settled;
  let saves = 0;
  host.saveStoredValue = async () => {
    saves += 1;
    if (saves === 1) throw new Error('storage failed');
  };

  const toggle = host.handlers.get('repofocus.toggle')!;
  const first = toggle();
  const second = toggle();
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([first, second]);

  expect(runtime!.isFilteringEnabled()).toBe(true);
  expect(saves).toBe(2);
  expect(host.warnings).toEqual([]);
  expect(host.errors).toEqual([]);
});
