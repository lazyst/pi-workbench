import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

async function launch(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ...env };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

function writeDiskSession(dir: string, cwd: string, name: string) {
  const group = path.join(dir, encodeURIComponent(cwd));
  fs.mkdirSync(group, { recursive: true });
  const stamp = '2026-07-14T12-00-00-000Z';
  const header = JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: stamp, cwd });
  const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: name }] } });
  fs.writeFileSync(path.join(group, `${stamp}_disk.jsonl`), header + '\n' + msg + '\n');
}

test('batch delete shows a confirm dialog before deleting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-batch-'));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-b-'));
  writeDiskSession(dir, cwdA, 'batch-A1');
  writeDiskSession(dir, cwdB, 'batch-B1');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  // 注册会话 cwd 为已添加目录（侧边栏按 visibleDirs 过滤会话）。
  await page.evaluate((dirs) => (window as any).pi.setConfig({ addedDirs: dirs }), [cwdA, cwdB]);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'batch-A1' })).toBeVisible({ timeout: 15000 });

  // 进入多选模式
  await page.getByRole('button', { name: '管理' }).click();
  await expect(page.getByText('已选 0 项')).toBeVisible({ timeout: 5000 });

  // 勾选 batch-A1（点击真实 checkbox，而非整行）
  await page.locator('.session-item', { hasText: 'batch-A1' }).locator('input.select-box').check();
  await expect(page.getByText('已选 1 项')).toBeVisible({ timeout: 5000 });

  // 点击顶部“删除” → 必须弹出确认框，而不是直接删除
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.confirm-dialog')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.confirm-dialog')).toContainText('确定删除选中的 1 个会话');

  // 确认删除
  await page.locator('.confirm-dialog .btn-danger').click();
  await expect(page.locator('.session-item', { hasText: 'batch-A1' })).toHaveCount(0, { timeout: 5000 });
  // 另一条仍在
  await expect(page.locator('.session-item', { hasText: 'batch-B1' })).toBeVisible({ timeout: 5000 });

  await electronApp!.close();
});
