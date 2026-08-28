import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// 拖拽 Tab 创建/调整分屏布局（ADR-0003）
//
// 通过真实鼠标事件（page.mouse）驱动 @dnd-kit PointerSensor，验证：
//   1. 拖到右边缘 → 水平分屏，被拖 Tab 进入右侧新窗格
//   2. 拖到左边缘 → 水平分屏，被拖 Tab 进入左侧新窗格（'before' 子节点排序）
//   3. 单 Tab 拖到自己窗格边缘 → 源空自动合并（分屏取消，树回退单 leaf）
//   4. 拖到另一窗格 Tab 条 → 移入该窗格，源空后树回退为单 leaf
//   5. 拖到内容区中央 → 无操作（不创建分屏、不移入、无残留高亮）
//   6. 所见即所得：拖到右边缘时预览线框=分屏后新窗格区域（半窗格）
//   7. 跨窗格分屏：拖 Tab 到另一窗格边缘，在该窗格处创建分屏
//   8. 跨窗格分屏 + 源空自动合并：终端实例跨 leaf 保留（keep-alive）
//
// 所有 DOM 读取都在「含 .tab-content 的活跃 .split-pane」内完成：
// 右栏 RightPanel 同样使用 TabBar（渲染 .terminal-tab），不限定作用域会污染选择器。
// 右栏用 .rp-tab-content，中间区用 .tab-content，故以 .tab-content 定位活跃窗格。

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

function launch(env: NodeJS.ProcessEnv) {
  const e = { ...process.env, ...env };
  delete (e as any).ELECTRON_RENDERER_URL;
  return _electron.launch({ args: [MAIN], env: e });
}

/** 写一个磁盘会话（带唯一 stamp，避免同 cwd 多会话文件名冲突）。返回会话 key（jsonl 绝对路径）。 */
function writeDiskSessionAt(dir: string, cwd: string, name: string, stamp: string): string {
  const group = path.join(dir, encodeURIComponent(cwd));
  fs.mkdirSync(group, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 3, id: stamp, timestamp: stamp, cwd });
  const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: name }] } });
  const file = path.join(group, `${stamp}_disk.jsonl`);
  fs.writeFileSync(file, header + '\n' + msg + '\n');
  return file;
}

interface BodyRect { left: number; top: number; width: number; height: number; }

/** 取活跃窗格（含 .tab-content 的 .split-pane）中指定 leaf 的内容区矩形。 */
async function leafBodyRect(page: Page, leafIndex: number): Promise<BodyRect | null> {
  return page.evaluate((idx) => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return null;
    const leaves = Array.from(active.querySelectorAll<HTMLElement>('.split-pane-leaf'));
    const body = leaves[idx]?.querySelector<HTMLElement>('.center-pane-body');
    if (!body) return null;
    const r = body.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, leafIndex);
}

/** 取活跃窗格中指定 leaf 的首个 tab 中心点（拖拽起点）。 */
async function leafFirstTabCenter(page: Page, leafIndex: number) {
  return page.evaluate((idx) => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return null;
    const leaves = Array.from(active.querySelectorAll<HTMLElement>('.split-pane-leaf'));
    const tab = leaves[idx]?.querySelector<HTMLElement>('.terminal-tab');
    if (!tab) return null;
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, leafIndex);
}

/** 活跃窗格中按 DOM 顺序的 tab-content id（即 tab id / 会话 key）。 */
async function tabKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return [];
    return Array.from(active.querySelectorAll<HTMLElement>('.tab-content'))
      .map((el) => el.getAttribute('data-tab-content-id') || '');
  });
}

interface SplitInfo {
  direction: 'horizontal' | 'vertical' | 'single' | 'none';
  counts: number[];        // 每个子 leaf 的 tab 数
  draggedIndex: number;    // 被拖 tab 所在 leaf 索引（-1=未找到/单 leaf）
  emptyTop: boolean;       // 第一个子 leaf 是否为空状态
}

