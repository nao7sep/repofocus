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
import { nativeVisibilityLimitIssue } from './nativeVisibilityLimit';
import { RemoteFetchScheduler, type RemoteFetchTarget } from './remoteFetchScheduler';
import { toActionabilityInput } from './repositoryStateAdapter';
import { establishAllVisibleBaseline } from './visibilityBaseline';
import {
  resolveVisibilityCommands,
  type VisibilityMapping,
} from './visibilityCommandResolver';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';
const repositoryTopologySettleMilliseconds = 1_000;

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
  getActionability(repository: GitRepository): RepositoryActionability | undefined;
  isFilteringEnabled(): boolean;
  isHiddenByRepoFocus(repository: GitRepository): boolean;
  resolveVisibilityMappings(): Promise<readonly VisibilityMapping[]>;
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
  let mappingRefresh = Promise.resolve();
  let mappingRefreshGeneration = 0;
  let baselineEstablished = false;
  let stopping = false;
  let compatibilityFailureReported = false;

  const resolveVisibilityMappings = async (): Promise<readonly VisibilityMapping[]> => {
    const commands = await vscode.commands.getCommands(true);
    return resolveVisibilityCommands(git.repositories, commands);
  };

  const resolveSettledVisibilityMappings = async (
    generation: number,
  ): Promise<readonly VisibilityMapping[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (generation !== mappingRefreshGeneration || stopping) return [];
      try {
        return await resolveVisibilityMappings();
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Native visibility mapping failed.');
  };

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
  await reconciler.setFilteringEnabled(false);
  await vscode.commands.executeCommand('setContext', 'repofocus.compatible', true);
  await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', filteringEnabled);
  await vscode.commands.executeCommand('setContext', 'repofocus.hasError', false);

  const refreshMappings = async (generation: number): Promise<void> => {
    const nativeVisibleLimit = vscode.workspace.getConfiguration('scm').get('repositories.visible', 10);
    const visibleLimitIssue = nativeVisibilityLimitIssue(git.repositories.length, nativeVisibleLimit);
    if (visibleLimitIssue) {
      await reconciler.failCompatibility(new Error(visibleLimitIssue));
      return;
    }
    if (git.repositories.length > 0) {
      await vscode.commands.executeCommand('workbench.view.scm');
      await new Promise(resolve => setTimeout(resolve, 250));
      await vscode.commands.executeCommand('workbench.scm.focus');
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (generation !== mappingRefreshGeneration || stopping) return;
      try {
        if (git.repositories.length > 0) {
          await reconciler.resetForAllVisibleBaseline();
          if (generation !== mappingRefreshGeneration || stopping) return;
          const candidateMappings = await resolveSettledVisibilityMappings(generation);
          if (generation !== mappingRefreshGeneration || stopping) return;
          const baseline = await establishAllVisibleBaseline(
            git.repositories,
            candidateMappings,
            async command => {
              await vscode.commands.executeCommand(command);
            },
          );
          if (generation !== mappingRefreshGeneration || stopping) return;
          reconciler.adoptVisibility(baseline.mappings, baseline.hiddenRepositories);
          baselineEstablished = true;
          await reconciler.setFilteringEnabled(filteringEnabled);
          logger.info('Visibility filtering initialized.', {
            repositoryCount: baseline.mappings.length,
            actionableRepositoryCount: [...actionability.values()]
              .filter(value => value.actionable).length,
            hiddenRepositoryCount: reconciler.hiddenRepositoryCount,
            generation,
          });
        } else {
          const candidateMappings = await resolveSettledVisibilityMappings(generation);
          if (generation !== mappingRefreshGeneration || stopping) return;
          reconciler.replaceMappings(candidateMappings);
          await reconciler.setFilteringEnabled(filteringEnabled);
        }
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (generation !== mappingRefreshGeneration || stopping) return;
    await reconciler.failCompatibility(lastError ?? new Error('Native visibility mapping failed.'));
  };

  const scheduleMappingRefresh = (): void => {
    const generation = ++mappingRefreshGeneration;
    mappingRefresh = (async () => {
      await new Promise(resolve => setTimeout(resolve, repositoryTopologySettleMilliseconds));
      if (!stopping && generation === mappingRefreshGeneration) await refreshMappings(generation);
    })();
  };

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
    onRepositoryOpened: () => scheduleMappingRefresh(),
    onRepositoryChanged: evaluateRepository,
    onRepositoryClosed: repository => {
      const key = repository.rootUri.toString();
      actionability.delete(key);
      remoteFailures.delete(key);
      reconciler.removeRepository(repository);
      scheduleMappingRefresh();
    },
  });
  context.subscriptions.push(monitor);
  scheduleMappingRefresh();

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
      compatible: reconciler.compatible,
      baselineEstablished,
      repositoryStates: [...actionability.values()],
      hiddenByRepoFocusCount: reconciler.hiddenRepositoryCount,
      remoteFailureCount: remoteFailures.size,
      policy,
      alwaysShowPatternCount: alwaysShowPatterns.length,
      fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
    });
    await vscode.env.clipboard.writeText(diagnostics);
    void vscode.window.showInformationMessage('RepoFocus diagnostics copied to the clipboard.');
  };

  const waitForSettled = async (): Promise<void> => {
    let observedRefresh: Promise<void>;
    do {
      observedRefresh = mappingRefresh;
      await observedRefresh;
    } while (observedRefresh !== mappingRefresh);
    await fetchScheduler.waitForIdle();
    await reconciler.waitForIdle();
  };

  const setFilteringEnabled = async (enabled: boolean): Promise<void> => {
    filteringEnabled = enabled;
    await context.workspaceState.update(filteringStateKey, enabled);
    await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', enabled);
    if (enabled && !baselineEstablished) {
      scheduleMappingRefresh();
      await waitForSettled();
    } else {
      await reconciler.setFilteringEnabled(enabled);
    }
    logger.info('Filtering state changed.', { enabled });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repofocus.toggle', async () => {
      await setFilteringEnabled(!reconciler.enabled);
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
      logger.info('Actionability policy changed.', {
        ...policy,
        alwaysShowPatterns: alwaysShowPatterns.length,
        fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
      });
    }),
  );

  logger.info('RepoFocus started.', {
    version: extensionVersion,
    filteringEnabled,
    ...policy,
    alwaysShowPatterns: alwaysShowPatterns.length,
    fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      stopping = true;
      monitor.dispose();
      fetchScheduler.dispose();
      await mappingRefresh;
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
    resolveVisibilityMappings,
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

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.shutdown();
}
