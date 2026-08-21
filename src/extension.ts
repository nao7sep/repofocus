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
import { resetNativeRepositoryVisibility } from './nativeVisibilityReset';
import { RemoteFetchScheduler, type RemoteFetchTarget } from './remoteFetchScheduler';
import { toActionabilityInput } from './repositoryStateAdapter';
import { VisibilityMappingCoordinator } from './visibilityMappingCoordinator';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';
const visibilityAuditIntervalMilliseconds = 60_000;

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
  // Bound once the fetch scheduler exists; it owns every remote-failure fact.
  let remoteFailure: (key: string) => string | undefined = () => undefined;
  let policy = readPolicy();
  let alwaysShowPatterns = readAlwaysShowPatterns();
  let compatibilityFailureReported = false;

  const reconciler = new VisibilityReconciler({
    toggle: async command => {
      await vscode.commands.executeCommand(command);
    },
    onError: (error, failure) => {
      logger.error('Native visibility compatibility failed.', error, {
        strandedCommandCount: failure.strandedCommandCount,
      });
      void vscode.commands.executeCommand('setContext', 'repofocus.compatible', false);
      void vscode.commands.executeCommand('setContext', 'repofocus.hasError', true);
      if (compatibilityFailureReported) return;
      compatibilityFailureReported = true;
      // Offer only what can act in this state: with nothing left hidden,
      // "Show All Repositories" would be a button that does nothing.
      const actions = failure.strandedCommandCount > 0
        ? ['Show All Repositories', 'Copy Diagnostics', 'Open Documentation', 'Show Output']
        : ['Copy Diagnostics', 'Open Documentation', 'Show Output'];
      const stranded = failure.strandedCommandCount > 0
        ? ` ${failure.strandedCommandCount} repositories may still be hidden.`
        : '';
      void vscode.window.showErrorMessage(
        `RepoFocus disabled filtering: ${error.message}${stranded}`,
        ...actions,
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

  const readSelectionMode = (): string =>
    vscode.workspace.getConfiguration('scm')
      .get<string>('repositories.selectionMode', 'multiple');
  let resettingNativeVisibility = false;
  const resetAllNativeVisibility = async (): Promise<void> => {
    resettingNativeVisibility = true;
    try {
      await resetNativeRepositoryVisibility({
        executeCommand: async command => {
          await vscode.commands.executeCommand(command);
        },
        getSelectionMode: readSelectionMode,
        onDidChangeSelectionMode: listener => vscode.workspace.onDidChangeConfiguration(event => {
          if (event.affectsConfiguration('scm.repositories.selectionMode')) listener();
        }),
      });
    } finally {
      resettingNativeVisibility = false;
    }
  };
  const recoverHiddenBaseline = async (): Promise<void> => {
    logger.warn('Resetting native repository visibility after detecting a hidden startup state.');
    await resetAllNativeVisibility();
    logger.info('Native repository visibility reset completed.');
  };

  let monitor: GitRepositoryMonitor;

  const visibility = new VisibilityMappingCoordinator({
    filteringRequested: () => filteringEnabled,
    getCommands: async () => await vscode.commands.getCommands(true),
    getRepositories: () => monitor?.repositories ?? [],
    topologyReady: () => git.state === 'initialized',
    recoverHiddenBaseline,
    minimumRepositoryCount: readMinimumRepositoryCount,
    multipleSelectionMode: () => readSelectionMode() !== 'single',
    reconciler,
    onUnavailable: reason => {
      logger.info('Visibility filtering is not active.', { reason });
      if (reason === 'repositories-already-hidden') {
        void vscode.window.showWarningMessage(
          'RepoFocus cannot filter while repositories are already hidden in the Source Control '
          + 'Repositories view, because VS Code offers no way to identify them.',
          'Reveal All Repositories',
        ).then(selection => {
          if (selection) void vscode.commands.executeCommand('repofocus.revealAll');
        });
      } else if (reason === 'other-scm-providers') {
        void vscode.window.showWarningMessage(
          'RepoFocus only supports workspaces where every Source Control provider is a Git '
          + 'repository, and another provider is active. Filtering is paused, not broken — run '
          + 'RepoFocus: Refresh once that provider is gone.',
        );
      } else if (reason === 'single-selection-mode') {
        void vscode.window.showWarningMessage(
          'RepoFocus needs VS Code\'s Source Control repository selection mode set to "multiple".',
          'Open Setting',
        ).then(selection => {
          if (selection) {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'scm.repositories.selectionMode',
            );
          }
        });
      }
    },
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
        // No includeWorkspaceFolder argument on purpose. VS Code's own default is
        // "true when there are multiple workspace folders and false otherwise",
        // which is what alwaysShow wants: a single-folder workspace keeps plain
        // subpaths, and a repository NESTED inside a multi-root folder keeps that
        // folder prepended rather than being stripped to a bare subpath, which is
        // what an explicit `false` did. For a repository that IS a workspace folder
        // the argument is inert — measured in a live Extension Host, `true`, `false`
        // and the default all return the absolute path, because there is no relative
        // form to produce. That shape is matched by name instead; see alwaysShow.
        alwaysShow: matchesAlwaysShow(
          vscode.workspace.asRelativePath(repository.rootUri.fsPath),
          alwaysShowPatterns,
        ),
        evaluationError: remoteFailure(repository.rootUri.toString()),
      }, policy);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      value = { actionable: true, reasons: [{ kind: 'error', detail }] };
    }
    actionability.set(repository.rootUri.toString(), value);
    reconciler.setActionability(repository, value);
  };

  let monitorReady = false;
  let fetchScheduler: RemoteFetchScheduler | undefined;
  monitor = new GitRepositoryMonitor(git, {
    onRepositoryOpened: () => {
      if (!monitorReady || git.state !== 'initialized') return;
      logger.info('Git repository topology changed.', {
        change: 'opened',
        repositoryCount: monitor.repositories.length,
      });
      visibility.requestRefresh();
    },
    onRepositoryReplaced: () => {
      if (!monitorReady) return;
      logger.debug('Git repository observation replaced.', {
        repositoryCount: monitor.repositories.length,
      });
    },
    onRepositoryChanged: evaluateRepository,
    onRepositoryClosed: repository => {
      actionability.delete(repository.rootUri.toString());
      reconciler.removeRepository(repository);
      if (!monitorReady || git.state !== 'initialized') return;
      logger.info('Git repository topology changed.', {
        change: 'closed',
        repositoryCount: monitor.repositories.length,
      });
      visibility.requestRefresh();
    },
  });
  monitorReady = true;
  context.subscriptions.push(monitor);
  context.subscriptions.push(git.onDidChangeState(state => {
    logger.info('Git repository discovery state changed.', {
      state,
      repositoryCount: monitor.repositories.length,
    });
    if (state === 'initialized') {
      visibility.requestRefresh();
      void fetchScheduler?.refreshNow();
    }
  }));
  visibility.requestRefresh();

  const getActionability = (repository: GitRepository): RepositoryActionability | undefined =>
    actionability.get(repository.rootUri.toString());

  const evaluateAll = (): void => {
    for (const repository of monitor.repositories) evaluateRepository(repository);
  };

  interface RepositoryFetchTarget extends RemoteFetchTarget {
    readonly repository: GitRepository;
  }
  fetchScheduler = new RemoteFetchScheduler({
    concurrency: 2,
    getTargets: () => {
      if (git.state !== 'initialized') return [];
      if (!policy.includeIncomingCommits && !policy.includeOutgoingCommits) return [];
      return monitor.repositories
        .filter(repository => repository.state.remotes.length > 0)
        .map((repository): RepositoryFetchTarget => ({
          key: repository.rootUri.toString(),
          repository,
          isLive: () => monitor.getRepository(repository.rootUri.toString()) === repository,
          fetch: () => repository.fetch(),
        }));
    },
    onSuccess: target => {
      const { repository } = target as RepositoryFetchTarget;
      evaluateRepository(repository);
    },
    onError: target => {
      const { repository } = target as RepositoryFetchTarget;
      evaluateRepository(repository);
      // Built-in Git fetch errors can embed credential-bearing remote URLs, so
      // this boundary deliberately records no raw exception text.
      logger.error('Remote refresh failed.', new Error('Built-in Git fetch failed.'));
    },
    onRunStart: repositoryCount => {
      logger.info('Remote refresh started.', { repositoryCount });
    },
    onRunComplete: result => {
      logger.info('Remote refresh completed.', { ...result });
      void visibility.audit();
    },
  });
  context.subscriptions.push(fetchScheduler);
  remoteFailure = key => fetchScheduler.hasFailed(key) ? 'Remote refresh failed.' : undefined;
  let fetchIntervalMilliseconds = readFetchIntervalMilliseconds();
  fetchScheduler.setInterval(fetchIntervalMilliseconds);
  if (fetchIntervalMilliseconds > 0) void fetchScheduler.refreshNow();
  const visibilityAuditTimer = setInterval(() => {
    void visibility.audit();
  }, visibilityAuditIntervalMilliseconds);
  context.subscriptions.push({ dispose: () => clearInterval(visibilityAuditTimer) });

  const copyDiagnostics = async (): Promise<void> => {
    const diagnostics = createDiagnostics({
      extensionVersion,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      gitApiState: git.state,
      filteringEnabled,
      filteringActive: reconciler.enabled,
      compatible: reconciler.compatible,
      baselineEstablished: visibility.baselineEstablished,
      nativeMappingState: visibility.mappingState,
      repositoryStates: [...actionability.values()],
      hiddenByRepoFocusCount: reconciler.hiddenRepositoryCount,
      remoteFailureCount: fetchScheduler.failureCount,
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
      // Turning filtering on when it cannot run would otherwise look like a
      // button that does nothing, with the reason only in copied diagnostics.
      if (!filteringEnabled) return;
      const explanation = describeMappingState(visibility.mappingState);
      if (explanation) void vscode.window.showInformationMessage(explanation);
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual refresh requested.');
      policy = readPolicy();
      alwaysShowPatterns = readAlwaysShowPatterns();
      await fetchScheduler.refreshNow();
      evaluateAll();
      visibility.retryIfUnavailable();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.showAll', async () => {
      logger.info('Show all repositories requested.');
      await setFilteringEnabled(false);
    }),
    vscode.commands.registerCommand('repofocus.copyDiagnostics', copyDiagnostics),
    vscode.commands.registerCommand('repofocus.revealAll', async () => {
      // The only mechanism VS Code exposes for restoring an all-visible list,
      // and it writes a setting — so it happens on an explicit act, disclosed.
      const confirmed = await vscode.window.showWarningMessage(
        'Reveal every repository in the Source Control Repositories view?',
        {
          modal: true,
          detail: 'This changes VS Code\'s scm.repositories.selectionMode setting, which is the '
            + 'only way VS Code offers to restore an all-visible repository list.',
        },
        'Reveal All',
      );
      if (confirmed !== 'Reveal All') return;
      await resetAllNativeVisibility();
      logger.info('Revealed all repositories through the native selection-mode transition.');
      visibility.requestRefresh();
      await visibility.waitForIdle();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      // A selection-mode change can make filtering possible again.
      if (
        event.affectsConfiguration('scm.repositories.selectionMode')
        && !resettingNativeVisibility
      ) {
        visibility.requestRefresh();
      }
      if (!event.affectsConfiguration('repofocus')) return;
      policy = readPolicy();
      alwaysShowPatterns = readAlwaysShowPatterns();
      const nextFetchInterval = readFetchIntervalMilliseconds();
      fetchScheduler.setInterval(nextFetchInterval);
      if (nextFetchInterval > 0 && nextFetchInterval !== fetchIntervalMilliseconds) {
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
    gitState: git.state,
    repositoryCount: monitor.repositories.length,
    filteringEnabled,
    ...policy,
    alwaysShowPatterns: alwaysShowPatterns.length,
    fetchIntervalMinutes: fetchIntervalMilliseconds / 60_000,
    minimumRepositoryCount: readMinimumRepositoryCount(),
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      clearInterval(visibilityAuditTimer);
      monitor.dispose();
      visibility.dispose();
      fetchScheduler.dispose();
      await visibility.waitForIdle();
      await reconciler.shutdown();
      actionability.clear();
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

function describeMappingState(state: string): string | undefined {
  switch (state) {
    case 'awaiting-native-commands':
      return 'RepoFocus is waiting for VS Code to create its internal repository-visibility '
        + 'commands. Open the Source Control view once and filtering will start.';
    case 'loading-repositories':
      return 'RepoFocus is waiting for VS Code to finish its initial Git repository scan.';
    case 'repositories-already-hidden':
      return 'RepoFocus cannot filter while repositories are already hidden in the Source '
        + 'Control Repositories view. Run RepoFocus: Reveal All Repositories in Source Control.';
    case 'single-selection-mode':
      return 'RepoFocus needs VS Code\'s repository selection mode set to "multiple".';
    case 'other-scm-providers':
      return 'RepoFocus only supports workspaces where every Source Control provider is a Git '
        + 'repository, and another provider is active. Run RepoFocus: Refresh once it is gone.';
    case 'incompatible':
      return 'RepoFocus stopped filtering because VS Code\'s internal visibility commands '
        + 'changed. Reload the window after checking RepoFocus: Copy Diagnostics.';
    default:
      return undefined;
  }
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
