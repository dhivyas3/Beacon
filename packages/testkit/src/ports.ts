import { createServer } from 'node:net';

/** Asks the OS for a free TCP port. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port.'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}
