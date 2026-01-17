/**
 * Minimal zero-dependency logger
 * Designed for constrained environments (MIPS, embedded, low RAM)
 */

type LogFields = Record<string, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type LogFormat = 'plain' | 'json' | 'gcp-json';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const SEVERITY: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  silent: 'SILENT',
};

let currentLevel: LogLevel = 'info';
let currentFormat: LogFormat = 'plain';
let output: NodeJS.WriteStream = process.stderr;

/**
 * Initialize the logger with a specific log level and format.
 */
export function initLogger(level: LogLevel, format: LogFormat = 'plain', useStderr = false): void {
  currentLevel = level;
  currentFormat = format;
  output = useStderr ? process.stderr : process.stdout;
}

/**
 * Set the logger level dynamically
 */
export function setLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatPlain(_level: LogLevel, message: string, meta?: LogFields): string {
  let metaStr = '';
  if (meta && Object.keys(meta).length > 0) {
    const parts = Object.entries(meta).map(([k, v]) => {
      if (v === undefined || v === null) return `${k}=null`;
      if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    });
    metaStr = ` (${parts.join(', ')})`;
  }
  return `${message}${metaStr}\n`;
}

function formatJson(level: LogLevel, message: string, meta?: LogFields): string {
  const obj: Record<string, unknown> = {
    level: level.toUpperCase(),
    time: new Date().toISOString(),
    message,
    ...meta,
  };
  return JSON.stringify(obj) + '\n';
}

function formatGcp(level: LogLevel, message: string, meta?: LogFields): string {
  const obj: Record<string, unknown> = {
    severity: SEVERITY[level],
    time: new Date().toISOString(),
    message,
    ...meta,
  };
  return JSON.stringify(obj) + '\n';
}

function write(level: LogLevel, message: string, meta?: LogFields): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  // Normalize errors in meta
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value instanceof Error) {
        meta[key] = { message: value.message, stack: value.stack };
      }
    }
  }

  let line: string;
  switch (currentFormat) {
    case 'json':
      line = formatJson(level, message, meta);
      break;
    case 'gcp-json':
      line = formatGcp(level, message, meta);
      break;
    default:
      line = formatPlain(level, message, meta);
  }

  output.write(line);
}

export const logger = {
  debug(message: string, meta?: LogFields) {
    write('debug', message, meta);
  },
  info(message: string, meta?: LogFields) {
    write('info', message, meta);
  },
  warn(message: string, meta?: LogFields) {
    write('warn', message, meta);
  },
  error(message: string, meta?: LogFields) {
    write('error', message, meta);
  },
};

export type { LogLevel, LogFormat, LogFields };