/** 读活跃窗格的分屏结构 + 被拖 tab 落位。 */
async function splitInfo(page: Page, draggedKey: string | null): Promise<SplitInfo> {
  return page.evaluate((key) => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return { direction: 'none', counts: [], draggedIndex: -1, emptyTop: false } as SplitInfo;
    const node = active.querySelector<HTMLElement>('.split-pane-node--horizontal, .split-pane-node--vertical');
    if (!node) {
      const leaf = active.querySelector('.split-pane-leaf');
      const cnt = leaf ? leaf.querySelectorAll('.terminal-tab').length : 0;
      return { direction: 'single', counts: [cnt], draggedIndex: -1, emptyTop: false } as SplitInfo;
    }
    const children = Array.from(node.children).filter((c) => c.classList.contains('split-pane-child'));
    // 单 leaf 也会被 SplitPane 包成 root 节点（1 个子节点）——只在 ≥2 子节点时才视为真分屏
    if (children.length <= 1) {
      const leaf = children[0]?.querySelector('.split-pane-leaf') ?? active.querySelector('.split-pane-leaf');
      const cnt = leaf ? leaf.querySelectorAll('.terminal-tab').length : 0;
      return { direction: 'single', counts: [cnt], draggedIndex: -1, emptyTop: false } as SplitInfo;
    }
    const direction = node.classList.contains('split-pane-node--horizontal') ? 'horizontal' : 'vertical';
    const counts = children.map((c) => c.querySelectorAll('.terminal-tab').length);
    let draggedIndex = -1;
    if (key) {
      const contents = Array.from(active.querySelectorAll<HTMLElement>('.tab-content'));
      const dragged = contents.find((el) => el.getAttribute('data-tab-content-id') === key);
      if (dragged) {
        // 全局 keep-alive（ADR-0003）：.tab-content 由 host 覆盖层绝对定位到所属 leaf
        // 内容区，不再在 DOM 上嵌套于 leaf 内 → 用「中心点落在哪个 child 的内容区矩形」判定。
        const dr = dragged.getBoundingClientRect();
        const cx = dr.left + dr.width / 2;
        const cy = dr.top + dr.height / 2;
        draggedIndex = children.findIndex((c) => {
          const cr = c.getBoundingClientRect();
          return cx >= cr.left && cx <= cr.right && cy >= cr.top && cy <= cr.bottom;
        });
      }
    }
    const emptyTop = !!children[0]?.querySelector('.empty-state');
    return { direction, counts, draggedIndex, emptyTop } as SplitInfo;
  }, draggedKey);
}

/** 计算边缘落点坐标（离对应边缘 6px，确保落在 30% 边缘条带感应区内）。 */
function edgeTarget(body: BodyRect, side: 'left' | 'right' | 'top' | 'bottom') {
  switch (side) {
    case 'right':  return { x: body.left + body.width - 6, y: body.top + body.height * 0.5 };
    case 'left':   return { x: body.left + 6,             y: body.top + body.height * 0.5 };
    case 'bottom': return { x: body.left + body.width * 0.5, y: body.top + body.height - 6 };
    case 'top':    return { x: body.left + body.width * 0.5, y: body.top + 6 };
  }
}

/**
 * 模拟拖拽：按下起点 → 越过 PointerSensor 的 4px 激活阈值 → 等边缘条带挂载 →
 * 逐步移动到目标（持续触发 onDragOver）→ 松开。失败时重试一次（拖拽坐标碰撞偶有抖动）。
 */
async function dragMouse(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y, { steps: 4 });
  await page.waitForTimeout(160); // 等 isDragging=true 触发 SplitPaneLeaf 重渲染挂载边缘条带
  await page.mouse.move(to.x, to.y, { steps: 30 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

/** 等待活跃窗格出现恰好 n 个 tab-content。 */
async function waitForTabCount(page: Page, n: number) {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
      const active = panes.find((p) => p.querySelector('.tab-content'));
      return active ? active.querySelectorAll('.tab-content').length : 0;
    });
  }, { timeout: 15000 }).toBe(n);
}

async function openSessions(page: Page, proj: string, names: string[]) {
  for (const name of names) {
    await expect(page.locator('.session-item', { hasText: name })).toBeVisible({ timeout: 15000 });
    await page.locator('.session-item', { hasText: name }).click();
  }
  await waitForTabCount(page, names.length);
  // 确认 fake-pi 后端已加载（避免拖拽前会话未真正打开的假绿）
  await expect.poll(async () => (await page.evaluate(() => (window as any).pi.debug())).count, { timeout: 15000 }).toBe(names.length);
}

// ───────────────────────────────────────────────────────────────

