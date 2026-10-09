import * as vscode from 'vscode';
import { classifyRepository, type RepositoryActionability } from './actionability';
import { compileAlwaysShowConfiguration } from './alwaysShow';
import { createDiagnostics } from './diagnostics';
import { FilteringPreference, readStoredFilteringEnabled } from './filteringPreference';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { OneShotHostOperation, waitForHostOperation } from './hostOperation';
import { Logger } from './logger';
import {
  NativeVisibilityCommandExecutor,
  NATIVE_VISIBILITY_COMMAND_TIMEOUT_MILLISECONDS,
} from './nativeVisibilityCommandExecutor';
import { NativeVisibilityResetter } from './nativeVisibilityReset';
import { toActionabilityInput } from './repositoryStateAdapter';
import { describeFailure, describeMappingState, describeUnsavedFiltering } from './userMessages';
import { VisibilityMappingCoordinator } from './visibilityMappingCoordinator';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';
const gitActivationTimeoutMilliseconds = 10_000;
const hostWriteTimeoutMilliseconds = 10_000;
const gitActivation = new OneShotHostOperation<GitExtension['exports']>();

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
  getActionability(repository: GitRepository): RepositoryActionability | undefined;
  isFilteringEnabled(): boolean;
  isHiddenByRepoFocus(repository: GitRepository): boolean;
  waitForSettled(): Promise<void>;
}

async function activateGit(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension['exports']>(gitExtensionId);
  if (!extension) throw new Error('The built-in Git extension is unavailable.');
  const exports = extension.isActive
    ? extension.exports
    : await gitActivation.wait(
        () => extension.activate(),
        gitActivationTimeoutMilliseconds,
        'Built-in Git extension activation',
      );
  return exports.getAPI(1);
}

export async function activate(context: vscode.ExtensionContext): Promise<RepoFocusExtensionApi> {
  const output = vscode.window.createOutputChannel('RepoFocus');
  context.subscriptions.push(output);
  const logger = new Logger(output, context.extensionMode === vscode.ExtensionMode.Development);
  try {
    return await start(context, output, logger);
  } catch (error) {
    logger.error('RepoFocus activation failed.', error);
    throw error;
  }
}

