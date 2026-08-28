import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

function writeDiskSession(dir: string, cwd: string, name: string) {
  const group = path.join(dir, encodeURIComponent(cwd));
  fs.mkdirSync(group, { recursive: true });
  const stamp = '2026-07-14T12-00-00-000Z';
  const header = JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: stamp, cwd });
  const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: name }] } });
  fs.writeFileSync(path.join(group, `${stamp}_disk.jsonl`), header + '\n' + msg + '\n');
}

// 通过 XtermTerminal 内部的 window.__piOnDataSpy 钩子收集真实写入 PTY 的字节
// （xterm 在 paste / 键盘输入时都会经此路径），避免 Proxy wrap 不可靠。
async function installSpy(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__ondataLog = [] as string[];
    w.__piOnDataSpy = (d: string) => { w.__ondataLog.push(d); };
  });
}
async function collected(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__ondataLog?.join('') ?? '');
}

test('Ctrl+V 粘贴：PTY 收到纯文本、不含 [200~ 字面量（回归 #bracketed-paste）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paste-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'paste-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  // 注册会话 cwd 为已添加目录（侧边栏按 visibleDirs 过滤会话），reload 后重装 spy。
  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);

  await expect(page.locator('.session-item', { hasText: 'paste-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'paste-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  // 渲染进程自带 navigator.clipboard 写入系统剪贴板
  await page.evaluate((text: string) => navigator.clipboard.writeText(text), 'PASTE_MARKER_XYZ');

  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('v');
  await page.keyboard.up('Control');

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain('PASTE_MARKER_XYZ');
  expect(joined).not.toContain('[200~');
  expect(joined).not.toContain('\x1b[200~');

  await electronApp.close();
});

test('右键粘贴（无选区）：PTY 收到纯文本、不含 [200~ 字面量', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paste2-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj2-'));
  writeDiskSession(dir, proj, 'paste2-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);

  await expect(page.locator('.session-item', { hasText: 'paste2-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'paste2-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  await page.evaluate((text: string) => navigator.clipboard.writeText(text), 'RCLICK_MARKER_ABC');

  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').focus();
  await host.click({ button: 'right' });
  await page.waitForTimeout(400);

  const joined = await collected(page);
  expect(joined).toContain('RCLICK_MARKER_ABC');
  expect(joined).not.toContain('[200~');
  expect(joined).not.toContain('\x1b[200~');

  await electronApp.close();
});
