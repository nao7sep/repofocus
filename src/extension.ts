import * as vscode from 'vscode';
import {
  classifyRepository,
  type ActionabilityPolicy,
  type RepositoryActionability,
} from './actionability';
import type { GitApi, GitExtension, GitRepository } from './gitApi';
import { GitRepositoryMonitor } from './gitRepositoryMonitor';
import { toActionabilityInput } from './repositoryStateAdapter';
import {
  resolveVisibilityCommands,
  type VisibilityMapping,
} from './visibilityCommandResolver';

const gitExtensionId = 'vscode.git';
const defaultPolicy: ActionabilityPolicy = {
  includeIncomingCommits: true,
  includeOutgoingCommits: true,
  includeUntrackedFiles: true,
};

export interface CompatibilityProbeResult {
  readonly mappings: readonly VisibilityMapping[];
  readonly repositoryCountBeforeToggle: number;
  readonly repositoryCountAfterToggle: number;
}

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
  getActionability(repository: GitRepository): RepositoryActionability | undefined;
  resolveVisibilityMappings(): Promise<readonly VisibilityMapping[]>;
  toggle(mapping: VisibilityMapping): Promise<void>;
  probe(mapping: VisibilityMapping): Promise<CompatibilityProbeResult>;
}

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
  const actionability = new Map<string, RepositoryActionability>();
  const monitor = new GitRepositoryMonitor(git, {
    onRepositoryChanged: repository => {
      try {
        actionability.set(
          repository.rootUri.toString(),
          classifyRepository(toActionabilityInput(repository.state), defaultPolicy),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        actionability.set(repository.rootUri.toString(), {
          actionable: true,
          reasons: [{ kind: 'error', detail }],
        });
      }
    },
    onRepositoryClosed: repository => actionability.delete(repository.rootUri.toString()),
  });
  context.subscriptions.push(monitor);

  const getActionability = (repository: GitRepository): RepositoryActionability | undefined =>
    actionability.get(repository.rootUri.toString());

  const resolveVisibilityMappings = async (): Promise<readonly VisibilityMapping[]> => {
    const commands = await vscode.commands.getCommands(true);
    return resolveVisibilityCommands(git.repositories, commands);
  };

  const toggle = async (mapping: VisibilityMapping): Promise<void> => {
    await vscode.commands.executeCommand(mapping.command);
  };

  const probe = async (mapping: VisibilityMapping): Promise<CompatibilityProbeResult> => {
    const repositoryCountBeforeToggle = git.repositories.length;
    await toggle(mapping);
    const repositoryCountAfterToggle = git.repositories.length;

    return {
      mappings: await resolveVisibilityMappings(),
      repositoryCountBeforeToggle,
      repositoryCountAfterToggle,
    };
  };

  return { git, getActionability, resolveVisibilityMappings, toggle, probe };
}

export function deactivate(): void {}