async function start(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  logger: Logger,
): Promise<RepoFocusExtensionApi> {
  const git = await activateGit();
  const nativeVisibilityCommands = new NativeVisibilityCommandExecutor({
    execute: async command => {
      await vscode.commands.executeCommand(command);
    },
  });
  // VS Code cuts this extension's connection to the workbench before it
  // disposes these subscriptions, so stopping cannot re-show repositories or
  // write settings. Each owner only stops its local timers and work.
  context.subscriptions.push(nativeVisibilityCommands);
  const manifest = context.extension.packageJSON as { version?: unknown };
  const extensionVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';

  const actionability = new Map<string, RepositoryActionability>();
  let alwaysShow = readAlwaysShowConfiguration(logger);
  let compatibilityFailureReported = false;

  const reconciler = new VisibilityReconciler({
    toggle: command => nativeVisibilityCommands.execute(command),
    resetToAllVisible: async () => {
      logger.warn('Recovering an ambiguous native visibility result with an all-visible reset.');
      await nativeVisibilityCommands.waitForIdle(NATIVE_VISIBILITY_COMMAND_TIMEOUT_MILLISECONDS);
      await nativeVisibilityResetter.reset();
    },
    onError: (error, failure) => {
      logger.error('Native visibility compatibility failed.', error, {
        strandedCommandCount: failure.strandedCommandCount,
      });
      void vscode.commands.executeCommand('setContext', 'repofocus.compatible', false);
      if (compatibilityFailureReported) return;
      compatibilityFailureReported = true;
      void vscode.window.showErrorMessage(
        describeFailure('compatibility', error),
        'Copy Diagnostics',
        'Open Documentation',
        'Show Output',
      ).then(async selection => {
        if (selection === 'Copy Diagnostics') {
          void vscode.commands.executeCommand('repofocus.copyDiagnostics');
        } else if (selection === 'Open Documentation') {
          try {
            await vscode.env.openExternal(vscode.Uri.parse(
              'https://github.com/nao7sep/repofocus#compatibility-and-safety',
            ));
          } catch (openError) {
            logger.error('Opening the documentation failed.', openError);
            void vscode.window.showErrorMessage(describeFailure('open-documentation', openError));
          }
        } else if (selection === 'Show Output') {
          output.show(true);
        }
      });
    },
  });
  context.subscriptions.push(reconciler);

  const initialFilteringEnabled = readStoredFilteringEnabled(context.workspaceState.get<unknown>(filteringStateKey));
  const filteringPreference = new FilteringPreference({
    initialValue: initialFilteringEnabled,
    apply: () => visibility.updateFiltering(),
    persist: enabled => context.workspaceState.update(filteringStateKey, enabled),
    publishContext: async enabled => {
      await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', enabled);
    },
    hostWriteTimeoutMilliseconds,
  });
  await waitForHostOperation(
    Promise.resolve(vscode.commands.executeCommand('setContext', 'repofocus.compatible', true)),
    hostWriteTimeoutMilliseconds,
    'Compatibility context update',
  );
  await waitForHostOperation(
    Promise.resolve(vscode.commands.executeCommand(
      'setContext',
      'repofocus.filteringEnabled',
      initialFilteringEnabled,
    )),
    hostWriteTimeoutMilliseconds,
    'Filtering context update',
  );

  let monitor: GitRepositoryMonitor;
  const visibility = new VisibilityMappingCoordinator({
    filteringRequested: () => filteringPreference.current,
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
  context.subscriptions.push(visibility);

  const nativeVisibilityResetter = new NativeVisibilityResetter({
    executeCommand: command => nativeVisibilityCommands.execute(command),
    waitForCommandSettlement: (milliseconds, signal) => nativeVisibilityCommands.waitForIdle(milliseconds, signal),
    getSelectionMode: () => vscode.workspace.getConfiguration('scm')
      .get<string>('repositories.selectionMode', 'multiple'),
    onDidChangeSelectionMode: listener => vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('scm.repositories.selectionMode')) listener();
    }),
    onForeignDeparture: () => visibility.requestRefresh(),
    onForeignReset: () => {
      logger.info('Repository selection mode returned to multiple outside RepoFocus.');
      visibility.acceptForeignReset();
    },
  });
  context.subscriptions.push(nativeVisibilityResetter);

  const evaluateRepository = (repository: GitRepository): void => {
    let value: RepositoryActionability;
    let evaluationError: unknown;
    try {
      value = classifyRepository({
        ...toActionabilityInput(repository.state),
        alwaysShow: alwaysShow.matches(vscode.workspace.asRelativePath(repository.rootUri.fsPath)),
      });
    } catch (error) {
      evaluationError = error;
      const detail = error instanceof Error ? error.message : String(error);
      value = { actionable: true, reasons: [{ kind: 'error', detail }] };
    }
    const errorDetails = value.reasons.flatMap(reason => reason.kind === 'error' ? [reason.detail] : []);
    if (errorDetails.length > 0) {
      logger.warn('Repository evaluation failed; the repository stays visible.', {
        repository: repository.rootUri.fsPath,
        errors: errorDetails,
      }, evaluationError);
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
    logger.info('Copy diagnostics requested.');
    const diagnostics = createDiagnostics({
      extensionVersion,
      vscodeVersion: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      gitApiState: git.state,
      filteringEnabled: filteringPreference.current,
      filteringActive: reconciler.enabled,
      compatible: reconciler.compatible,
      baselineEstablished: visibility.baselineEstablished,
      nativeMappingState: visibility.mappingState,
      repositoryStates: [...actionability.values()],
      hiddenByRepoFocusCount: reconciler.hiddenRepositoryCount,
      alwaysShowPatternCount: alwaysShow.patternCount,
    });
    try {
      await waitForHostOperation(
        Promise.resolve(vscode.env.clipboard.writeText(diagnostics)),
        hostWriteTimeoutMilliseconds,
        'Diagnostics clipboard write',
      );
    } catch (error) {
      logger.error('Copy diagnostics failed.', error);
      void vscode.window.showErrorMessage(describeFailure('copy-diagnostics', error));
      return;
    }
    logger.info('Copy diagnostics completed.', { characterCount: diagnostics.length });
    void vscode.window.showInformationMessage('RepoFocus diagnostics copied to the clipboard.');
  };

  const waitForSettled = async (): Promise<void> => {
    await visibility.waitForIdle();
    await reconciler.waitForIdle();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repofocus.toggle', async () => {
      try {
        const { enabled, saveError, contextError } = await filteringPreference.toggle();
        logger.info('Filtering preference changed.', { enabled });
        if (contextError !== undefined) {
          logger.warn('Filtering context update failed; the Refresh button may not match.', {}, contextError);
        }
        if (saveError !== undefined) {
          logger.error('Saving the filtering preference failed.', saveError, { enabled });
        }
        // A later toggle has replaced this value and reports for itself; its
        // save supersedes this one.
        if (filteringPreference.current !== enabled) return;
        if (saveError !== undefined) void vscode.window.showWarningMessage(describeUnsavedFiltering(enabled));
        if (!enabled) return;
        const explanation = describeMappingState(visibility.mappingState);
        if (explanation) void vscode.window.showInformationMessage(explanation);
      } catch (error) {
        logger.error('Filtering change failed.', error);
        void vscode.window.showErrorMessage(describeFailure('toggle', error));
      }
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual visibility refresh requested.');
      alwaysShow = readAlwaysShowConfiguration(logger);
      evaluateAll();
      visibility.retryIfUnavailable();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.copyDiagnostics', copyDiagnostics),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('repofocus.alwaysShow')) return;
      alwaysShow = readAlwaysShowConfiguration(logger);
      evaluateAll();
      logger.info('Always-show patterns changed.', {
        alwaysShowPatterns: alwaysShow.patternCount,
        valid: alwaysShow.valid,
      });
    }),
  );

  logger.info('RepoFocus started.', {
    version: extensionVersion,
    gitState: git.state,
    repositoryCount: monitor.repositories.length,
    filteringEnabled: filteringPreference.current,
    alwaysShowPatterns: alwaysShow.patternCount,
    alwaysShowConfigurationValid: alwaysShow.valid,
  });

  return {
    git,
    getActionability,
    isFilteringEnabled: () => filteringPreference.current,
    isHiddenByRepoFocus: repository => reconciler.isHiddenByRepoFocus(repository),
    waitForSettled,
  };
}

function readAlwaysShowConfiguration(logger: Logger) {
  const value = vscode.workspace.getConfiguration('repofocus').get<unknown>('alwaysShow', []);
  const configuration = compileAlwaysShowConfiguration(value);
  if (!configuration.valid) {
    logger.warn('The alwaysShow setting is invalid; it reads as its built-in empty list.', {
      alwaysShowPatterns: configuration.patternCount,
    });
  }
  return configuration;
}
