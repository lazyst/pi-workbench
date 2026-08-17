import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { dialog, app } from 'electron';
import type { SessionFileManager } from '../sessionFileManager';
import type { UnifiedTerminalPool } from '../unifiedTerminalPool';

/**
 * 会话文件管理相关 IPC handler 注册。
 *
 * 包含 session:* 系列 handler 以及会话文件变更的 fs.watch 推送。
 */
export function registerSessionHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
  sessionFileManager: SessionFileManager,
  unifiedPool: UnifiedTerminalPool,
  sessionsDir: string,
): void {
  // 会话写盘（用户发首条消息后 pi 写出 .jsonl）即视为"晋升"，推送最新索引给渲染进程。
  // 300ms debounce 合并突发写入。recursive watch 在 Windows/macOS 原生支持。
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const pushIndex = () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(async () => {
      if (win.isDestroyed()) return;
      const groups = sessionFileManager.listFiles();
      // Link freshly-written disk sessions to the live processes that created them
      // so clicking a promoted sidebar entry reuses the same process.
      // reconcile 异步执行（fs.promises），等待完成后再推送最新索引。
      try {
        await unifiedPool.reconcile(groups);
      } catch (err) {
        console.error('[session:reconcile] failed:', err);
      }
      if (win.isDestroyed()) return;
      win.webContents.send('session:index', groups);
    }, 300);
  };
  try {
    fs.watch(sessionsDir, { recursive: true }, pushIndex);
  } catch (err) {
    console.error('[session:index] fs.watch failed:', err);
  }

  ipcMain.handle('session:list', () => sessionFileManager.listFiles());
  ipcMain.handle('session:readContent', (_e, key: string) => sessionFileManager.readContent(key));
  ipcMain.handle('session:delete', (_e, key: string) => {
    sessionFileManager.deleteSession(key);
    unifiedPool.terminate(key); // 同时杀掉运行中的进程（如有）
    pushIndex();
  });
  ipcMain.handle('session:deleteMany', (_e, keys: string[]) => {
    sessionFileManager.deleteMany(keys);
    for (const k of keys) unifiedPool.terminate(k);
    pushIndex();
  });
  ipcMain.handle('session:clearDirectory', (_e, cwd: string) => {
    // 先杀掉该 cwd 下所有运行中的 pi 会话
    for (const t of unifiedPool.list()) {
      if (t.cwd === cwd && t.type === 'pi') unifiedPool.terminate(t.id);
    }
    sessionFileManager.clearDirectory(cwd);
    pushIndex();
  });
  ipcMain.handle('session:debug', () => sessionFileManager.debugInfo(unifiedPool.debugSnapshot()));
  ipcMain.handle('session:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  // session:saveImage — 图片粘贴落盘（保持不变）
  ipcMain.handle('session:saveImage', (_e, payload: { data: string; ext: string }) => {
    try {
      if (!payload || typeof payload.data !== 'string' || !payload.data) return null;
      const ext = (payload.ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png';
      const tmpDir = app.getPath('temp');
      const name = `pi-paste-${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(tmpDir, name);
      const buf = Buffer.from(payload.data, 'base64');
      fs.writeFileSync(filePath, buf);
      return filePath;
    } catch (err) {
      console.error('[session:saveImage] failed:', err);
      return null;
    }
  });
}