/** One server-sent event: `event:` names it and `data:` carries a single line of JSON. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A comment line. Clients ignore it, and it keeps proxies from closing an idle connection. */
export const SSE_HEARTBEAT = ': ping\n\n';

/** How long a browser waits before reconnecting after the connection drops. */
export const SSE_RETRY = 'retry: 3000\n\n';
