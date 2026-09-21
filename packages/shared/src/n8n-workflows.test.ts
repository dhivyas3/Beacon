import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callbackSignature } from './signing.js';

const DIR = fileURLToPath(new URL('../../../docs/n8n/', import.meta.url));

interface Node {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
}
interface Workflow {
  name: string;
  nodes: Node[];
  connections: Record<string, { main: { node: string }[][] }>;
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));
const load = (file: string): Workflow => JSON.parse(readFileSync(DIR + file, 'utf8')) as Workflow;

describe('the n8n workflows in docs/n8n', () => {
  it('ships the three documented workflows', () => {
    expect(files.sort()).toEqual([
      'beacon-callback.json',
      'beacon-scheduled-check.json',
      'monday-request-scan.json',
    ]);
  });

  describe.each(files)('%s', (file) => {
    const workflow = load(file);

    it('has uniquely named and identified nodes with a type and a version', () => {
      const names = workflow.nodes.map((node) => node.name);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(workflow.nodes.map((node) => node.id)).size).toBe(workflow.nodes.length);
      for (const node of workflow.nodes) {
        expect(node.type).toMatch(/^n8n-nodes-base\./);
        expect(node.typeVersion).toBeGreaterThan(0);
      }
    });

    it('only connects nodes that exist', () => {
      const names = new Set(workflow.nodes.map((node) => node.name));
      for (const [from, outputs] of Object.entries(workflow.connections)) {
        expect(names.has(from)).toBe(true);
        for (const branch of outputs.main) {
          for (const target of branch) expect(names.has(target.node)).toBe(true);
        }
      }
    });

    it('has no real secrets in it', () => {
      const text = readFileSync(DIR + file, 'utf8');
      expect(text).not.toMatch(/bcn_[A-Za-z0-9]{20,}/);
      expect(text).toContain('REPLACE_ME');
    });
  });

  it('starts a check the way the API expects', () => {
    const start = load('beacon-scheduled-check.json').nodes.find(
      (node) => node.name === 'Start check',
    );
    expect(start?.parameters.method).toBe('POST');
    expect(String(start?.parameters.url)).toContain('/api/v1/websites/');
    expect(String(start?.parameters.url)).toMatch(/\/check-now$/);
    expect(String(start?.parameters.jsonBody)).toContain("source: 'n8n'");
  });

  it('makes a monday.com request idempotent by item', () => {
    const start = load('monday-request-scan.json').nodes.find((node) => node.name === 'Start scan');
    expect(JSON.stringify(start?.parameters)).toContain('Idempotency-Key');
    expect(JSON.stringify(start?.parameters)).toContain("'monday-' + $json.itemId");
    expect(String(start?.parameters.url)).toMatch(/\/api\/v1\/scans$/);
  });
});

describe('the signature check in the callback workflow', () => {
  const SECRET = 'a-long-webhook-secret-for-the-test';
  const node = load('beacon-callback.json').nodes.find(
    (entry) => entry.name === 'Verify signature',
  );
  const source = String(node?.parameters.jsCode).replace('PASTE_THE_WEBHOOK_SECRET_HERE', SECRET);
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* only to reach the constructor */
  }).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction('$input', 'require', 'Buffer', source);

  async function verify(body: string, signature: string) {
    const helpers = { getBinaryDataBuffer: () => Promise.resolve(Buffer.from(body)) };
    const input = { first: () => ({ json: { headers: { 'x-beacon-signature': signature } } }) };
    const bound = run.bind({ helpers });
    return (await bound(input, createRequire(import.meta.url), Buffer)) as {
      json: Record<string, unknown>;
    }[];
  }

  const body = JSON.stringify({
    event: 'scan.completed',
    deliveryId: 'whd_Ab12Cd34Ef56',
    sentAt: '2026-09-18T10:47:02.000Z',
    scan: { id: 'scn_1', runNumber: 7, status: 'completed', metadata: { mondayItemId: '42' } },
  });

  it('accepts a body signed the way Beacon signs it, and passes the scan on', async () => {
    const signature = await callbackSignature(SECRET, body);
    const [item] = await verify(body, signature);
    expect(item?.json).toMatchObject({
      valid: true,
      event: 'scan.completed',
      deliveryId: 'whd_Ab12Cd34Ef56',
      id: 'scn_1',
      runNumber: 7,
      metadata: { mondayItemId: '42' },
    });
  });

  it('rejects a signature made with another secret, a changed body, or none', async () => {
    const wrongSecret = await callbackSignature('another-secret-entirely-1234', body);
    expect((await verify(body, wrongSecret))[0]?.json).toEqual({ valid: false });

    const signature = await callbackSignature(SECRET, body);
    expect((await verify(body.replace('completed', 'failed'), signature))[0]?.json).toEqual({
      valid: false,
    });
    expect((await verify(body, ''))[0]?.json).toEqual({ valid: false });
  });
});
