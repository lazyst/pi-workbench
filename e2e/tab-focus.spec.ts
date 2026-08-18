import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, PI_DESKTOP_FAKE: '1' };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

test('文件树打开文件 → 编辑器获得焦点，可直接输入', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-focus-'));
  fs.writeFileSync(path.join(proj, 'hello.ts'), 'const x = 1;\n');

  const { page } = await launch();

  await page.evaluate((dir) => (window as any).pi.setConfig({ addedDirs: [dir] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // 右栏手动切到测试目录（auto 模式跟随默认工作目录），点击文件打开
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });
  await expect(page.locator('.file-tree .file-row', { hasText: 'hello.ts' })).toBeVisible({ timeout: 15000 });
  await page.locator('.file-tree .file-row', { hasText: 'hello.ts' }).click();

  // Monaco 编辑器渲染完成（首次加载 monaco 较慢，放宽超时）
  await expect(page.locator('.monaco-editor textarea')).toBeVisible({ timeout: 30000 });

  // 关键断言：从文件树打开后焦点已落到 Monaco 编辑器内（对齐 VS Code，打开即可输入）
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const a = document.activeElement as HTMLElement | null;
          return !!a && (a.matches('.monaco-editor textarea') || !!a.closest('.monaco-editor'));
        }),
      { timeout: 10000 },
    )
    .toBe(true);

  await electronApp!.close();
});