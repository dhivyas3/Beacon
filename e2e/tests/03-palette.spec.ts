import { expect, test } from '@playwright/test';
import { signIn } from './helpers.js';

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  test('opens a website from the keyboard alone', async ({ page }) => {
    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: 'Search commands' });
    await expect(input).toBeFocused();

    await page.keyboard.type('fixture');
    await expect(page.getByRole('option', { name: /Open Fixture Estates/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/websites\/web_/);
    await expect(page.getByRole('heading', { level: 1, name: 'Fixture Estates' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('goes to settings, and closes with Escape', async ({ page }) => {
    await page.keyboard.press('Control+K');
    await page.keyboard.type('settings');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings$/);

    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('switches theme', async ({ page }) => {
    await page.keyboard.press('Control+K');
    await page.keyboard.type('dark theme');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
