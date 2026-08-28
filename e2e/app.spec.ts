import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

function pidAlive(pid: number): boolean {
  try { return require('node:child_process').execSync(`tasklist /FI "PID eq ${pid}"`).toString().includes(String(pid)); }
  catch { return false; }
}

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

test('open disk session → continuity across switch → hover terminate → close kills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-b-'));
  writeDiskSession(dir, cwdA, 'session-A');
  writeDiskSession(dir, cwdB, 'session-B');
  const { page } = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });

  // 注册会话 cwd 为已添加目录：侧边栏按 visibleDirs（addedDirs ∪ appWorkDir）过滤会话，
  // 否则临时目录下的会话不会出现在侧边栏。
  await page.evaluate((dirs) => (window as any).pi.setConfig({ addedDirs: dirs }), [cwdA, cwdB]);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'session-A' })).toBeVisible({ timeout: 15000 });

  await page.locator('.session-item', { hasText: 'session-A' }).click();
  // 终端渲染走 VS Code 集成终端同款的 @xterm/webgl 渲染器（文本画在 <canvas> 上、无 .xterm-rows
  // DOM 文本层），不再维护 data-output 镜像。故改用进程侧信号断言真实输出在跑：
  // 会话 A 已打开且恰好有 1 个运行中的 pi 进程。
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);
  // 记录 session-A 首个进程 pid，用于验证“切走再切回”是否复用同一进程。
  const aPid = (await page.evaluate(() => (window as any).pi.debug())).pids[0];

  await page.locator('.session-item', { hasText: 'session-B' }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'session-A' }).click();

  // 切回同一会话必须复用原进程（而非新起一个）：原 A 进程 pid 必须仍在被追踪的进程集中。
  // 修复前会再 spawn 一个 pi 并覆盖池记录，使原进程被孤儿化、不再被追踪 → 该断言失败。
  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  expect(pidsAll).toContain(aPid);
  const item = page.locator('.session-item', { hasText: 'session-A' }).first();
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});

test('new session from a directory promotes into the sidebar after first message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-promo-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'seeded-session');
  const { page } = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'seeded-session' })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点新建会话图标（group-actions 默认 opacity:0，hover 后才显示）
  const group = page.locator('.group').filter({ has: page.getByTitle(proj) });
  await group.hover();
  await group.locator('[data-action="new-session"]').click();
  // 新会话打开后恰有一个 pty 在跑（WebGL 渲染器无 .xterm-rows 文本层，不再依赖 data-output 镜像）。
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);

  // 新会话的 pi 进程要待 shell-ready 超时注入（默认 1.5s）后才启动，在此前输入会被 shell 当命令消费。
  await page.waitForTimeout(2000);

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hello from new session\n');

  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 15000 });
  // 没发消息的 live 会话不出现；只有新建的这一个 pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
});

test('promoted session reuses the live process (no duplicate) and is highlighted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reuse-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'seeded-session');
  const { page } = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点新建会话图标（group-actions 默认 opacity:0，hover 后才显示）
  const group = page.locator('.group').filter({ has: page.getByTitle(proj) });
  await group.hover();
  await group.locator('[data-action="new-session"]').click();
  // 新建会话的 live 进程已启动（WebGL 渲染器无 .xterm-rows 文本层，不再依赖 data-output 镜像）。
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  // 新会话的 pi 进程要待 shell-ready 超时注入（默认 1.5s）后才启动，在此前输入会被 shell 当命令消费。
  await page.waitForTimeout(2000);
  // tab 标题现在由 pty 的 OSC title 序列驱动（cmd.exe 路径），不再有 “new-session” 占位名。

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hello from new session\n');
  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 15000 });

  // tab 标题现由 pty OSC 序列驱动，不再从消息文本更新，故不校验标题。

  // 晋升后只有一个 live pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 点击晋升后的侧边栏会话：必须复用同一个 live 进程，而非再 spawn 一个重复进程
  await page.locator('.session-item', { hasText: 'hello from new session' }).click();
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 晋升后的会话应被高亮为当前活动会话
  await expect(
    page
      .locator('.group')
      .filter({ has: page.getByTitle(proj) })
      .locator('.session-item.active', { hasText: 'hello from new session' }),
  ).toBeVisible({ timeout: 5000 });

  await electronApp!.close();
});

