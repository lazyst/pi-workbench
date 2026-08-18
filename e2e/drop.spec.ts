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

// 断言终端画面没有主进程加载错误（如 fake-pi.mjs 缺失导致的 MODULE_NOT_FOUND）。
async function expectNoTerminalError(page: Page): Promise<void> {
  const text = await page.evaluate(() => {
    const rows = document.querySelector('.xterm-rows')?.textContent ?? '';
    return rows;
  }).catch(() => '');
  expect(text).not.toContain('Cannot find module');
  expect(text).not.toContain('MODULE_NOT_FOUND');
}

test('拖入单文件：PTY 收到绝对路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-drop-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'drop-seeded');
  const env = { ...process.env };
  delete (env as any).ELECTRON_RENDERER_URL;

  electronApp = await _electron.launch({ args: [MAIN], env: { ...env, PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir } });
  const page: Page = await electronApp.firstWindow();
  await installSpy(page);
  await page.waitForLoadState('domcontentloaded');

  // 注册会话 cwd 为已添加目录：侧边栏按 visibleDirs（addedDirs ∪ appWorkDir）过滤会话，
  // 否则临时目录下的会话不会出现在侧边栏。reload 后 spy 失效需重装。
  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await installSpy(page);

  await expect(page.locator('.session-item', { hasText: 'drop-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'drop-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);
  // 确认 fake-pi 后端已正常加载（终端无 MODULE_NOT_FOUND，避免 e2e 假绿）。
  await expectNoTerminalError(page);

  // 在真实 Electron DOM 上派发 drop 事件（dataTransfer 为注入对象：测试环境无法产生带真实
  // path 的拖拽 File，但除 path 来源外，dragover/drop 监听、路径解析、粘贴全链路完全真实）。
  await page.evaluate(() => {
    const host = document.querySelector('.terminal-host.active') as HTMLElement;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [{ path: '/home/u/project/run.sh', name: 'run.sh' }] },
    });
    host.dispatchEvent(ev);
  });

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain('/home/u/project/run.sh');
  t_unmount(electronApp);
});

test('拖入含空格路径的文件：PTY 收到双引号包裹的路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-drop2-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj2-'));
  writeDiskSession(dir, proj, 'drop2-seeded');
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

  await expect(page.locator('.session-item', { hasText: 'drop2-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'drop2-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  await page.evaluate(() => {
    const host = document.querySelector('.terminal-host.active') as HTMLElement;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [{ path: '/home/u/my docs/report final.txt', name: 'report final.txt' }] },
    });
    host.dispatchEvent(ev);
  });

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain('"/home/u/my docs/report final.txt"');
  t_unmount(electronApp);
});

test('拖入多个文件：PTY 收到空格拼接的多个转义路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-drop3-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj3-'));
  writeDiskSession(dir, proj, 'drop3-seeded');
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

  await expect(page.locator('.session-item', { hasText: 'drop3-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'drop3-seeded' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  await page.evaluate(() => {
    const host = document.querySelector('.terminal-host.active') as HTMLElement;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: [
          { path: '/p/a.txt', name: 'a.txt' },
          { path: '/p/b c.txt', name: 'b c.txt' },
        ],
      },
    });
    host.dispatchEvent(ev);
  });

  await page.waitForTimeout(400);
  const joined = await collected(page);
  expect(joined).toContain('/p/a.txt');
  expect(joined).toContain('"/p/b c.txt"');
  t_unmount(electronApp);
});

// 小工具：关闭应用（避免在 test 主体里重复 try/catch）。
function t_unmount(app: ElectronApplication) {
  app.close().catch(() => {});
}
