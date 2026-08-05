import * as vscode from 'vscode';
import {
  classifyRepository,
  type ActionabilityPolicy,
  type RepositoryActionability,
} from './actionability';
import { matchesAlwaysShow } from './alwaysShow';
import { createDiagnostics } from './diagnostics';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { Logger } from './logger';
import { RemoteFetchScheduler, type RemoteFetchTarget } from './remoteFetchScheduler';
import { toActionabilityInput } from './repositoryStateAdapter';
import { VisibilityMappingCoordinator } from './visibilityMappingCoordinator';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
  getActionability(repository: GitRepository): RepositoryActionability | undefined;
  isFilteringEnabled(): boolean;
  isHiddenByRepoFocus(repository: GitRepository): boolean;
  showAll(): Promise<void>;
  shutdown(): Promise<void>;
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
  const manifest = context.extension.packageJSON as { version?: unknown };
  const extensionVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  context.subscriptions.push(output);
  const actionability = new Map<string, RepositoryActionability>();
  const remoteFailures = new Map<string, string>();
  let policy = readPolicy();
  let alwaysShowPatterns = readAlwaysShowPatterns();
  let compatibilityFailureReported = false;

  const reconciler = new VisibilityReconciler({
    toggle: async command => {
      await vscode.commands.executeCommand(command);
    },
    onError: error => {
      logger.error('Native visibility compatibility failed.', error);
      void vscode.commands.executeCommand('setContext', 'repofocus.compatible', false);
      void vscode.commands.executeCommand('setContext', 'repofocus.hasError', true);
      if (compatibilityFailureReported) return;
      compatibilityFailureReported = true;
      void vscode.window.showErrorMessage(
        `RepoFocus disabled filtering: ${error.message}`,
        'Show All Repositories',
        'Copy Diagnostics',
        'Open Documentation',
        'Show Output',
      ).then(selection => {
        if (selection === 'Show All Repositories') {
          void vscode.commands.executeCommand('repofocus.showAll');
        } else if (selection === 'Copy Diagnostics') {
          void vscode.commands.executeCommand('repofocus.copyDiagnostics');
        } else if (selection === 'Open Documentation') {
          void vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/nao7sep/repofocus#compatibility-and-safety',
          ));
        } else if (selection === 'Show Output') {
          output.show(true);
        }
      });
    },
  });
  let filteringEnabled = context.workspaceState.get(filteringStateKey, true);
  await vscode.commands.executeCommand('setContext', 'repofocus.compatible', true);
  await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', filteringEnabled);
  await vscode.commands.executeCommand('setContext', 'repofocus.hasError', false);

  const visibility = new VisibilityMappingCoordinator({
    execute: async command => {
      await vscode.commands.executeCommand(command);
    },
    filteringRequested: () => filteringEnabled,
    getCommands: async () => await vscode.commands.getCommands(true),
    getNativeVisibleLimit: () =>
      vscode.workspace.getConfiguration('scm').get('repositories.visible', 10),
    getRepositories: () => git.repositories,
    minimumRepositoryCount: readMinimumRepositoryCount,
    reconciler,
    onInitialized: event => {
      logger.info('Visibility filtering initialized.', {
        repositoryCount: event.repositoryCount,
        actionableRepositoryCount: [...actionability.values()]
          .filter(value => value.actionable).length,
        hiddenRepositoryCount: reconciler.hiddenRepositoryCount,
        revision: event.revision,
      });
    },
  });

  const evaluateRepository = (repository: GitRepository): void => {
    let value: RepositoryActionability;
    try {
      const input = toActionabilityInput(repository.state);
      value = classifyRepository({
        ...input,
        alwaysShow: matchesAlwaysShow(
          vscode.workspace.asRelativePath(repository.rootUri.fsPath, false),
          alwaysShowPatterns,
        ),
        evaluationError: remoteFailures.get(repository.rootUri.toString()),
      }, policy);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      value = { actionable: true, reasons: [{ kind: 'error', detail }] };
    }
    actionability.set(repository.rootUri.toString(), value);
    reconciler.setActionability(repository, value);
  };

  const monitor = new GitRepositoryMonitor(git, {
    onRepositoryOpened: () => visibility.requestRefresh(),
    onRepositoryChanged: evaluateRepository,
    onRepositoryClosed: repository => {
      const key = repository.rootUri.toString();
      actionability.delete(key);
      remoteFailures.delete(key);
      reconciler.removeRepository(repository);
      visibility.requestRefresh();
    },
  });
  context.subscriptions.push(monitor);
  visibility.requestRefresh();

  const getActionability = (repository: GitRepository): RepositoryActionability | undefined =>
    actionability.get(repository.rootUri.toString());

  const evaluateAll = (): void => {
    for (const repository of monitor.repositories) evaluateRepository(repository);
  };

  interface RepositoryFetchTarget extends RemoteFetchTarget {
    readonly repository: GitRepository;
  }
  const fetchScheduler = new RemoteFetchScheduler({
    concurrency: 2,
    getTargets: () => {
      if (!policy.includeIncomingCommits && !policy.includeOutgoingCommits) return [];
      return monitor.repositories
        .filter(repository => repository.state.remotes.length > 0)
        .map((repository): RepositoryFetchTarget => ({
          key: repository.rootUri.toString(),
          repository,
          fetch: () => repository.fetch(),
        }));
    },
    onSuccess: target => {
      const { repository } = target as RepositoryFetchTarget;
      remoteFailures.delete(target.key);
      evaluateRepository(repository);
    },
    onError: target => {
      const { repository } = target as RepositoryFetchTarget;
      remoteFailures.set(target.key, 'Remote refresh failed.');
      evaluateRepository(repository);
      // Built-in Git fetch errors can embed credential-bearing remote URLs, so
      // this boundary deliberately records no raw exception text.
      logger.error('Remote refresh failed.', new Error('Built-in Git fetch failed.'));
    },
  });
  context.subscriptions.push(fetchScheduler);
  let fetchIntervalMilliseconds = readFetchIntervalMilliseconds();
  fetchScheduler.setInterval(fetchIntervalMilliseconds);
  if (fetchIntervalMilliseconds > 0) void fetchScheduler.refreshNow();

  const copyDiagnostics = async (): Promise<void> => {
    const diagnostics = createDiagnostics({
      extensionVersion,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      filteringEnabled,
      filteringActive: reconciler.enabled,
      compatible: reconciler.compatible,
      baselineEstablished: visibility.baselineEstablished,
      repositoryStates: [...actionability.values()],
      hiddenByRepoFocusCount: reconciler.hiddenRepositoryCount,
      remoteFailureCount: remoteFailures.size,
      policy,
      alwaysShowPatternCount: alwaysShowPatterns.length,
      fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
      minimumRepositoryCount: readMinimumRepositoryCount(),
    });
    await vscode.env.clipboard.writeText(diagnostics);
    void vscode.window.showInformationMessage('RepoFocus diagnostics copied to the clipboard.');
  };

  const waitForSettled = async (): Promise<void> => {
    await visibility.waitForIdle();
    await fetchScheduler.waitForIdle();
    await reconciler.waitForIdle();
  };

  const setFilteringEnabled = async (enabled: boolean): Promise<void> => {
    filteringEnabled = enabled;
    await context.workspaceState.update(filteringStateKey, enabled);
    await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', enabled);
    await visibility.updateFiltering();
    logger.info('Filtering state changed.', { enabled });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repofocus.toggle', async () => {
      await setFilteringEnabled(!filteringEnabled);
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual refresh requested.');
      policy = readPolicy();
      alwaysShowPatterns = readAlwaysShowPatterns();
      await fetchScheduler.refreshNow();
      evaluateAll();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.showAll', async () => {
      logger.info('Show all repositories requested.');
      await setFilteringEnabled(false);
    }),
    vscode.commands.registerCommand('repofocus.copyDiagnostics', copyDiagnostics),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('repofocus')) return;
      policy = readPolicy();
      alwaysShowPatterns = readAlwaysShowPatterns();
      const nextFetchInterval = readFetchIntervalMilliseconds();
      fetchScheduler.setInterval(nextFetchInterval);
      if (nextFetchInterval === 0) {
        remoteFailures.clear();
      } else if (nextFetchInterval !== fetchIntervalMilliseconds) {
        void fetchScheduler.refreshNow();
      }
      fetchIntervalMilliseconds = nextFetchInterval;
      evaluateAll();
      if (event.affectsConfiguration('repofocus.minimumRepositoryCount')) {
        void visibility.updateFiltering();
      }
      logger.info('Actionability policy changed.', {
        ...policy,
        alwaysShowPatterns: alwaysShowPatterns.length,
        fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
        minimumRepositoryCount: readMinimumRepositoryCount(),
      });
    }),
  );

  logger.info('RepoFocus started.', {
    version: extensionVersion,
    filteringEnabled,
    ...policy,
    alwaysShowPatterns: alwaysShowPatterns.length,
    fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
    minimumRepositoryCount: readMinimumRepositoryCount(),
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      monitor.dispose();
      visibility.dispose();
      fetchScheduler.dispose();
      await visibility.waitForIdle();
      await reconciler.shutdown();
      actionability.clear();
      remoteFailures.clear();
      logger.info('RepoFocus stopped.', { clean: true });
    })();
    return shutdownPromise;
  };
  activeRuntime = { shutdown };

  return {
    git,
    getActionability,
    isFilteringEnabled: () => filteringEnabled,
    isHiddenByRepoFocus: repository => reconciler.isHiddenByRepoFocus(repository),
    showAll: () => setFilteringEnabled(false),
    shutdown,
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

function readFetchIntervalMilliseconds(): number {
  const minutes = vscode.workspace.getConfiguration('repofocus').get('fetchIntervalMinutes', 5);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

function readAlwaysShowPatterns(): readonly string[] {
  return vscode.workspace.getConfiguration('repofocus').get<readonly string[]>('alwaysShow', []);
}

function readMinimumRepositoryCount(): number {
  const value = vscode.workspace.getConfiguration('repofocus').get('minimumRepositoryCount', 2);
  return Number.isSafeInteger(value) && value >= 1 ? value : 2;
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.shutdown();
}
