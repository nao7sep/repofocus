import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { classifyRepository, type RepositoryActionability } from './actionability';
import { validateAlwaysShowPatterns } from './alwaysShow';
import { AlwaysShowMatcher } from './alwaysShowMatcher';
import { createDiagnostics } from './diagnostics';
import { FilteringPreference, readStoredFilteringEnabled } from './filteringPreference';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { Logger } from './logger';
import { NativeVisibilityCommandExecutor } from './nativeVisibilityCommandExecutor';
import { NativeVisibilityResetter } from './nativeVisibilityReset';
import { toActionabilityInput } from './repositoryStateAdapter';
import { describeFailure, describeMappingState, describeUnsavedFiltering } from './userMessages';
import { VisibilityMappingCoordinator } from './visibilityMappingCoordinator';
import { VisibilityReconciler } from './visibilityReconciler';

const gitExtensionId = 'vscode.git';
const filteringStateKey = 'repofocus.filteringEnabledByWorkspace';

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
  // VS Code activates an extension once; every later call joins that activation.
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

export async function activate(context: vscode.ExtensionContext): Promise<RepoFocusExtensionApi> {
  const output = vscode.window.createOutputChannel('RepoFocus');
  context.subscriptions.push(output);
  const logger = new Logger(output);
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
  const manifest = context.extension.packageJSON as { version?: unknown; homepage?: unknown };
  const extensionVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  const documentationUrl = typeof manifest.homepage === 'string' ? manifest.homepage : undefined;

  const actionability = new Map<string, RepositoryActionability>();
  let alwaysShow = readAlwaysShowConfiguration(logger);
  const alwaysShowMatcher = new AlwaysShowMatcher({
    createWorker: () => new Worker(context.asAbsolutePath('dist/alwaysShowWorker.js')),
  });
  alwaysShowMatcher.configure(alwaysShow);
  context.subscriptions.push(alwaysShowMatcher);
  const loggedMatcherFailures = new WeakSet<Error>();
  let compatibilityFailureReported = false;

  const reconciler = new VisibilityReconciler({
    toggle: command => nativeVisibilityCommands.execute(command),
    resetToAllVisible: async () => {
      logger.warn('Recovering a failed native visibility application with an all-visible reset.');
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
        ...(documentationUrl ? ['Open Documentation'] : []),
        'Show Output',
      ).then(async selection => {
        if (selection === 'Copy Diagnostics') {
          void vscode.commands.executeCommand('repofocus.copyDiagnostics');
        } else if (selection === 'Open Documentation' && documentationUrl) {
          try {
            if (!await vscode.env.openExternal(vscode.Uri.parse(documentationUrl))) {
              throw new Error('VS Code could not open the documentation URL.');
            }
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
  });
  await vscode.commands.executeCommand('setContext', 'repofocus.compatible', true);
  await vscode.commands.executeCommand('setContext', 'repofocus.filteringEnabled', initialFilteringEnabled);

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
          + 'Filtering is paused while another provider is present. '
          + 'Show hidden repositories in Source Control\'s Repositories view.',
        );
      }
    },
    onInitialized: event => {
      logger.info('Visibility filtering initialized.', {
        repositoryCount: event.repositoryCount,
        actionableRepositoryCount: [...actionability.values()]
          .filter(value => value.actionable).length,
        hiddenRepositoryCount: reconciler.hiddenRepositoryCount,
      });
    },
  });
  context.subscriptions.push(visibility);

  const nativeVisibilityResetter = new NativeVisibilityResetter({
    executeCommand: command => nativeVisibilityCommands.execute(command),
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
    let matchingFailure: Error | undefined;
    try {
      const key = repository.rootUri.toString();
      const patternResult = alwaysShowMatcher.evaluate(
        key,
        vscode.workspace.asRelativePath(repository.rootUri.fsPath),
        () => {
          // The result belongs to this repository and settings generation. Read
          // current Git state rather than publishing the submitted snapshot.
          if (monitor?.getRepository(key) === repository) evaluateRepository(repository);
        },
      );
      if (patternResult.kind === 'failed') {
        matchingFailure = patternResult.error;
        throw matchingFailure;
      }
      value = classifyRepository({
        ...toActionabilityInput(repository.state),
        alwaysShow: patternResult.kind === 'matched' && patternResult.matches,
      });
      // Unknown matching is provisional visibility, not an evaluation failure.
      if (patternResult.kind === 'pending') value = { ...value, actionable: true };
    } catch (error) {
      evaluationError = error;
      const detail = error instanceof Error ? error.message : String(error);
      value = { actionable: true, reasons: [{ kind: 'error', detail }] };
    }
    const errorDetails = value.reasons.flatMap(reason => reason.kind === 'error' ? [reason.detail] : []);
    const repeatedMatcherFailure = matchingFailure !== undefined
      && loggedMatcherFailures.has(matchingFailure);
    if (errorDetails.length > 0 && !repeatedMatcherFailure) {
      logger.warn('Repository evaluation failed; the repository stays visible.', {
        repository: repository.rootUri.fsPath,
        errors: errorDetails,
      }, evaluationError);
      if (matchingFailure) loggedMatcherFailures.add(matchingFailure);
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
    onRepositoryReplaced: repository => {
      alwaysShowMatcher.forget(repository.rootUri.toString());
      if (!monitorReady) return;
      logger.info('Git repository topology changed.', {
        change: 'replaced',
        repositoryCount: monitor.repositories.length,
      });
      visibility.requestRefresh();
    },
    onRepositoryChanged: evaluateRepository,
    onRepositoryClosed: repository => {
      alwaysShowMatcher.forget(repository.rootUri.toString());
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
      await vscode.env.clipboard.writeText(diagnostics);
    } catch (error) {
      logger.error('Copy diagnostics failed.', error);
      void vscode.window.showErrorMessage(describeFailure('copy-diagnostics', error));
      return;
    }
    logger.info('Copy diagnostics completed.', { characterCount: diagnostics.length });
    void vscode.window.showInformationMessage('RepoFocus diagnostics copied to the clipboard.');
  };

  const waitForSettled = async (): Promise<void> => {
    await alwaysShowMatcher.waitForIdle();
    await visibility.waitForIdle();
  };

  let toggleRevision = 0;
  context.subscriptions.push(
    vscode.commands.registerCommand('repofocus.toggle', async () => {
      const revision = ++toggleRevision;
      try {
        const { enabled, saveError, contextError } = await filteringPreference.toggle();
        logger.info('Filtering preference changed.', { enabled });
        if (contextError !== undefined) {
          logger.warn('Filtering context update failed; the Refresh button may not match.', {}, contextError);
        }
        if (saveError !== undefined) {
          logger.error('Saving the filtering preference failed.', saveError, { enabled });
        }
        // A later request owns the result even if it returns to the same value.
        if (revision !== toggleRevision) return;
        if (saveError !== undefined) void vscode.window.showWarningMessage(describeUnsavedFiltering(enabled));
        if (!enabled) return;
        const explanation = describeMappingState(visibility.mappingState);
        if (explanation) void vscode.window.showInformationMessage(explanation);
      } catch (error) {
        logger.error('Filtering change failed.', error);
        if (revision !== toggleRevision) return;
        void vscode.window.showErrorMessage(describeFailure('toggle', error));
      }
    }),
    vscode.commands.registerCommand('repofocus.refresh', async () => {
      logger.info('Manual visibility refresh requested.');
      alwaysShow = readAlwaysShowConfiguration(logger);
      alwaysShowMatcher.configure(alwaysShow);
      evaluateAll();
      visibility.refresh();
      await waitForSettled();
    }),
    vscode.commands.registerCommand('repofocus.copyDiagnostics', copyDiagnostics),
    vscode.workspace.onDidChangeWorkspaceFolders(() => evaluateAll()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('repofocus.alwaysShow')) return;
      alwaysShow = readAlwaysShowConfiguration(logger);
      alwaysShowMatcher.configure(alwaysShow);
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
  const configuration = validateAlwaysShowPatterns(value);
  if (!configuration.valid) {
    logger.warn('The alwaysShow setting is invalid; it reads as its built-in empty list.', {
      alwaysShowPatterns: configuration.patternCount,
    });
  }
  return configuration;
}
