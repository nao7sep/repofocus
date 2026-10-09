import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  describeMappingState,
  describeUnsavedFiltering,
  type FailedOperation,
} from '../src/userMessages';

const sentinel = 'SENTINEL-7f3a';

function hostileError(): Error {
  const error = new TypeError(
    `ENOENT: EACCES at /Users/someone/.vscode/extensions/internal/state.json ${sentinel}`,
    { cause: new Error(`inner ${sentinel}`) },
  );
  (error as Error & { code?: string }).code = 'ERR_INTERNAL_ASSERTION';
  return error;
}

function expectAuthored(message: string): void {
  expect(message).not.toContain(sentinel);
  expect(message).not.toContain('TypeError');
  expect(message).not.toContain('ENOENT');
  expect(message).not.toContain('ERR_INTERNAL_ASSERTION');
  expect(message).not.toContain('/Users/');
}

describe('describeFailure', () => {
  it.each<FailedOperation>([
    'compatibility',
    'copy-diagnostics',
    'open-documentation',
    'toggle',
  ])('shows only authored copy for %s', operation => {
    const message = describeFailure(operation, hostileError());

    expectAuthored(message);
    expect(message.length).toBeGreaterThan(0);
  });

  it('reuses the incompatible mapping copy when filtering stops', () => {
    expect(describeFailure('compatibility', hostileError())).toBe(describeMappingState('incompatible'));
  });

  it('names the clipboard when diagnostics cannot be copied', () => {
    expect(describeFailure('copy-diagnostics', hostileError()))
      .toBe('Couldn\'t copy the diagnostics to the clipboard.');
  });

  it('names the documentation when it cannot be opened', () => {
    expect(describeFailure('open-documentation', hostileError()))
      .toBe('Couldn\'t open the documentation.');
  });

  it('says a failed toggle did not apply, without host detail', () => {
    expect(describeFailure('toggle', hostileError()))
      .toBe('RepoFocus couldn\'t apply the filtering change. See RepoFocus output for details.');
  });
});

describe('describeUnsavedFiltering', () => {
  it.each([
    [true, 'Filtering is on, but VS Code couldn\'t save that choice. It may not be remembered after you reload the window.'],
    [false, 'Filtering is off, but VS Code couldn\'t save that choice. It may not be remembered after you reload the window.'],
  ])('names the state that took effect when enabled is %s', (enabled, message) => {
    expect(describeUnsavedFiltering(enabled)).toBe(message);
  });
});
