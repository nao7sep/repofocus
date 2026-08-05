import * as vscode from 'vscode';
import type { GitApi, GitExtension } from './gitApi';
import {
  resolveVisibilityCommands,
  type VisibilityMapping,
} from './visibilityCommandResolver';

const gitExtensionId = 'vscode.git';

export interface CompatibilityProbeResult {
  readonly mappings: readonly VisibilityMapping[];
  readonly repositoryCountBeforeToggle: number;
  readonly repositoryCountAfterToggle: number;
}

export interface RepoFocusExtensionApi {
  readonly git: GitApi;
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

export async function activate(): Promise<RepoFocusExtensionApi> {
  const git = await activateGit();

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

  return { git, resolveVisibilityMappings, toggle, probe };
}

export function deactivate(): void {}
