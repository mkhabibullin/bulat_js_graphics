const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

/** One JSON object per line on stdout, ready for any log shipper. */
export function createLogger(level: LogLevel): Logger {
  const min = LEVELS[level];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] < min) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    if ('err' in entry) entry.err = serializeError(entry.err);
    process.stdout.write(JSON.stringify(entry) + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
