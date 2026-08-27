import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) {
    await electronApp.close().catch(() => {});
    electronApp = undefined;
  }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, PI_DESKTOP_FAKE: '1' };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

async function readScroll(page: Page, sel: string): Promise<{ scrollTop: number; max: number; fraction: number } | null> {
  return await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return null;
    const max = el.scrollHeight - el.clientHeight;
    return { scrollTop: el.scrollTop, max, fraction: max > 0 ? +(el.scrollTop / max).toFixed(3) : 0 };
  }, sel);
}

// 生成可滚动的长 markdown：多个标题 + 段落
function makeLongMarkdown(lines = 120): string {
  const arr: string[] = [];
  for (let i = 1; i <= lines; i++) arr.push(`## 标题 ${i}\n\n第 ${i} 节正文 ${'x'.repeat(80)}\n`);
  return arr.join('\n');
}

async function openMarkdownFile(page: Page, proj: string, fileName = 'doc.md'): Promise<void> {
  fs.writeFileSync(path.join(proj, fileName), makeLongMarkdown());
  await page.evaluate((dir) => (window as any).pi.setConfig({ addedDirs: [dir] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });
  await expect(page.locator('.file-tree .file-row', { hasText: fileName })).toBeVisible({ timeout: 15000 });
  await page.locator('.file-tree .file-row', { hasText: fileName }).click();
}

// 回归：切到富文本视图不应被 focus 触发的 scrollToSelection 强制拉到底部。
// 根因：PreviewTab/SplitPane 的「激活即聚焦」对 .ProseMirror 调原生 dom.focus()，
// Chromium 把 caret 隐式放到文档末尾 → ProseMirror DOMObserver 跟随 selection
// 变化 → scrollToSelection 滚到底部，覆盖跨视图滚动位置复用。修复：聚焦走
// TipTap 受控 editor.commands.focus('start', { scrollIntoView: false })。
test('切到富文本视图不滚底（预览 -> 富文本）', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mdscroll-'));
  const { page } = await launch();
  await openMarkdownFile(page, proj);

  await expect(page.locator('.preview-tab .markdown-file-preview')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);

  // 预览滚动到中部 → onScroll 上报 fraction ≈ 0.5
  await page.evaluate(() => {
    const el = document.querySelector('.markdown-file-preview') as HTMLElement | null;
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5;
  });
  await page.waitForTimeout(400);

  await page.locator('.code-preview-toggle button', { hasText: '富文本' }).click();
  await expect(page.locator('.md-rich-editor')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);

  const r = await readScroll(page, '.md-rich-body');
  // eslint-disable-next-line no-console
  console.log('RICH(preview->rich):', JSON.stringify(r));
  if (r && r.max > 100) {
    expect(r.fraction).toBeGreaterThan(0.1);
    expect(r.fraction).toBeLessThan(0.99); // 不滚到底
  }
  await electronApp!.close();
});

// 回归（Monaco onDidScrollChange 上报链路）：源码视图用鼠标滚轮滚动后切到富文本，
// 不应滚到底部。
test('切到富文本视图不滚底（源码 -> 富文本，Monaco 滚轮上报）', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mdscroll2-'));
  const { page } = await launch();
  await openMarkdownFile(page, proj);

  await page.locator('.code-preview-toggle button', { hasText: '源码' }).click();
  await expect(page.locator('.monaco-editor textarea')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(800);

  // 鼠标滚轮在 Monaco 上真实滚动 → onDidScrollChange 上报 fraction
  const box = (await page.locator('.monaco-editor').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);

  await page.locator('.code-preview-toggle button', { hasText: '富文本' }).click();
  await expect(page.locator('.md-rich-editor')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);

  const r = await readScroll(page, '.md-rich-body');
  // eslint-disable-next-line no-console
  console.log('RICH(source->rich):', JSON.stringify(r));
  if (r && r.max > 100) {
    expect(r.fraction).toBeLessThan(0.99); // 不滚到底
  }
  await electronApp!.close();
});