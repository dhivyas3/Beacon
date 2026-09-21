import { expect, test } from '@playwright/test';
import { callbackSignature } from '@beacon/shared';
import { FIXTURE_URL, RECEIVER_URL, WEBHOOK_SECRET } from '../src/stack.js';
import { ORIGIN, signIn, startReceiver, websites, type Received } from './helpers.js';

interface Callback {
  event: string;
  deliveryId: string;
  scan: {
    id: string;
    status: string;
    triggeredByType: string;
    pageSelectionMode: string;
    website: { id: string; name: string } | null;
    metadata: Record<string, unknown> | null;
    summary: { healthScore: number | null; pages: number };
  };
}

async function callbackFor(
  received: Received[],
  scanId: string,
): Promise<{ raw: Received; payload: Callback }> {
  let found: { raw: Received; payload: Callback } | undefined;
  await expect
    .poll(
      () => {
        for (const raw of received) {
          const payload = JSON.parse(raw.body) as Callback;
          if (payload.scan.id === scanId) found = { raw, payload };
        }
        return found !== undefined;
      },
      { timeout: 75_000, message: `a callback for ${scanId}` },
    )
    .toBe(true);
  return found as { raw: Received; payload: Callback };
}

test.describe('n8n and monday.com: start a check and hear back', () => {
  test('a key starts a check of a website and the completed callback is signed', async ({
    page,
    request,
  }) => {
    await signIn(page);
    const created = await page.request.post('/api/v1/api-keys', {
      data: { name: 'n8n e2e', scopes: ['scans:read', 'scans:write'] },
      headers: ORIGIN,
    });
    expect(created.status()).toBe(201);
    const { key } = (await created.json()) as { key: string };
    expect(key).toMatch(/^bcn_/);
    const auth = { authorization: `Bearer ${key}` };

    const [website] = await websites(page.request);
    expect(website?.name).toBe('Fixture Estates');

    const receiver = await startReceiver();
    try {
      const started = await request.post(`/api/v1/websites/${website?.id}/check-now`, {
        headers: auth,
        data: {
          source: 'n8n',
          callbackUrl: `${RECEIVER_URL}/beacon-callback`,
          metadata: { mondayItemId: '1234567890' },
        },
      });
      expect(started.status()).toBe(202);
      const { id } = (await started.json()) as { id: string };

      // A second check of the same hostname is refused while this one is running.
      const second = await request.post(`/api/v1/websites/${website?.id}/check-now`, {
        headers: auth,
        data: {},
      });
      expect(second.status()).toBe(409);

      const { raw, payload } = await callbackFor(receiver.received, id);
      // The signature covers the exact bytes received, keyed with the webhook secret.
      expect(raw.headers['x-beacon-signature']).toBe(
        await callbackSignature(WEBHOOK_SECRET, raw.body),
      );
      expect(raw.headers['x-beacon-event']).toBe('scan.completed');
      expect(raw.headers['x-beacon-delivery']).toBe(payload.deliveryId);
      expect(payload.scan).toMatchObject({
        status: 'completed',
        triggeredByType: 'n8n',
        pageSelectionMode: 'random_sample',
        website: { id: website?.id, name: 'Fixture Estates' },
        metadata: { mondayItemId: '1234567890' },
      });
      expect(payload.scan.summary.pages).toBe(3);

      // And a callback tampered with on the way no longer matches its signature.
      const tampered = raw.body.replace('completed', 'failed');
      expect(raw.headers['x-beacon-signature']).not.toBe(
        await callbackSignature(WEBHOOK_SECRET, tampered),
      );
    } finally {
      await receiver.close();
    }
  });

  test('a one-off full scan still works, and a retried request starts only one', async ({
    page,
    request,
  }) => {
    await signIn(page);
    const created = await page.request.post('/api/v1/api-keys', {
      data: { name: 'monday e2e', scopes: ['scans:read', 'scans:write'] },
      headers: ORIGIN,
    });
    const { key } = (await created.json()) as { key: string };
    const auth = { authorization: `Bearer ${key}` };

    const receiver = await startReceiver();
    try {
      const body = {
        url: FIXTURE_URL,
        checks: ['images', 'links'],
        source: 'monday',
        callbackUrl: `${RECEIVER_URL}/beacon-callback`,
        metadata: { mondayItemId: '42' },
      };
      const first = await request.post('/api/v1/scans', {
        headers: { ...auth, 'idempotency-key': 'monday-42' },
        data: body,
      });
      expect(first.status()).toBe(202);
      const { id } = (await first.json()) as { id: string };

      const again = await request.post('/api/v1/scans', {
        headers: { ...auth, 'idempotency-key': 'monday-42' },
        data: body,
      });
      expect(again.status()).toBe(202);
      expect(again.headers()['idempotent-replayed']).toBe('true');
      expect(((await again.json()) as { id: string }).id).toBe(id);

      const { payload } = await callbackFor(receiver.received, id);
      // Every page of the site was found and checked: this is not a sample, and not a website.
      expect(payload.scan).toMatchObject({
        status: 'completed',
        triggeredByType: 'monday',
        pageSelectionMode: 'full',
        website: null,
        metadata: { mondayItemId: '42' },
      });
      expect(payload.scan.summary.pages).toBeGreaterThan(3);

      // It is a scan of no website, so it was not emailed.
      const detail = await request.get(`/api/v1/scans/${id}`, { headers: auth });
      expect(((await detail.json()) as { website: unknown }).website).toBeNull();
    } finally {
      await receiver.close();
    }

    // It shows in the dashboard as a one-off scan.
    await page.goto('/scans');
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('link', { name: '127.0.0.1' }).first().click();
    await expect(page.getByText('One-off scan')).toBeVisible();
  });
});
