import type { TerminalProfile } from '../../renderer/src/types';
import type { TerminalInfo, UnifiedTerminalPool } from '../unifiedTerminalPool';
import type { PtyOwnershipRegistry } from '../ptyOwnershipRegistry';
import { detectTerminalProfiles } from '../shellProfiles';

/**
 * 终端相关 IPC handler 注册。
 *
 * 接收依赖注入，不直接引用 Electron 全局对象，便于测试。
 */
export function registerTerminalHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
  unifiedPool: UnifiedTerminalPool,
  pushTerminalList: () => void,
  ensureAppWorkDir: () => string,
  ptyRegistry: PtyOwnershipRegistry,
): void {
  /** 创建终端后推送列表；失败时记日志并拋出友好错误。 */
  const createAndList = (factory: () => TerminalInfo, label: string, errMsg: string): TerminalInfo => {
    try {
      const info = factory();
      pushTerminalList();
      return info;
    } catch (err) {
      console.error(`[terminal:${label}] failed:`, err);
      throw new Error(errMsg);
    }
  };
  // 渲染进程告知主进程某个 PTY 的初始 owner key
  // 用于主进程在 PTY 退出时清理所有关联的 sub-session
  ipcMain.on('session:register-pty-owner', (_e, { ptyId, ownerKey }: { ptyId: string; ownerKey: string }) => {
    ptyRegistry.setOwner(ptyId, ownerKey);
  });

  // 滚动缓冲区持久化（内存暂存）
  const terminalBuffers = new Map<string, string>();

  // terminal:spawn — 创建终端（pi 会话或 shell 终端，由 SpawnOptions.command 区分）
  ipcMain.handle('terminal:spawn', (_e, req: { command?: string; cwd: string; profile?: TerminalProfile; sessionFile?: string; name?: string; key?: string }) =>
    createAndList(() => unifiedPool.create(req), 'spawn', '无法启动终端，请确认 pi 或 shell 可用'),
  );

  // terminal:listProfiles — 列出可用 shell profile
  ipcMain.handle('terminal:listProfiles', () => detectTerminalProfiles());

  // terminal:list — 列出所有终端
  ipcMain.handle('terminal:list', () => unifiedPool.list());

  // terminal:create — 旧版集成终端创建入口
  ipcMain.handle('terminal:create', (_e, req: { profile: TerminalProfile; cwd: string }) =>
    createAndList(() => unifiedPool.create({ command: undefined, cwd: req.cwd, profile: req.profile }), 'create', '无法启动集成终端'),
  );

  // terminal:createInAppWorkDir — 在工作目录创建
  ipcMain.handle('terminal:createInAppWorkDir', (_e, req: { profile: TerminalProfile }) =>
    createAndList(() => unifiedPool.create({ command: undefined, cwd: ensureAppWorkDir(), profile: req.profile }), 'createInAppWorkDir', '无法在应用工作目录启动集成终端'),
  );

  // terminal:input — 键盘输入
  ipcMain.on('terminal:input', (_e, m: { id: string; data: string }) => unifiedPool.write(m.id, m.data));
  // terminal:resize — 调整尺寸
  ipcMain.on('terminal:resize', (_e, m: { id: string; cols: number; rows: number }) => unifiedPool.resize(m.id, m.cols, m.rows));
  // terminal:ack — 背压回传
  ipcMain.on('terminal:ack', (_e, m: { id: string; bytes: number }) => unifiedPool.acknowledgeDataEvent(m.id, m.bytes));
  // terminal:destroy — 销毁终端
  ipcMain.handle('terminal:destroy', (_e, id: string) => { unifiedPool.destroy(id); pushTerminalList(); });
  // session:terminate — 终止 pi 会话
  ipcMain.handle('session:terminate', (_e, key: string) => { unifiedPool.terminate(key); pushTerminalList(); });

  // terminal:saveBuffer — 保存滚动缓冲区
  ipcMain.on('terminal:saveBuffer', (_e, m: { id: string; data: string }) => {
    if (m?.id && typeof m.data === 'string') terminalBuffers.set(m.id, m.data);
  });
  // terminal:loadBuffer — 加载滚动缓冲区
  ipcMain.handle('terminal:loadBuffer', (_e, id: string): string | undefined => terminalBuffers.get(id));
  // terminal:updateCwd — shell integration cwd 更新
  ipcMain.on('terminal:updateCwd', (_e, m: { id: string; cwd: string }) => {
    unifiedPool.updateCwd(m.id, m.cwd);
    pushTerminalList();
  });
}