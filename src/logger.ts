export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export interface LogSink {
  appendLine(value: string): void;
}

function serializeError(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  if (seen.has(error)) return { type: error.name, message: error.message, cause: '[circular]' };
  seen.add(error);
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause === undefined ? undefined : serializeError(error.cause, seen),
  };
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly debugEnabled: boolean,
  ) {}

  debug(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (this.debugEnabled) this.write('debug', message, fields);
  }

  info(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}, error?: unknown): void {
    this.write('warn', message, error === undefined ? fields : { ...fields, error: serializeError(error) });
  }

  error(message: string, error: unknown, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('error', message, { ...fields, error: serializeError(error) });
  }

  private write(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>>): void {
    let line: string;
    try {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        message,
        ...fields,
      });
    } catch (error) {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        message: 'Log event serialization failed.',
        error: serializeError(error),
      });
    }

    try {
      this.sink.appendLine(line);
    } catch (error) {
      // The logging-conventions' fallback; an OutputChannel can close before deactivation finishes.
      console.error(line);
      console.error('RepoFocus log sink failed.', error);
    }
  }
}
