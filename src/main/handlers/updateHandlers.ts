import { ipcMain } from 'electron';
import { checkForUpdate, getUpdateStatus, getCurrentVersion } from '../updateChecker';

/**
 * 版本更新检查 IPC handler 注册。
 *
 * 仅提供版本检查能力——发现新版本后只返回 release 页面 URL，
 * 由用户自行前往 GitHub 下载安装包。
 *
 * 接收依赖注入，不直接引用 Electron 全局对象，便于测试。
 */
export function registerUpdateHandlers(
  ipcMain: Electron.IpcMain,
  _win: Electron.BrowserWindow,
): void {
  // ╌╌ 版本更新检查 ╌╌
  ipcMain.handle('update:check', async (_e, force = false) => {
    try {
      return await checkForUpdate(force);
    } catch (err) {
      console.error('[update:check] failed:', err);
      throw new Error('检查更新失败');
    }
  });
  ipcMain.handle('update:get-status', () => getUpdateStatus());
  // 获取当前版本（无需网络请求，立即返回）
  ipcMain.handle('update:get-current-version', () => getCurrentVersion());
}