test('拖 Tab 到右边缘 → 水平分屏，被拖 Tab 进入右侧新窗格', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-r-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-r-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-001Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-002Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  const keys = await tabKeys(page); // [keyA, keyB]
  expect(keys).toHaveLength(2);
  const from = await leafFirstTabCenter(page, 0); // 拖首个 tab（tabs-a）
  const body = await leafBodyRect(page, 0);
  if (!from || !body) throw new Error('tab/body not found');

  await dragMouse(page, from, edgeTarget(body, 'right'));

  const s = await splitInfo(page, keys[0]); // 被拖 tab = keyA
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 1]);   // 左右各 1 tab
  expect(s.draggedIndex).toBe(1);      // 被拖 tab 在右侧新窗格

  await electronApp.close();
});

test('拖 Tab 到左边缘 → 水平分屏，被拖 Tab 进入左侧新窗格（before 子节点）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-l-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-l-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-011Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-012Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  const keys = await tabKeys(page);
  const from = await leafFirstTabCenter(page, 0);
  const body = await leafBodyRect(page, 0);
  if (!from || !body) throw new Error('tab/body not found');

  await dragMouse(page, from, edgeTarget(body, 'left'));

  const s = await splitInfo(page, keys[0]); // 被拖 tab 进入左侧新窗格
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 1]);
  expect(s.draggedIndex).toBe(0); // before：新窗格前置 → 被拖 tab 在左

  await electronApp.close();
});

test('单 Tab 拖到自己窗格边缘 → 源空自动合并（分屏取消，树回退单 leaf）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-b-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-b-'));
  writeDiskSessionAt(dir, proj, 'only-a', '2026-07-14T12-00-00-021Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['only-a']);

  const keys = await tabKeys(page);
  expect(keys).toHaveLength(1);
  const from = await leafFirstTabCenter(page, 0);
  const body = await leafBodyRect(page, 0);
  if (!from || !body) throw new Error('tab/body not found');

  await dragMouse(page, from, edgeTarget(body, 'bottom'));

  // 单 tab 拖出后源空 → 自动合并：splitNode 内空 half 被移除，只剩新 leaf → 提升 → 分屏取消
  const s = await splitInfo(page, keys[0]);
  expect(s.direction).toBe('single');
  expect(s.counts).toEqual([1]); // tab 留在原位
  // 无空窗格 / 空状态残留
  const emptyState = await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    return !!active?.querySelector('.empty-state');
  });
  expect(emptyState).toBe(false);

  await electronApp.close();
});

test('拖 Tab 到另一窗格 Tab 条 → 移入该窗格，源空后树回退为单 leaf', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-c-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-c-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-031Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-032Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  const keys = await tabKeys(page); // [keyA, keyB]
  const from1 = await leafFirstTabCenter(page, 0);
  const body0 = await leafBodyRect(page, 0);
  if (!from1 || !body0) throw new Error('tab/body not found');

  // 第 1 步：拖 tabs-a 到右边缘，创建水平分屏 → 左{b} | 右{a}
  await dragMouse(page, from1, edgeTarget(body0, 'right'));
  let s = await splitInfo(page, keys[0]);
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 1]);
  expect(s.draggedIndex).toBe(1); // a 在右

  // 第 2 步：拖左 leaf（b）的 tab 到右 leaf 的 Tab 条（其 tab a 上）→ 移入右窗格。
  // 移入窗格只能拖到目标窗格的 Tab 条（ADR-0003 简化：内容区中央不再是落点）。
  // 移走 b 后源左 leaf 为空被摘除，树回退为单 leaf（含 a、b）。
  const from2 = await leafFirstTabCenter(page, 0); // 左 leaf 的 tab（b）
  const to2 = await leafFirstTabCenter(page, 1);   // 右 leaf 的 tab（a）—— Tab 条落点
  if (!from2 || !to2) throw new Error('tab targets not found');
  await dragMouse(page, from2, to2);

  s = await splitInfo(page, null);
  expect(s.direction).toBe('single'); // 源空后树回退为单 leaf
  expect(s.counts).toEqual([2]);       // 单 leaf 含两个 tab
  expect(s.draggedIndex).toBe(-1);

  await electronApp.close();
});

test('拖 Tab 到内容区中央 → 无操作（不创建分屏、不移入、无残留高亮）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-d-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-d-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-041Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-042Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  const from = await leafFirstTabCenter(page, 0);
  const body = await leafBodyRect(page, 0);
  if (!from || !body) throw new Error('tab/body not found');
  const center = { x: body.left + body.width / 2, y: body.top + body.height / 2 };

  await dragMouse(page, from, center);

  const s = await splitInfo(page, null);
  expect(s.direction).toBe('single'); // 未创建分屏
  expect(s.counts).toEqual([2]);       // 未移动（仍单 leaf 两 tab）
  // 无残留高亮（拖到死区后 hoveredLeafId 应被清除）
  const residualOutline = await page.evaluate(() => !!document.querySelector('.split-pane-leaf--drag-over'));
  expect(residualOutline).toBe(false);

  await electronApp.close();
});

