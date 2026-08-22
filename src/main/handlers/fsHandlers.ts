import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { shell } from 'electron';
import { ReferenceCountedWatcher } from '../shared/ReferenceCountedWatcher';
import {
  listDir, readFile, writeFile, statFile,
  mkdir, createFile, rename, remove, copy,
  listNames, uniqueName, watchDir, watchFile,
  snapshotTree, restoreTree, type TreeSnapshot,
} from '../fsBridge';

/**
 * 使用 child_process.exec 绕过 Electron 30+ 的 shell.openExternal 安全确认对话框
 * （该对话框无法通过用户手势规避）。
 */
function openUrlInExternal(url: string): void {
  const escaped = url.replace(/"/g, '\\"');
  const cmd = process.platform === 'darwin'
    ? `open "${escaped}"`
    : process.platform === 'win32'
      ? `start "" "${escaped}"`
      : `xdg-open "${escaped}"`;
  exec(cmd, (err) => {
    if (err) console.error('[openUrlInExternal] failed:', err.message);
  });
}

/**
 * 文件系统相关 IPC handler 注册。
 *
 * 包含 app:openExternal、fs:* 系列 handler。
 */
export function registerFsHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
): void {
  // 受控外部链接通道：渲染层经此桥请求打开外部程序（系统浏览器/mail 客户端）。
  ipcMain.handle('app:openExternal', (_e, url: string): boolean => {
    if (typeof url !== 'string' || !url) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') {
      return false;
    }
    openUrlInExternal(url);
    return true;
  });

  // 用系统默认程序打开本地文件（二进制/无内置预览器的文件，如 pdf/exe/zip/docx 等）。
  ipcMain.handle('fs:openWithSystem', async (_e, absPath: string): Promise<boolean> => {
    if (typeof absPath !== 'string' || !absPath) return false;
    try { await shell.openPath(absPath); return true; }
    catch { return false; }
  });

  // 在系统文件管理器中打开文件/目录所在位置并选中
  ipcMain.handle('fs:showInFolder', async (_e, absPath: string): Promise<boolean> => {
    if (typeof absPath !== 'string' || !absPath) return false;
    try { shell.showItemInFolder(absPath); return true; }
    catch { return false; }
  });

  // ── 文件管理器（A + B 预览）只读/写 IPC ──
  ipcMain.handle('fs:listDir', (_e, req: { root: string; dir: string }) =>
    listDir(req.root, req.dir));

  // ╌╌ 目录监听（外部变更自动刷新）╌╌
  const dirWatchers = new ReferenceCountedWatcher<string>();
  const watchKey = (root: string, dir: string) => `${root} ${dir}`;
  ipcMain.on('fs:watch', (_e, req: { root: string; dir: string }) => {
    const key = watchKey(req.root, req.dir);
    dirWatchers.watch(key, () => {
      const stop = watchDir(req.root, req.dir, (filename) => {
        if (filename === '.git') return;
        if (!win.isDestroyed()) win.webContents.send('fs:change', { dir: req.dir });
      });
      return stop;
    });
  });
  ipcMain.on('fs:unwatch', (_e, req: { root: string; dir: string }) => {
    const key = watchKey(req.root, req.dir);
    dirWatchers.unwatch(key);
  });

  // ╌╌ 文件监听（外部修改自动刷新编辑器）╌╌
  const fileWatchers = new ReferenceCountedWatcher<string>();
  const fileWatchKey = (root: string, path: string) => `${root} ${path}`;
  ipcMain.on('fs:watchFile', (_e, req: { root: string; path: string }) => {
    const key = fileWatchKey(req.root, req.path);
    fileWatchers.watch(key, () => {
      const stop = watchFile(req.root, req.path, () => {
        if (!win.isDestroyed()) win.webContents.send('fs:fileChange', { root: req.root, path: req.path });
      });
      return stop;
    });
  });
  ipcMain.on('fs:unwatchFile', (_e, req: { root: string; path: string }) => {
    const key = fileWatchKey(req.root, req.path);
    fileWatchers.unwatch(key);
  });

  ipcMain.handle('fs:readFile', (_e, req: { root: string; path: string; maxBytes?: number }) =>
    readFile(req.root, req.path, req.maxBytes));
  ipcMain.handle('fs:writeFile', (_e, req: { root: string; path: string; content: string }) =>
    writeFile(req.root, req.path, req.content));
  ipcMain.handle('fs:stat', (_e, req: { root: string; path: string }) =>
    statFile(req.root, req.path));

  // ── 文件管理写操作 ──
  ipcMain.handle('fs:mkdir', (_e, req: { root: string; dir: string }) =>
    mkdir(req.root, req.dir));
  ipcMain.handle('fs:createFile', (_e, req: { root: string; path: string; content?: string }) =>
    createFile(req.root, req.path, req.content ?? ''));
  ipcMain.handle('fs:rename', (_e, req: { root: string; from: string; to: string }) =>
    rename(req.root, req.from, req.to));
  ipcMain.handle('fs:remove', (_e, req: { root: string; path: string }) =>
    remove(req.root, req.path));
  ipcMain.handle('fs:copy', (_e, req: { root: string; from: string; to: string }) =>
    copy(req.root, req.from, req.to));
  ipcMain.handle('fs:listNames', (_e, req: { root: string; dir: string }) =>
    listNames(req.root, req.dir));
  ipcMain.handle('fs:uniqueName', (_e, req: { base: string; existing: string[] }) =>
    uniqueName(req.base, new Set(req.existing)));
  // ╌╌ 删除撤销：快照与恢复（Ctrl+Z 撤销文件树删除）╌╌
  ipcMain.handle('fs:snapshot', (_e, req: { root: string; path: string }) =>
    snapshotTree(req.root, req.path));
  ipcMain.handle('fs:restore', (_e, req: { root: string; path: string; snapshot: TreeSnapshot }) =>
    restoreTree(req.root, req.path, req.snapshot));
}