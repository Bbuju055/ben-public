import { expect, test } from '@playwright/test';

// Asserts on the outcome of a real click against the real server — not "the element exists".
test('button click fetches from the real api and renders the result', async ({ page }) => {
  await page.goto('/');
  await page.click('#go');
  await expect(page.locator('#out')).toHaveText(process.env.BEN_E2E_GREETING ?? 'hello from the api');
});
