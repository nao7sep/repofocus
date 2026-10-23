import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import type { GitRepository } from '../../src/gitApi';

interface NativeRepository { readonly id: string; readonly uri: string }
interface NativeState { readonly visible: readonly NativeRepository[]; readonly selected: NativeRepository | null }
export async function nativeState(): Promise<NativeState> {
  const state = await vscode.commands.executeCommand<NativeState>('repofocus.test.nativeState');
  assert(state, 'The disposable host must expose the independent SCM service oracle.');
  return state;
}
export async function assertNativeVisible(repositories: readonly GitRepository[]): Promise<void> {
  const state = await nativeState();
  assert.deepEqual(state.visible.map(row => row.uri).sort(), repositories.map(r => r.rootUri.toString()).sort(),
    'Actual native SCM visible repositories must match the desired set.');
}
