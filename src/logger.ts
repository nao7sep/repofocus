export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export interface LogSink {
  appendLine(value: string): void;
}

const deniedKeys = new Set(['apikey', 'authorization', 'password', 'secret', 'token']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = deniedKeys.has(key.toLowerCase()) ? '[redacted]' : redact(child);
  }
  return result;
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

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, error: unknown, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write('error', message, { ...fields, error: serializeError(error) });
  }

  private write(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>>): void {
    const event = redact({
      time: new Date().toISOString(),
      level,
      message,
      ...fields,
    });
    this.sink.appendLine(JSON.stringify(event));
  }
}