test('pinning a directory persists across reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pin-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'pin-seeded');
  const { page } = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点击 pin 图标（group-actions 默认 opacity:0，hover 后才显示）
  const group = page.locator('.group').filter({ has: page.getByTitle(proj) });
  await group.hover();
  await group.locator('[data-action="pin"]').click();
  await expect(page.locator('.group.pinned').filter({ has: page.getByTitle(proj) })).toBeVisible({ timeout: 5000 });

  // pin 持久化在主进程 config.json（见 docs/adr/0001），经 pi.getConfig() 验证已写入。
  // 注：不要用 localStorage 断言——pin 不走 localStorage，且 Electron 的 localStorage 跨运行残留会污染。
  const stored = await page.evaluate(() => (window as any).pi.getConfig());
  expect((stored.pinnedDirs as string[]).includes(proj)).toBe(true);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.group.pinned').filter({ has: page.getByTitle(proj) })).toBeVisible({ timeout: 5000 });

  await electronApp!.close();
});

test('jump-to-bottom button appears when scrolled up and returns to latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-jump-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'jump-seeded');
  const { page } = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('.session-item', { hasText: 'jump-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'jump-seeded' }).click();
  // 会话已打开且进程在跑（WebGL 渲染器无 .xterm-rows 文本层，不再依赖 data-output 镜像）。
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(1);
  // 焦点移到 xterm 的输入 textarea（而非 host 容器），确保键盘输入真正进入 pty，
  // 不会因焦点停在未失焦的会话项上、被 Sidebar 的 onKeyDown 误当作“重新打开会话”。
  // 用 focus() 而非 click()：xterm 的 helper textarea 为 opacity:0 且被 canvas 覆盖，
  // click() 会因指针被拦截而不稳定；focus() 直接把键盘焦点移入 textarea。
  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').focus();
  // Flood the terminal so it overflows the viewport (FAB only shows when scrolled up).
  // 需要远超一屏，故填 300 行，确保缓冲区溢出、wheel 上滚后视口离开底部。
  for (let i = 0; i < 300; i++) {
    await page.keyboard.type(`fill ${i}\n`);
  }
  // 会话进程仍存活由后续滚轮触发置底按钮的逻辑间接验证（见下）。
  const vp = page.locator('.terminal-host.active .xterm-viewport');
  // 注意：xterm 6.0.0 的 WebGL 渲染器下 .xterm-viewport 的 scrollHeight 不随缓冲区增长
  // （文本在 <canvas> 上，原生 scrollTop 恒为 0），DOM 原生 scroll 事件也恒不触发。
  // 置底按钮由 xterm buffer API (viewportY < baseY) 经 term.onScroll 驱动
  // （见 XtermTerminal.bindScroll），故这里不再等物理溢出。
  // 用真实鼠标滚轮（移到视口中心再 wheel）触发 xterm 自身的滚轮处理：它移动内部
  // viewportY (ydisp) 并触发 term.onScroll → 驱动置底按钮。用户一旦上滚离底，xterm 的
  // 自动跟随（贴底时收到新数据才跟随）停止，故 fake-pi 的持续 tick 不会把视口拉回底部。
  const box = (await vp.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let scrolledUp = false;
  for (let i = 0; i < 40 && !scrolledUp; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(40);
    scrolledUp = await page.locator('.jump-bottom.visible').count().then((c) => c > 0);
  }
  expect(scrolledUp).toBe(true);
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  // Requirement 5 (layout): the FAB must NOT overlap the native vertical scrollbar.
  // The xterm scrollbar is the rightmost 10px of the viewport (which sits 8px inside the
  // terminal host padding). Assert the button's right edge sits left of the scrollbar.
  const noOverlap = await page.evaluate(() => {
    const btn = document.querySelector('.jump-bottom.visible') as HTMLElement | null;
    const vp = document.querySelector('.terminal-host.active .xterm-viewport') as HTMLElement | null;
    if (!btn || !vp) return false;
    const b = btn.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    const scrollbarLeft = v.right - 10; // 10px webkit scrollbar width (见 .xterm-viewport CSS)
    return b.right <= scrollbarLeft + 1;
  });
  expect(noOverlap).toBe(true);

  // Requirement 4 (runtime): once scrolled up, the jump button stays visible (the buffer is NOT
  // force-snapped to the bottom by incoming data — xterm's native auto-follow only applies when
  // already at the bottom). Verify stability over a few fake-pty ticks.
  await page.waitForTimeout(2500);
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  await page.locator('.jump-bottom.visible').click();
  // Returned to bottom: the visible (active) FAB is gone.
  await expect(page.locator('.jump-bottom.visible')).toHaveCount(0);

  await electronApp!.close();
});
