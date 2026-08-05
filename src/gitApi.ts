import type { Extension } from 'vscode';

export interface DisposableLike {
  dispose(): void;
}

export type EventLike<T> = (listener: (event: T) => unknown) => DisposableLike;

export interface UriLike {
  readonly fsPath: string;
  toString(): string;
}

export interface GitChange {
  readonly uri: UriLike;
  readonly status: number;
}

export const gitStatus = {
  untracked: 7,
} as const;

export interface GitUpstreamRef {
  readonly remote: string;
  readonly name: string;
}

export interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: GitUpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitRemote {
  readonly name: string;
}

export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly remotes: readonly GitRemote[];
  readonly rebaseCommit: object | undefined;
  readonly mergeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly workingTreeChanges: readonly GitChange[];
  readonly untrackedChanges: readonly GitChange[];
  readonly onDidChange: EventLike<void>;
}

export interface GitRepository {
  readonly rootUri: UriLike;
  readonly state: GitRepositoryState;
  status(): Promise<void>;
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: EventLike<GitRepository>;
  readonly onDidCloseRepository: EventLike<GitRepository>;
}

export interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

export type GitExtension = Extension<GitExtensionExports>;
