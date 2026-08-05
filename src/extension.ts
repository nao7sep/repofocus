import * as vscode from 'vscode';
import {
  classifyRepository,
  type ActionabilityPolicy,
  type RepositoryActionability,
} from './actionability';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { Logger } from './logger';
import { toActionabilityInput } from './repositoryStateAdapter';
import {
  resolveVisibilityCommands,
  type VisibilityMapping,
} from './visibilityCommandResolver';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
  getActionability(repository: GitRepository): RepositoryActionability | undefined;
  isHiddenByRepoFocus(repository: GitRepository): boolean;
  resolveVisibilityMappings(): Promise<readonly VisibilityMapping[]>;
  showAll(): Promise<void>;
  waitForSettled(): Promise<void>;
}

interface ActiveRuntime {
  shutdown(): Promise<void>;
}

let activeRuntime: ActiveRuntime | undefined;

async function activateGit(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension['exports']>(gitExtensionId);
  if (!extension) {
    throw new Error('The built-in Git extension is unavailable.');
  }

  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

export async function activate(context: vscode.ExtensionContext): Promise<RepoFocusExtensionApi> {
  const git = await activateGit();
  const output = vscode.window.createOutputChannel('RepoFocus');
  const logger = new Logger(output, context.extensionMode === vscode.ExtensionMode.Development);
  context.subscriptions.push(output);
  const actionability = new Map<string, RepositoryActionability>();
  let policy = readPolicy();
  let mappingRefresh = Promise.resolve();
  let mappingRefreshGeneration = 0;
  let stopping = false;

  const resolveVisibilityMappings = async (): Promise<readonly VisibilityMapping[]> => {
    const commands = await vscode.commands.getCommands(true);
    return resolveVisibilityCommands(git.repositories, commands);
  };

  const reconciler = new VisibilityReconciler({
    toggle: async command => {
      await vscode.commands.executeCommand(command);
    },
    onError: error => {
      logger.error('Native visibility compatibility failed.', error);
      void vscode.commands.executeCommand('setContext', 'repofocus.compatible', false);
      void vscode.commands.executeCommand('setContext', 'repofocus.hasError', true);
      void vscode.window.showErrorMessage(
        'RepoFocus disabled filtering because VS Code repository visibility control failed.',
        'Show Output',
      ).then(selection => {
        if (selection === 'Show Output') output.show(true);
      });
    },
  });
  const filteringEnabled = context.workspaceState.get(filteringStateKey, true);
  await reconciler.setFilteringEnabled(filteringEnabled);
  await vscode.commands.executeCommand('setContext', 'repofocus.compatible', true);
  await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', filteringEnabled);
  await vscode.commands.executeCommand('setContext', 'repofocus.hasError', false);

  const refreshMappings = async (): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        reconciler.replaceMappings(await resolveVisibilityMappings());
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await reconciler.failCompatibility(lastError ?? new Error('Native visibility mapping failed.'));
  };

  const scheduleMappingRefresh = (): void => {
    const generation = ++mappingRefreshGeneration;
    mappingRefresh = mappingRefresh.then(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!stopping && generation === mappingRefreshGeneration) await refreshMappings();
    });
  };

  const monitor = new GitRepositoryMonitor(git, {
    onRepositoryOpened: () => scheduleMappingRefresh(),
    onRepositoryChanged: repository => {
      let value: RepositoryActionability;
      try {
        value = classifyRepository(toActionabilityInput(repository.state), policy);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        value = { actionable: true, reasons: [{ kind: 'error', detail }] };
      }
      actionability.set(repository.rootUri.toString(), value);
      reconciler.setActionability(repository, value);
    },
    onRepositoryClosed: repository => {
      actionability.delete(repository.rootUri.toString());
      reconciler.removeRepository(repository);
      scheduleMappingRefresh();
    },
  });
  context.subscriptions.push(monitor);
  scheduleMappingRefresh();

  const getActionability = (repository: GitRepository): RepositoryActionability | undefined =>
    actionability.get(repository.rootUri.toString());

  const evaluateAll = (): void => {
    for (const repository of monitor.repositories) {
      let value: RepositoryActionability;
      try {
        value = classifyRepository(toActionabilityInput(repository.state), policy);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        value = { actionable: true, reasons: [{ kind: 'error', detail }] };
      }
      actionability.set(repository.rootUri.toString(), value);
      reconciler.setActionability(repository, value);
    }
  };

  const waitForSettled = async (): Promise<void> => {
    let observedRefresh: Promise<void>;
    do {
      observedRefresh = mappingRefresh;
      await observedRefresh;
    } while (observedRefresh !== mappingRefresh);
    await reconciler.waitForIdle();
  };

  const setFilteringEnabled = async (enabled: boolean): Promise<void> => {
    await context.workspaceState.update(filteringStateKey, enabled);
    await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', enabled);
    await reconciler.setFilteringEnabled(enabled);
    logger.info('Filtering state changed.', { enabled });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repofocus.toggle', async () => {
      await setFilteringEnabled(!reconciler.enabled);
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual refresh requested.');
      policy = readPolicy();
      evaluateAll();
      scheduleMappingRefresh();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.showAll', async () => {
      logger.info('Show all repositories requested.');
      await setFilteringEnabled(false);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('repofocus')) return;
      policy = readPolicy();
      evaluateAll();
      logger.info('Actionability policy changed.', { ...policy });
    }),
  );

  const manifest = context.extension.packageJSON as { version?: unknown };
  logger.info('RepoFocus started.', {
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    filteringEnabled,
    ...policy,
  });

  activeRuntime = {
    shutdown: async () => {
      stopping = true;
      monitor.dispose();
      await mappingRefresh;
      await reconciler.shutdown();
      actionability.clear();
      logger.info('RepoFocus stopped.', { clean: true });
    },
  };

  return {
    git,
    getActionability,
    isHiddenByRepoFocus: repository => reconciler.isHiddenByRepoFocus(repository),
    resolveVisibilityMappings,
    showAll: () => reconciler.showAll(),
    waitForSettled,
  };
}

function readPolicy(): ActionabilityPolicy {
  const configuration = vscode.workspace.getConfiguration('repofocus');
  return {
    includeIncomingCommits: configuration.get('includeIncomingCommits', true),
    includeOutgoingCommits: configuration.get('includeOutgoingCommits', true),
    includeUntrackedFiles: configuration.get('includeUntrackedFiles', true),
  };
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.shutdown();
}
