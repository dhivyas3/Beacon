import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn, websites } from './helpers.js';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Target {
  name: string;
  path: string;
  /** Something that is on the page only once it has loaded, so the check runs on real content. */
  ready: (page: Page) => Promise<void>;
}

let targets: Target[] = [];

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: 'http://127.0.0.1:4301' });
  await signIn(page);
  const [website] = await websites(page.request);
  const scans = (await (
    await page.request.get('/api/v1/scans?status=completed&limit=5')
  ).json()) as {
    items: { id: string; website: unknown }[];
  };
  const websiteScan = scans.items.find((scan) => scan.website !== null);
  await page.close();
  if (!website || !websiteScan) throw new Error('The monitoring spec has to run first.');

  targets = [
    {
      name: 'overview',
      path: '/',
      ready: (p) => p.getByRole('heading', { level: 3, name: 'Fixture Estates' }).waitFor(),
    },
    {
      name: 'websites',
      path: '/websites',
      ready: (p) => p.getByRole('table', { name: 'Websites' }).waitFor(),
    },
    {
      name: 'add website',
      path: '/websites/new',
      ready: (p) => p.getByRole('heading', { name: 'Add a website' }).waitFor(),
    },
    {
      name: 'edit website',
      path: `/websites/${website.id}/edit`,
      ready: (p) => p.getByRole('button', { name: 'Save changes' }).waitFor(),
    },
    {
      name: 'website',
      path: `/websites/${website.id}`,
      ready: (p) => p.getByRole('table', { name: 'Completed checks, newest first' }).waitFor(),
    },
    {
      name: 'scans',
      path: '/scans',
      ready: (p) => p.getByRole('table').waitFor(),
    },
    {
      name: 'report',
      path: `/scans/${websiteScan.id}`,
      ready: (p) => p.getByText('Issues by check').waitFor(),
    },
    {
      name: 'settings',
      path: '/settings',
      ready: (p) => p.getByRole('heading', { name: 'Settings' }).waitFor(),
    },
  ];
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`no accessibility violations in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const problems: string[] = [];
    for (const target of targets) {
      await page.goto(target.path);
      await target.ready(page);
      // Let entrance animations and charts settle so contrast is measured on final colours.
      await page.waitForTimeout(600);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      for (const violation of results.violations) {
        const where = violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(' | ');
        problems.push(`${target.name}: ${violation.id} (${violation.impact ?? '?'}) ${where}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('the open command palette has no violations either', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  await page.keyboard.press('Control+K');
  await page.getByRole('combobox', { name: 'Search commands' }).waitFor();
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('nothing scrolls sideways', async ({ page }) => {
    const wide: string[] = [];
    for (const target of targets) {
      await page.goto(target.path);
      await target.ready(page);
      await page.waitForTimeout(300);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390) wide.push(`${target.name}: ${width}px`);
    }
    expect(wide, wide.join('\n')).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test('the first stop is a skip link that moves focus to the content', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('every control that takes focus shows where it is', async ({ page }) => {
    await page.goto('/websites/new');
    await page.getByRole('heading', { name: 'Add a website' }).waitFor();
    const hidden: string[] = [];
    for (let stop = 0; stop < 40; stop += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const style = getComputedStyle(element);
        const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        const label =
          element.getAttribute('aria-label') ??
          element.textContent?.trim().slice(0, 30) ??
          element.tagName;
        return { label, outline: style.outlineStyle, visible };
      });
      if (info && !info.visible) hidden.push(info.label);
    }
    expect(hidden).toEqual([]);
  });
});
