import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { html as diff2html } from 'diff2html';

const require = createRequire(import.meta.url);
const libraryCss = readFileSync(require.resolve('diff2html/bundles/css/diff2html.min.css'), 'utf8');
const overrideCss = readFileSync(path.resolve(import.meta.dirname, '../src/diff.css'), 'utf8');

test('wrapped diff rows keep line numbers aligned', async ({ page }, testInfo) => {
  const longOld = 'old-content-'.repeat(35);
  const longNew = 'new-content-'.repeat(35);
  const diff = `diff --git a/report.html b/report.html
index 1111111..2222222 100644
--- a/report.html
+++ b/report.html
@@ -1,2 +1,2 @@
-<section><p>${longOld}</p></section>
+<section><p>${longNew}</p></section>
 <footer>same</footer>`;
  const rendered = diff2html(diff, { drawFileList: false, matching: 'lines', outputFormat: 'side-by-side' });

  await page.setContent(`<style>${libraryCss}\n${overrideCss}</style><div class="d2h-dark-color-scheme">${rendered}</div>`);
  const rows = page.locator('.d2h-file-side-diff').first().locator('tr');
  const wrappedRow = rows.nth(1);
  const followingRow = rows.nth(2);
  const wrappedBox = await wrappedRow.boundingBox();
  const wrappedNumberBox = await wrappedRow.locator('.d2h-code-side-linenumber').boundingBox();
  const followingNumberBox = await followingRow.locator('.d2h-code-side-linenumber').boundingBox();

  expect(wrappedBox).not.toBeNull();
  expect(wrappedNumberBox).not.toBeNull();
  expect(followingNumberBox).not.toBeNull();
  expect(wrappedBox!.height).toBeGreaterThan(40);
  await expect(wrappedRow.locator('.d2h-code-side-linenumber')).toHaveCSS('position', 'static');
  await expect(wrappedRow.locator('.d2h-code-side-linenumber')).toHaveCSS('display', 'table-cell');
  expect(wrappedNumberBox!.y).toBeGreaterThanOrEqual(wrappedBox!.y - 1);
  expect(followingNumberBox!.y).toBeGreaterThanOrEqual(wrappedBox!.y + wrappedBox!.height - 1);
  await page.screenshot({ path: testInfo.outputPath('diff-layout.png'), fullPage: true });
});
