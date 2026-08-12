import pino from "pino";

const DEFAULT_LEVEL =
  process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

const isDev = process.env.NODE_ENV !== "production";

const DEFAULT_OPTIONS: pino.LoggerOptions = {
  level: DEFAULT_LEVEL,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
};

let _rootLogger: pino.Logger | null = null;

const isPinoInstance = (v: unknown): v is pino.Logger =>
  typeof v === "object" && v !== null && typeof (v as pino.Logger).info === "function";

const getRootLogger = (): pino.Logger => {
  if (!_rootLogger) {
    _rootLogger = pino(DEFAULT_OPTIONS);
  }
  return _rootLogger;
};

/**
 * Inject a custom pino logger or options BEFORE the first `logger` call.
 * First call wins — subsequent calls are ignored.
 *
 * @example
 *   // Pass a pre-configured pino instance
 *   configureLogging(pino({ level: "trace", redact: ["req.headers.authorization"] }));
 *
 * @example
 *   // Pass pino options (no defaults applied — you own full config)
 *   configureLogging({ level: "trace", transport: { target: "pino/file", options: { destination: "/var/log/app.log" } } });
 */
export const configureLogging = (loggerOrOptions: pino.Logger | pino.LoggerOptions): void => {
  if (_rootLogger) return; // first-write-wins

  if (isPinoInstance(loggerOrOptions)) {
    _rootLogger = loggerOrOptions;
  } else {
    _rootLogger = pino(loggerOrOptions);
  }
};

const loggers = new Map<string, pino.Logger>();

/**
 * Returns (or creates) a pino logger for the given component name.
 * Use `logger.child({ ... })` to add per-instance context.
 */
export const logger = (name: string): pino.Logger => {
  const existing = loggers.get(name);
  if (existing) return existing;

  const logger = getRootLogger().child({ component: name });
  loggers.set(name, logger);
  return logger;
};

export type { Logger } from "pino";
