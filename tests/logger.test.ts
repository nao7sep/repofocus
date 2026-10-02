import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger';

function capture(debugEnabled = false): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  return { lines, logger: new Logger({ appendLine: line => lines.push(line) }, debugEnabled) };
}

describe('Logger', () => {
  it('writes one structured JSON event per line', () => {
    const { lines, logger } = capture();
    logger.info('Filtering started', { repositoryCount: 15 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'info',
      message: 'Filtering started',
      repositoryCount: 15,
    });
  });

  it('falls back to the host console when the output channel is closed', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger({ appendLine: () => { throw new Error('closed'); } }, false);

    expect(() => logger.info('Stopping')).not.toThrow();
    expect(consoleError).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it('keeps every field as given, secrets included', () => {
    const { lines, logger } = capture();
    logger.warn('Field probe', { token: 'secret value', nested: { PASSWORD: 'kept' } });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      token: 'secret value',
      nested: { PASSWORD: 'kept' },
    });
  });

  it('writes a serialization-failure event when fields cannot be serialized', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = { label: 'kept' };
    circular.self = circular;

    expect(() => logger.info('Circular probe', { circular })).not.toThrow();
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'error',
      message: 'Log event serialization failed.',
    });
  });

  it('records error type, message, stack, and cause', () => {
    const { lines, logger } = capture();
    logger.error('Compatibility failed', new Error('outer', { cause: new TypeError('inner') }));
    const event = JSON.parse(lines[0] ?? '') as { error: { cause: { type: string }; stack: string } };

    expect(event.error.stack).toContain('outer');
    expect(event.error.cause.type).toBe('TypeError');
  });

  it('records the error a warning carries', () => {
    const { lines, logger } = capture();
    logger.warn('Evaluation probe', { repository: '/work/alpha' }, new RangeError('bad count'));

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'warn',
      repository: '/work/alpha',
      error: { type: 'RangeError', message: 'bad count' },
    });
  });

  it('emits debug events only when explicitly enabled', () => {
    const disabled = capture();
    const enabled = capture(true);
    disabled.logger.debug('Hidden');
    enabled.logger.debug('Visible');

    expect(disabled.lines).toEqual([]);
    expect(JSON.parse(enabled.lines[0] ?? '')).toMatchObject({ level: 'debug', message: 'Visible' });
  });
});
