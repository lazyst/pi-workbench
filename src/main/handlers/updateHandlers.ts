import { app, ipcMain } from 'electron';
import { checkForUpdate, getUpdateStatus, getCurrentVersion, downloadUpdate, installUpdate, cancelDownload } from '../updateChecker';

/**
 * 版本更新相关 IPC handler 注册。
 *
 * 接收依赖注入，不直接引用 Electron 全局对象，便于测试。
 */
export function registerUpdateHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
): void {
  // ╌╌ 版本更新检查 ╌╌
  ipcMain.handle('update:check', async () => {
    try {
      return await checkForUpdate();
    } catch (err) {
      console.error('[update:check] failed:', err);
      throw new Error('检查更新失败');
    }
  });
  ipcMain.handle('update:get-status', () => getUpdateStatus());
  // 获取当前版本（无需网络请求，立即返回）
  ipcMain.handle('update:get-current-version', () => getCurrentVersion());
  // 下载更新：下载最新 release 安装包，通过 IPC 事件推送进度
  ipcMain.handle('update:download', async () => {
    try {
      const filePath = await downloadUpdate((progress) => {
        if (!win.isDestroyed()) {
          win.webContents.send('update:download-progress', progress);
        }
      });
      return { success: true, filePath };
    } catch (err) {
      console.error('[update:download] failed:', err);
      throw new Error(err instanceof Error ? err.message : '下载失败');
    }
  });
  // 取消下载
  ipcMain.on('update:cancel-download', () => cancelDownload());
  // 安装更新：运行已下载的安装包
  ipcMain.handle('update:install', async (_e, filePath: string) => {
    try {
      installUpdate(filePath);
      // 安装包启动后，退出当前应用以便安装程序覆盖文件
      app.quit();
      return { success: true };
    } catch (err) {
      console.error('[update:install] failed:', err);
      throw new Error(err instanceof Error ? err.message : '安装失败');
    }
  });
}