test('所见即所得：拖到右边缘时预览线框精确等于分屏后新窗格区域（半窗格）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-e-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-e-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-051Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-052Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  const body = await leafBodyRect(page, 0);
  const from = await leafFirstTabCenter(page, 0);
  if (!from || !body) throw new Error('tab/body not found');

  // 手动拖拽序列：在松开前断言预览线框
  const to = edgeTarget(body, 'right');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y, { steps: 4 });
  await page.waitForTimeout(160);
  await page.mouse.move(to.x, to.y, { steps: 30 });
  await page.waitForTimeout(120);

  // 断言：.split-preview--right 可见，且坐标为 body 右半（left=body.left+body.width/2±2px）
  const preview = await page.evaluate(() => {
    const el = document.querySelector('.split-preview--right');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return null;
    const leafBody = active.querySelector('.center-pane-body');
    if (!leafBody) return null;
    const br = leafBody.closest('.split-pane-leaf')?.getBoundingClientRect();
    return { l: r.left, t: r.top, w: r.width, h: r.height, leaf: br ? { l: br.left, w: br.width } : null };
  });
  expect(preview).not.toBeNull();
  if (!preview || !preview.leaf) throw new Error('preview/leaf rect not found');

  // 线框右边缘对齐 leaf 右边缘，左边缘 ≈ leaf 中位线（半窗格）
  expect(preview.l).toBeCloseTo(preview.leaf.l + preview.leaf.w / 2, 0);
  expect(preview.l + preview.w).toBeCloseTo(preview.leaf.l + preview.leaf.w, 0);

  // 松手 → 确认分屏成功
  await page.mouse.up();
  const s = await splitInfo(page, null);
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 1]);

  await electronApp.close();
});

test('跨窗格分屏：拖 Tab 到另一窗格边缘，在该窗格处创建分屏', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-f-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-f-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-061Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-062Z');
  writeDiskSessionAt(dir, proj, 'tabs-c', '2026-07-14T12-00-00-063Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b', 'tabs-c']);

  const keys = await tabKeys(page); // [keyA, keyB, keyC]

  // 第 1 步：拖 a 到右边缘 → 水平分屏 [左{b,c} | 右{a}]
  const from1 = await leafFirstTabCenter(page, 0);
  const body0 = await leafBodyRect(page, 0);
  if (!from1 || !body0) throw new Error('tab/body not found');
  await dragMouse(page, from1, edgeTarget(body0, 'right'));
  let s = await splitInfo(page, keys[0]);
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([2, 1]); // 左{b,c}=2, 右{a}=1
  expect(s.draggedIndex).toBe(1); // a 在右

  // 第 2 步：拖左 leaf 的 b 到右 leaf 的右边缘 → 在右 leaf 处创建垂直分屏
  // 跨窗格分屏（ADR-0003）：源=b 在左 leaf，目标边缘在右 leaf，分屏建在右 leaf。
  // 第 2 步：拖左 leaf 的 b 到右 leaf 的右边缘 → 在右 leaf 处水平分屏 [B{a} | new{b}]
  // 跨窗格分屏（ADR-0003）：源=b 在左 leaf，目标边缘在右 leaf，分屏建在右 leaf。
  const from2 = await leafFirstTabCenter(page, 0); // 左 leaf 首个 tab（b，a 已移走）
  const body1 = await leafBodyRect(page, 1);       // 右 leaf 内容区
  if (!from2 || !body1) throw new Error('left tab/right body not found');
  await dragMouse(page, from2, edgeTarget(body1, 'right'));

  // 顶层仍水平；左 leaf 移除 b 后剩 c（1），右 leaf 变水平分屏含 a+b（2）
  s = await splitInfo(page, keys[1]);
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 2]);
  expect(s.draggedIndex).toBe(1); // b 落在右 child

  // 验证右 child 是分屏节点（在右 leaf 处新建的水平分屏，含 a + b），而非单 leaf
  const rightChildIsSplit = await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    if (!active) return false;
    const root = active.querySelector('.split-pane-node--horizontal, .split-pane-node--vertical');
    if (!root || !root.classList.contains('split-pane-node--horizontal')) return false;
    const children = Array.from(root.children).filter((c) => c.classList.contains('split-pane-child'));
    const right = children[1];
    return !!right?.querySelector('.split-pane-node--horizontal, .split-pane-node--vertical');
  });
  expect(rightChildIsSplit).toBe(true);

  await electronApp.close();
});

