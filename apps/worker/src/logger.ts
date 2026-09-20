import { pino, type Logger } from 'pino';

export function createLogger(level: string, development: boolean): Logger {
  return pino({
    level,
    ...(development
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };
