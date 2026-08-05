import type { Event, Extension, Uri } from 'vscode';

export interface GitChange {
  readonly uri: Uri;
}

export interface GitRepositoryState {
  readonly mergeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly workingTreeChanges: readonly GitChange[];
  readonly untrackedChanges: readonly GitChange[];
  readonly onDidChange: Event<void>;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: GitRepositoryState;
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

export type GitExtension = Extension<GitExtensionExports>;
