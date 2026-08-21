import * as vscode from 'vscode';
import { classifyRepository, type RepositoryActionability } from './actionability';
import { createAlwaysShowMatcher } from './alwaysShow';
import { createDiagnostics } from './diagnostics';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { Logger } from './logger';
import { NativeVisibilityCommandExecutor } from './nativeVisibilityCommandExecutor';
import { NativeVisibilityResetter } from './nativeVisibilityReset';
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
  shutdown(): Promise<void>;
  waitForSettled(): Promise<void>;
}

interface ActiveRuntime {
  shutdown(): Promise<void>;
}

let activeRuntime: ActiveRuntime | undefined;

async function activateGit(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension['exports']>(gitExtensionId);
  if (!extension) throw new Error('The built-in Git extension is unavailable.');
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

export async function activate(context: vscode.ExtensionContext): Promise<RepoFocusExtensionApi> {
  const git = await activateGit();
  const output = vscode.window.createOutputChannel('RepoFocus');
  const logger = new Logger(output, context.extensionMode === vscode.ExtensionMode.Development);
  const nativeVisibilityCommands = new NativeVisibilityCommandExecutor({
    execute: async command => {
      await vscode.commands.executeCommand(command);
    },
  });
  const manifest = context.extension.packageJSON as { version?: unknown };
  const extensionVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  context.subscriptions.push(output);

  const actionability = new Map<string, RepositoryActionability>();
  let alwaysShowPatterns = readAlwaysShowPatterns();
  let alwaysShowMatcher = createAlwaysShowMatcher(alwaysShowPatterns);
  let compatibilityFailureReported = false;

  const reconciler = new VisibilityReconciler({
    toggle: command => nativeVisibilityCommands.execute(command),
    onError: (error, failure) => {
      logger.error('Native visibility compatibility failed.', error, {
        strandedCommandCount: failure.strandedCommandCount,
      });
      void vscode.commands.executeCommand('setContext', 'repofocus.compatible', false);
      if (compatibilityFailureReported) return;
      compatibilityFailureReported = true;
      void vscode.window.showErrorMessage(
        `RepoFocus stopped filtering: ${error.message}`,
        'Copy Diagnostics',
        'Open Documentation',
        'Show Output',
      ).then(selection => {
        if (selection === 'Copy Diagnostics') {
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

  const readSelectionMode = (): string =>
    vscode.workspace.getConfiguration('scm')
      .get<string>('repositories.selectionMode', 'multiple');
  const nativeVisibilityResetter = new NativeVisibilityResetter({
    executeCommand: command => nativeVisibilityCommands.execute(command),
    getSelectionMode: readSelectionMode,
    onDidChangeSelectionMode: listener => vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scm.repositories.selectionMode')) listener();
    }),
  });

  let monitor: GitRepositoryMonitor;
  const visibility = new VisibilityMappingCoordinator({
    filteringRequested: () => filteringEnabled,
    getCommands: async () => await vscode.commands.getCommands(true),
    getRepositories: () => monitor?.repositories ?? [],
    topologyReady: () => git.state === 'initialized',
    resetNativeVisibility: async () => {
      logger.info('Establishing an all-visible native repository baseline.');
      await nativeVisibilityResetter.reset();
    },
    reconciler,
    onUnavailable: reason => {
      logger.info('Visibility filtering is not active.', { reason });
      if (reason === 'other-scm-providers') {
        void vscode.window.showWarningMessage(
          'RepoFocus supports windows whose Source Control providers are all Git repositories. '
          + 'Filtering is paused while another provider is present.',
        );
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
      value = classifyRepository({
        ...toActionabilityInput(repository.state),
        alwaysShow: alwaysShowMatcher(vscode.workspace.asRelativePath(repository.rootUri.fsPath)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      value = { actionable: true, reasons: [{ kind: 'error', detail }] };
    }
    actionability.set(repository.rootUri.toString(), value);
    reconciler.setActionability(repository, value);
  };

  let monitorReady = false;
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
      logger.info('Git repository topology changed.', {
        change: 'replaced',
        repositoryCount: monitor.repositories.length,
      });
      visibility.requestRefresh();
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
    if (state === 'initialized') visibility.requestRefresh();
  }));
  visibility.requestRefresh();

  const getActionability = (repository: GitRepository): RepositoryActionability | undefined =>
    actionability.get(repository.rootUri.toString());
  const evaluateAll = (): void => {
    for (const repository of monitor.repositories) evaluateRepository(repository);
  };

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
      alwaysShowPatternCount: alwaysShowPatterns.length,
    });
    await vscode.env.clipboard.writeText(diagnostics);
    void vscode.window.showInformationMessage('RepoFocus diagnostics copied to the clipboard.');
  };

  const waitForSettled = async (): Promise<void> => {
    await visibility.waitForIdle();
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
      if (!filteringEnabled) return;
      const explanation = describeMappingState(visibility.mappingState);
      if (explanation) void vscode.window.showInformationMessage(explanation);
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual visibility refresh requested.');
      alwaysShowPatterns = readAlwaysShowPatterns();
      alwaysShowMatcher = createAlwaysShowMatcher(alwaysShowPatterns);
      evaluateAll();
      visibility.retryIfUnavailable();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.copyDiagnostics', copyDiagnostics),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('scm.repositories.selectionMode')
        && !nativeVisibilityResetter.running
        && readSelectionMode() !== 'multiple'
      ) {
        visibility.requestRefresh();
      }
      if (!event.affectsConfiguration('repofocus.alwaysShow')) return;
      alwaysShowPatterns = readAlwaysShowPatterns();
      alwaysShowMatcher = createAlwaysShowMatcher(alwaysShowPatterns);
      evaluateAll();
      logger.info('Always-show patterns changed.', {
        alwaysShowPatterns: alwaysShowPatterns.length,
      });
    }),
  );

  logger.info('RepoFocus started.', {
    version: extensionVersion,
    gitState: git.state,
    repositoryCount: monitor.repositories.length,
    filteringEnabled,
    alwaysShowPatterns: alwaysShowPatterns.length,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      monitor.dispose();
      visibility.dispose();
      await visibility.waitForIdle();
      await reconciler.shutdown();
      nativeVisibilityCommands.dispose();
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
    shutdown,
    waitForSettled,
  };
}

function describeMappingState(state: string): string | undefined {
  switch (state) {
    case 'awaiting-native-commands':
      return 'RepoFocus is waiting for VS Code to create its internal repository-visibility '
        + 'commands. Keep Source Control open and run RepoFocus: Refresh.';
    case 'loading-repositories':
      return 'RepoFocus is waiting for VS Code to finish its initial Git repository scan.';
    case 'other-scm-providers':
      return 'RepoFocus supports windows whose Source Control providers are all Git repositories.';
    case 'incompatible':
      return 'RepoFocus stopped filtering because VS Code\'s internal visibility contract changed. '
        + 'Reload the window after copying diagnostics.';
    default:
      return undefined;
  }
}

function readAlwaysShowPatterns(): readonly string[] {
  return vscode.workspace.getConfiguration('repofocus').get<readonly string[]>('alwaysShow', []);
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.shutdown();
}
