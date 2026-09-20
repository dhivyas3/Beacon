import { spawn, type ChildProcess } from 'node:child_process';
import { findRedisServer } from './paths.js';
import { freePort } from './ports.js';

export interface RedisServer {
  url: string;
  stop(): Promise<void>;
}

export interface StartRedisOptions {
  port?: number;
}

/** Starts a throwaway redis-server with persistence disabled. */
export async function startRedis(options: StartRedisOptions = {}): Promise<RedisServer> {
  const port = options.port ?? (await freePort());
  const bin = findRedisServer();
  const child: ChildProcess = spawn(
    bin,
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis-server (${bin}) did not become ready within 15 seconds.`)),
      15_000,
    );
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (/Ready to accept connections/i.test(output)) {
        clearTimeout(timer);
        resolveReady();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start redis-server (${bin}): ${error.message}. Install Redis or set REDIS_SERVER_BIN.`,
        ),
      );
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`redis-server exited early with code ${String(code)}.\n${output}`));
    });
  });

  return {
    url: `redis://127.0.0.1:${port}`,
    stop() {
      return new Promise<void>((resolveStop) => {
        if (child.exitCode !== null) {
          resolveStop();
          return;
        }
        child.removeAllListeners('exit');
        child.once('exit', () => resolveStop());
        child.kill();
        setTimeout(() => {
          child.kill('SIGKILL');
          resolveStop();
        }, 3000).unref();
      });
    },
  };
}
