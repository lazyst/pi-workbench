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

// 通过 XtermTerminal 内部的 window.__piOnDataSpy 钩子收集真实写入 PTY 的字节。
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

// 在真实 Electron DOM 上派发 drop 事件（dataTransfer 为注入对象：测试环境无法产生带真实
// path 的拖拽 DataTransfer，但除路径来源外，dragover/drop 监听、MIME 识别、路径解析、粘贴
// 全链路完全真实）。data：自定义 MIME 'application/x-pi-file' 与兜底 'text/plain' 都注入。
async function dropPiFile(page: Page, absPath: string) {
  await page.evaluate((p: string) => {
    const host = document.querySelector('.terminal-host.active') as HTMLElement;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: {
        types: ['application/x-pi-file', 'text/plain'],
        files: [],
        getData: (type: string) =>
          type === 'application/x-pi-file' ? p : type === 'text/plain' ? p : '',
      },
    });
    host.dispatchEvent(ev);
  }, absPath);
}

test('从文件树拖文件到终端：PTY 收到绝对路径', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft-'));
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello world');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft-sess-'));
  writeDiskSession(dir, proj, 'ft-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  // 注册工作目录 + 打开会话
  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);
  // 右栏 auto 模式跟随默认工作目录，需手动切根到 proj 才能看到其文件树。
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });
  await expect(page.locator('.file-tree .file-name', { hasText: 'hello.txt' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'ft-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'ft-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  const expectedAbs = path.join(proj, 'hello.txt');
  await dropPiFile(page, expectedAbs);

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain(expectedAbs);
  t_unmount(electronApp);
});

test('从文件树拖含空格路径文件到终端：PTY 收到双引号包裹的绝对路径', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft2-'));
  fs.writeFileSync(path.join(proj, 'my report.txt'), 'x');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft2-sess-'));
  writeDiskSession(dir, proj, 'ft2-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });
  await expect(page.locator('.file-tree .file-name', { hasText: 'my report.txt' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'ft2-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'ft2-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  const expectedAbs = path.join(proj, 'my report.txt');
  await dropPiFile(page, expectedAbs);

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain(`"${expectedAbs}"`);
  t_unmount(electronApp);
});

test('从文件树拖文件夹到终端：PTY 收到目录绝对路径', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft3-'));
  fs.mkdirSync(path.join(proj, 'subdir'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ft3-sess-'));
  writeDiskSession(dir, proj, 'ft3-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });
  await expect(page.locator('.file-tree .file-name', { hasText: 'subdir' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'ft3-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'ft3-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  const expectedAbs = path.join(proj, 'subdir');
  await dropPiFile(page, expectedAbs);

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain(expectedAbs);
  t_unmount(electronApp);
});

// 小工具：关闭应用（避免在 test 主体里重复 try/catch）。
function t_unmount(app: ElectronApplication) {
  app.close().catch(() => {});
}
