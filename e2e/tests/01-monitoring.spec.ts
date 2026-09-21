import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_URL, OUTBOX_DIR } from '../src/stack.js';
import { ORIGIN, signIn } from './helpers.js';

const SAM = 'sam@fixture-estates.example';
const KIM = 'kim@fixture-estates.example';

test('register a website, check it, read the report and get the emails', async ({ page }) => {
  await signIn(page);

  // Only allowed hostnames can be monitored. An admin allows the fixture site.
  const allowed = await page.request.post('/api/v1/allowed-domains', {
    data: { hostname: '127.0.0.1', note: 'End-to-end fixture site' },
    headers: ORIGIN,
  });
  expect([201, 409]).toContain(allowed.status());

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Add your first website')).toBeVisible();

  // ---- Register: monthly, a sample that always includes the homepage, two recipients ----------
  await page.getByRole('link', { name: 'Add website' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a website' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Fixture Estates');
  await page.getByLabel('Address', { exact: true }).fill(FIXTURE_URL);
  await page.getByLabel('How often').selectOption('monthly');
  await page.getByLabel('On day').selectOption('1');
  await page.getByLabel('At (UTC)').selectOption('6');
  await page.getByLabel('Number of pages').fill('3');
  await page.getByLabel('Recipient email 1').fill(SAM);
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.getByLabel('Recipient email 2').fill(KIM);
  await page.getByLabel('What recipient 2 receives').selectOption('every_check');
  await page.getByRole('button', { name: 'Add website' }).click();

  await expect(page).toHaveURL(/\/websites\/web_/);
  await expect(page.getByRole('heading', { level: 1, name: 'Fixture Estates' })).toBeVisible();
  await expect(page.getByText('3 random pages, homepage always included')).toBeVisible();
  await expect(page.getByText(SAM, { exact: true })).toBeVisible();
  await expect(page.getByText(KIM, { exact: true })).toBeVisible();
  await expect(page.getByText('No completed checks yet')).toBeVisible();
  const websiteUrl = page.url();

  // ---- Check now, and follow it to the report ---------------------------------------------------
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page).toHaveURL(/\/scans\/scn_/);
  const reportUrl = page.url();
  const nav = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(nav.getByRole('link', { name: 'Fixture Estates' })).toBeVisible();

  // Running scans show progress; whichever comes first, the report ends up completed.
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 75_000 });
  await expect(page.getByText('Health score', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Issues by check')).toBeVisible();
  await expect(page.getByText('Pages scanned')).toBeVisible();
  // The fixture site is broken on purpose, and the homepage is always in the sample.
  await page.getByRole('radio', { name: 'By issue' }).click();
  await expect(page.getByText(/Image failed to load/).first()).toBeVisible();
  await expect(page.getByText('One-off scan')).toHaveCount(0);

  // ---- Exports ----------------------------------------------------------------------------------
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toMatch(/^beacon-127\.0\.0\.1-check-1\.csv$/);
  const csvText = readFileSync(await csv.path(), 'utf8');
  expect(csvText).toContain('severity,check,state,page_url,message');
  expect(csvText).toContain('127.0.0.1:4310');

  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export PDF' }).click();
  const pdf = await pdfDownload;
  expect(
    readFileSync(await pdf.path())
      .subarray(0, 5)
      .toString('latin1'),
  ).toBe('%PDF-');

  // ---- The website page now has the check, and both recipients were emailed --------------------
  await page.goto(websiteUrl);
  const history = page.getByRole('table', { name: 'Completed checks, newest first' });
  await expect(history.getByRole('row')).toHaveCount(2);
  await expect(history.getByRole('link', { name: '#1 report' })).toHaveAttribute(
    'href',
    new URL(reportUrl).pathname,
  );

  const emails = page.getByRole('table', { name: 'Report emails, newest first' });
  await expect(emails.getByText('Sent')).toHaveCount(2, { timeout: 45_000 });
  await expect(emails.getByText(SAM, { exact: true })).toBeVisible();
  await expect(emails.getByText(KIM, { exact: true })).toBeVisible();

  // The log provider writes each email to disk instead of sending it.
  const html = readdirSync(OUTBOX_DIR).filter((name) => name.endsWith('.html'));
  expect(html.length).toBe(2);
  const body = readFileSync(join(OUTBOX_DIR, html[0] as string), 'utf8');
  expect(body).toContain('Fixture Estates');
  expect(body).toContain('View full report');
  expect(body).toContain(new URL(reportUrl).pathname);
  // Emails are tables and inline styles only: nothing that Gmail or Outlook would strip or block.
  expect(body).not.toMatch(/<script|<img|<svg/i);

  // ---- The overview shows the website with its score --------------------------------------------
  await page.goto('/');
  const card = page.getByRole('heading', { level: 3, name: 'Fixture Estates' });
  await expect(card).toBeVisible();
  await expect(page.getByText('Last checked')).toBeVisible();
  await expect(page.getByText('3 pages')).toBeVisible();
});