test('跨窗格分屏 + 源空自动合并：终端实例跨 leaf 保留（keep-alive）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-split-g-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-g-'));
  writeDiskSessionAt(dir, proj, 'tabs-a', '2026-07-14T12-00-00-081Z');
  writeDiskSessionAt(dir, proj, 'tabs-b', '2026-07-14T12-00-00-082Z');

  electronApp = await launch({ PI_WORKBENCH_FAKE: '1', PI_WORKBENCH_SESSIONS_DIR: dir });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate((d) => (window as any).pi.setConfig({ addedDirs: [d] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  await openSessions(page, proj, ['tabs-a', 'tabs-b']);

  // 等两个终端 host 挂载
  await expect.poll(async () => {
    return page.evaluate(() => document.querySelectorAll('.split-pane .terminal-host').length);
  }, { timeout: 15000 }).toBe(2);

  // 实例层面基线：paneManager 注册表两个实例，key 与 scrollback 非空
  const initialKeys = await page.evaluate(() => (window as any).__piPaneManager?.()?.keys ?? []);
  expect(initialKeys.length).toBe(2);

  // 给所有 terminal-host 打标记：JS 属性随节点保留（reparent）而保留、随节点销毁而丢失。
  await page.evaluate(() => {
    document.querySelectorAll('.split-pane .terminal-host').forEach((h) => {
      (h as any).__crossLeafSurvive = 1;
    });
  });

  const keys = await tabKeys(page); // [keyA, keyB]

  // 第 1 步：拖 a 到右边缘 → [左{b} | 右{a}]（源左不空，分屏成立，a 跨 leaf）
  const from1 = await leafFirstTabCenter(page, 0);
  const body0 = await leafBodyRect(page, 0);
  if (!from1 || !body0) throw new Error('tab/body not found');
  await dragMouse(page, from1, edgeTarget(body0, 'right'));
  let s = await splitInfo(page, keys[0]);
  expect(s.direction).toBe('horizontal');
  expect(s.counts).toEqual([1, 1]);
  expect(s.draggedIndex).toBe(1); // a 在右 leaf

  // 第 2 步：拖右{a}（单 tab）到左窗格 b 的下边缘 → 在左窗格垂直分屏；
  // 右窗格源空 → 自动合并（不留空窗格，树回退为左窗格的垂直分屏）。
  const from2 = await leafFirstTabCenter(page, 1); // 右 leaf 的 tab（a）
  const body1 = await leafBodyRect(page, 0);       // 左窗格内容区
  if (!from2 || !body1) throw new Error('tab/body not found');
  await dragMouse(page, from2, edgeTarget(body1, 'bottom'));

  // 右窗格被自动合并：树 = [上{b} | 下{a}]（根变垂直分屏）
  s = await splitInfo(page, keys[0]);
  expect(s.direction).toBe('vertical');
  expect(s.counts).toEqual([1, 1]);
  expect(s.draggedIndex).toBe(1); // a 在下（after）

  // keep-alive：所有 terminal-host 节点存活（带标记，未被重建）；paneManager 注册表未销毁重建
  const marked = await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>('.split-pane'));
    const active = panes.find((p) => p.querySelector('.tab-content'));
    const hosts = active ? Array.from(active.querySelectorAll('.terminal-host')) : [];
    return {
      total: hosts.length,
      marked: hosts.filter((h) => (h as any).__crossLeafSurvive === 1).length,
    };
  });
  expect(marked.total).toBe(2);
  expect(marked.marked).toBe(2);

  const pm = await page.evaluate(() => {
    const p = (window as any).__piPaneManager?.();
    if (!p) return null;
    return { count: p.paneCount, keys: p.keys, lens: p.scrollbacks?.map((x: any) => x.len) ?? [] };
  });
  expect(pm?.count).toBe(2);
  expect(pm?.keys).toEqual(initialKeys);
  expect(pm?.lens.every((l: number) => l > 0)).toBe(true);

  await electronApp.close();
});