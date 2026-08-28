import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, PI_WORKBENCH_FAKE: '1' };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

/** 断言容器内所有 img 真实加载成功（naturalWidth>0）。 */
async function expectAllImgsLoaded(page: Page, containerSel: string): Promise<void> {
  await expect(page.locator(`${containerSel} img`).first()).toBeVisible({ timeout: 15000 });
  const results = await page.locator(`${containerSel} img`).evaluateAll((imgs) =>
    imgs.map((img) => ({ src: (img as HTMLImageElement).getAttribute('src'), w: (img as HTMLImageElement).naturalWidth })),
  );
  // eslint-disable-next-line no-console
  console.log('IMGS:', JSON.stringify(results));
  for (const r of results) {
    expect(r.w, `img 加载失败: ${r.src}`).toBeGreaterThan(0);
  }
}

test('markdown 预览模式与富文本模式都显示本地图片', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mdimg-'));
  fs.mkdirSync(path.join(proj, 'docs'));
  fs.mkdirSync(path.join(proj, 'docs', 'images'));
  fs.writeFileSync(path.join(proj, 'docs', 'images', 'pic1.png'), PNG_BYTES);
  fs.writeFileSync(path.join(proj, 'docs', 'images', 'pic2.png'), PNG_BYTES);
  fs.writeFileSync(
    path.join(proj, 'docs', 'guide.md'),
    '# 指南\n\n![图一](./images/pic1.png)\n\n![图二](./images/pic2.png)\n',
  );

  const { page } = await launch();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push('PAGEERROR: ' + (err.stack || err.message)));

  await page.evaluate((dir) => (window as any).pi.setConfig({ addedDirs: [dir] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // 右栏 auto 模式跟随最后活跃会话 cwd（fake 无会话 → 默认工作目录），
  // 手动切到测试目录作为文件树根。
  await expect(page.locator('.rp-root-select')).toBeVisible({ timeout: 15000 });
  await page.selectOption('.rp-root-select', { label: path.basename(proj) });

  // 文件树中展开 docs → guide.md，点击打开
  await expect(page.locator('.file-tree .file-row', { hasText: 'docs' })).toBeVisible({ timeout: 15000 });
  await page.locator('.file-tree .file-row', { hasText: 'docs' }).click();
  await expect(page.locator('.file-tree .file-row', { hasText: 'guide.md' })).toBeVisible({ timeout: 15000 });
  await page.locator('.file-tree .file-row', { hasText: 'guide.md' }).click();

  // 打开后默认「预览」模式（MarkdownPreview）
  await expect(page.locator('.preview-tab .markdown-file-preview')).toBeVisible({ timeout: 15000 });
  await expectAllImgsLoaded(page, '.markdown-file-preview');

  // 切到「富文本」模式（RichMarkdownEditor / TipTap）
  await page.locator('.code-preview-toggle button', { hasText: '富文本' }).click();
  await expect(page.locator('.md-rich-editor')).toBeVisible({ timeout: 15000 });
  await expectAllImgsLoaded(page, '.md-rich-editor');

  // 切回「源码」模式无崩溃
  await page.locator('.code-preview-toggle button', { hasText: '源码' }).click();
  await expect(page.locator('.monaco-code-editor')).toBeVisible({ timeout: 15000 });

  if (errors.length) {
    console.log('=== RUNTIME ERRORS ===');
    errors.forEach((e) => console.log(e));
    throw new Error('Runtime errors detected:\n' + errors.join('\n'));
  }

  await electronApp!.close();
});

// dev 模式页面从 http://localhost 加载：file:// 子资源被 Chromium 阻止，
// pi-local 自定义协议可用。这是「dev 下图片不显示」的根因回归测试。
test('dev-sim: http 页面可加载 pi-local:// 图片，file:// 被阻止', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-img-'));
  const pngPath = path.join(dir, 'pic.png');
  fs.writeFileSync(pngPath, PNG_BYTES);
  const norm = pngPath.replace(/\\/g, '/');
  const piUrl = `pi-local://file/?path=${encodeURIComponent(norm)}`;
  const fileUrl = 'file:///' + norm.replace(/^\/+/, '');

  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>http page</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const e = { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}/` };
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const loadImage = async (src: string): Promise<number> =>
    await page.evaluate(async (src) => {
      return await new Promise<number>((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(-1);
        img.src = src;
        setTimeout(() => resolve(img.naturalWidth > 0 ? img.naturalWidth : 0), 3000);
        document.body.appendChild(img);
      });
    }, src);

  const wPi = await loadImage(piUrl);
  const wFile = await loadImage(fileUrl);
  // eslint-disable-next-line no-console
  console.log('DEV-SIM pi-local =', wPi, '| file:// =', wFile);
  expect(wPi).toBeGreaterThan(0); // 修复目标：http 页面可加载本地图片
  expect(wFile).toBeLessThan(1); // 原根因：file:// 在 http 页面被阻止

  await new Promise<void>((r) => server.close(r));
  await electronApp!.close();
});