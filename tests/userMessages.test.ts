import { describe, expect, it } from 'vitest';
import { describeFailure, describeMappingState, type FailedOperation } from '../src/userMessages';

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
  it.each<FailedOperation>(['compatibility'])('shows only authored copy for %s', operation => {
    const message = describeFailure(operation, hostileError());

    expectAuthored(message);
    expect(message.length).toBeGreaterThan(0);
  });

  it('reuses the incompatible mapping copy when filtering stops', () => {
    expect(describeFailure('compatibility', hostileError())).toBe(describeMappingState('incompatible'));
  });
});
