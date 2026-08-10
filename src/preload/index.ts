import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus, AppConfig, TerminalProfile, IntegratedTerminalInfo } from '../renderer/src/types';

// 读取主进程经 webPreferences.additionalArguments 同步注入的初始 config（窗口创建时
// 即确定，无需等待异步 IPC），供渲染进程首屏零闪烁地拿到主题等初始值。
function readInitialConfig(): AppConfig | null {
  try {
    const arg = process.argv.find((a) => a.startsWith('--pi-initial-config='));
    if (!arg) return null;
    return JSON.parse(decodeURIComponent(arg.slice('--pi-initial-config='.length))) as AppConfig;
  } catch {
    return null;
  }
}
const initialConfig = readInitialConfig();

contextBridge.exposeInMainWorld('pi', {
  listSessions: (): Promise<SessionGroup[]> => ipcRenderer.invoke('session:list'),
  readSessionContent: (key: string): Promise<Array<{ role: string; content: string; toolName?: string }>> =>
    ipcRenderer.invoke('session:readContent', key),
  openSession: (req: OpenRequest): Promise<SessionInfo> =>
    ipcRenderer.invoke('terminal:spawn', { command: 'pi', cwd: req.cwd ?? '', sessionFile: req.key?.endsWith('.jsonl') ? req.key : undefined, key: req.key && !req.key.endsWith('.jsonl') ? req.key : undefined, name: req.name }),
  terminate: (key: string): Promise<void> => ipcRenderer.invoke('session:terminate', key),  // 调用 session:terminate（main 中 UnifiedTerminalPool.terminate）
  deleteSession: (key: string): Promise<void> => ipcRenderer.invoke('session:delete', key),
  deleteMany: (keys: string[]): Promise<void> => ipcRenderer.invoke('session:deleteMany', keys),
  clearDirectory: (cwd: string): Promise<void> => ipcRenderer.invoke('session:clearDirectory', cwd),
  input: (key: string, data: string) => ipcRenderer.send('terminal:input', { id: key, data }),
  resize: (key: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id: key, cols, rows }),
  debug: (): Promise<{ count: number; pids: number[] }> => ipcRenderer.invoke('session:debug'),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('session:pickDirectory'),
  // 拖拽文件落终端：把渲染端拖入的 File 解析为绝对路径。
  // Electron 31+ 起 File.path 已弃用，官方改用 webUtils.getPathForFile（同步返回绝对路径）；
  // 若该 API 因传入非原生拖拽 File 而失败，回退到 File.path（测试/旧环境注入的绝对路径）。
  getPathForFile: (file: File): string => {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    } catch {
      /* 非原生拖拽 File（如测试构造）：回退下面 */
    }
    return (file as any).path ?? '';
  },
  // 图片粘贴落盘：渲染端把剪贴板里的图片读成 base64 传来，主进程写临时文件并返回绝对路径。
  saveImage: (data: string, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('session:saveImage', { data, ext }),
  onData: (cb: (key: string, data: string) => void) => {
    const handler = (_e: unknown, m: { id: string; data: string }) => cb(m.id, m.data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onStatus: (cb: (key: string, status: SessionStatus) => void) => {
    const handler = (_e: unknown, m: { key: string; status: SessionStatus }) => cb(m.key, m.status);
    ipcRenderer.on('session:status', handler);
    return () => ipcRenderer.removeListener('session:status', handler);
  },
  onExit: (cb: (key: string) => void) => {
    const handler = (_e: unknown, m: { id: string }) => cb(m.id);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
  onRelink: (cb: (from: string, to: string) => void) => {
    const handler = (_e: unknown, m: { from: string; to: string }) => cb(m.from, m.to);
    ipcRenderer.on('session:relink', handler);
    return () => ipcRenderer.removeListener('session:relink', handler);
  },
  onIndex: (cb: (groups: SessionGroup[]) => void) => {
    const handler = (_e: unknown, groups: SessionGroup[]) => cb(groups);
    ipcRenderer.on('session:index', handler);
    return () => ipcRenderer.removeListener('session:index', handler);
  },
  // 背压回传（对齐 VS Code acknowledgeDataEvent）：渲染端每消费 N 字节即通知主进程，
  // 主进程据此对 PTY 做流控/消费进度记账。统一使用 terminal:ack 通道。
  acknowledgeDataEvent: (id: string, bytes: number) =>
    ipcRenderer.send('terminal:ack', { id, bytes }),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('window:get-bounds'),
  setWindowBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('window:set-bounds', bounds),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: unknown, m: boolean) => cb(m);
    ipcRenderer.on('window:maximize-change', handler);
    return () => ipcRenderer.removeListener('window:maximize-change', handler);
  },
  getInitialConfig: (): AppConfig | null => initialConfig,
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (partial: Partial<AppConfig>): Promise<void> => ipcRenderer.invoke('config:set', partial),
  // ── 文件管理器 / 预览（A + B）──
  fsListDir: (root: string, dir: string): Promise<any[]> => ipcRenderer.invoke('fs:listDir', { root, dir }),
  fsReadFile: (root: string, filePath: string, maxBytes?: number): Promise<any> =>
    ipcRenderer.invoke('fs:readFile', { root, path: filePath, maxBytes }),
  fsWriteFile: (root: string, filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:writeFile', { root, path: filePath, content }),
  fsStat: (root: string, filePath: string): Promise<any> =>
    ipcRenderer.invoke('fs:stat', { root, path: filePath }),
  // ── 文件管理写操作（新建 / 重命名 / 删除 / 复制 / 移动）──
  fsMkdir: (root: string, dir: string): Promise<void> =>
    ipcRenderer.invoke('fs:mkdir', { root, dir }),
  fsCreateFile: (root: string, filePath: string, content?: string): Promise<void> =>
    ipcRenderer.invoke('fs:createFile', { root, path: filePath, content }),
  fsRename: (root: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('fs:rename', { root, from, to }),
  fsRemove: (root: string, filePath: string): Promise<void> =>
    ipcRenderer.invoke('fs:remove', { root, path: filePath }),
  fsCopy: (root: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('fs:copy', { root, from, to }),
  fsListNames: (root: string, dir: string): Promise<string[]> =>
    ipcRenderer.invoke('fs:listNames', { root, dir }),
  fsUniqueName: (base: string, existing: string[]): Promise<string> =>
    ipcRenderer.invoke('fs:uniqueName', { base, existing }),
  // 目录监听（外部变更自动刷新，对齐 VS Code FileWatcher）：
  // 渲染端订阅某目录，主进程经 'fs:change' 通道推送变更；返回取消订阅函数。
  fsWatch: (root: string, dir: string, cb: () => void): (() => void) => {
    const handler = (_e: unknown, m: { dir: string }) => {
      if (m.dir === dir) cb();
    };
    ipcRenderer.send('fs:watch', { root, dir });
    ipcRenderer.on('fs:change', handler);
    // 返回的取消函数：移除监听 + 通知主进程引用计数减一。
    return () => {
      ipcRenderer.removeListener('fs:change', handler);
      ipcRenderer.send('fs:unwatch', { root, dir });
    };
  },
  // 文件监听（外部修改自动刷新编辑器）：订阅某个文件，文件变更时回调；返回取消订阅函数。
  fsWatchFile: (root: string, path: string, cb: () => void): (() => void) => {
    const handler = (_e: unknown, m: { root: string; path: string }) => {
      if (m.root === root && m.path === path) cb();
    };
    ipcRenderer.send('fs:watchFile', { root, path });
    ipcRenderer.on('fs:fileChange', handler);
    return () => {
      ipcRenderer.removeListener('fs:fileChange', handler);
      ipcRenderer.send('fs:unwatchFile', { root, path });
    };
  },
  // ── Git 查看（D）──
  gitStatus: (cwd: string): Promise<any> => ipcRenderer.invoke('git:status', { cwd }),
  gitLog: (cwd: string, limit?: number): Promise<any[]> => ipcRenderer.invoke('git:log', { cwd, limit }),
  gitDiff: (cwd: string, ref?: string): Promise<string> => ipcRenderer.invoke('git:diff', { cwd, ref }),
gitFileDiff: (cwd: string, path: string): Promise<string> => ipcRenderer.invoke('git:fileDiff', { cwd, path }),
gitCommitFiles: (cwd: string, hash: string): Promise<{ status: string; path: string; oldPath?: string }[]> => ipcRenderer.invoke('git:commitFiles', { cwd, hash }),
gitCommitFileDiff: (cwd: string, hash: string, path: string): Promise<{ original: string; modified: string }> => ipcRenderer.invoke('git:commitFileDiff', { cwd, hash, path }),
  gitFileStatusMap: (cwd: string): Promise<Record<string, any>> => ipcRenderer.invoke('git:fileStatusMap', { cwd }),
  gitIgnoredPaths: (cwd: string): Promise<string[]> => ipcRenderer.invoke('git:ignoredPaths', { cwd }),

  // ── Git 写操作 ──
  gitStage: (cwd: string, paths?: string[], all?: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:stage', { cwd, paths, all }),
  gitUnstage: (cwd: string, paths?: string[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:unstage', { cwd, paths }),
  gitCommit: (cwd: string, message: string, opts?: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:commit', { cwd, message, opts }),
  gitRevert: (cwd: string, paths: string[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:revert', { cwd, paths }),
  gitClean: (cwd: string, paths?: string[], all?: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:clean', { cwd, paths, all }),

  // ── 分支 ──
  gitCurrentBranch: (cwd: string): Promise<string | null> => ipcRenderer.invoke('git:currentBranch', { cwd }),
  gitBranches: (cwd: string): Promise<any[]> => ipcRenderer.invoke('git:branches', { cwd }),
  gitCreateBranch: (cwd: string, name: string, from?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:createBranch', { cwd, name, from }),
  gitCheckout: (cwd: string, ref: string, create?: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:checkout', { cwd, ref, create }),
  gitDeleteBranch: (cwd: string, name: string, force?: boolean): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:deleteBranch', { cwd, name, force }),
  gitRenameBranch: (cwd: string, newName: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:renameBranch', { cwd, newName }),

  // ── 远程同步 ──
  gitRemotes: (cwd: string): Promise<any[]> => ipcRenderer.invoke('git:remotes', { cwd }),
  gitAddRemote: (cwd: string, name: string, url: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:addRemote', { cwd, name, url }),
  gitRemoveRemote: (cwd: string, name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:removeRemote', { cwd, name }),
  gitFetch: (cwd: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:fetch', { cwd }),
  gitPull: (cwd: string, opts?: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:pull', { cwd, opts }),
  gitPush: (cwd: string, opts?: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:push', { cwd, opts }),
  gitSync: (cwd: string, opts?: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:sync', { cwd, opts }),
  gitLogAdvanced: (cwd: string, query?: any): Promise<any[]> =>
    ipcRenderer.invoke('git:logAdvanced', { cwd, query }),
  // 操作状态事件：
  onGitOperation: (cb: (payload: { cwd: string; kind: string; running: boolean }) => void) => {
    const handler = (_e: unknown, m: { cwd: string; kind: string; running: boolean }) => cb(m);
    ipcRenderer.on('git:operation', handler);
    return () => ipcRenderer.removeListener('git:operation', handler);
  },
  // 高级日志：
  gitSearchLog: (cwd: string, query?: any): Promise<any[]> => ipcRenderer.invoke('git:logAdvanced', { cwd, query }),
  gitLogPage: (cwd: string, opts?: any): Promise<any[]> => ipcRenderer.invoke('git:logAdvanced', { cwd, query: opts }),
  // 工作区实时监听：订阅某仓库 cwd，主进程经 'git:change' 推送变更；返回取消订阅函数。
  gitWatch: (cwd: string, cb: () => void): (() => void) => {
    const handler = (_e: unknown, m: { cwd: string }) => {
      if (m.cwd === cwd) cb();
    };
    ipcRenderer.send('git:watch', { cwd });
    ipcRenderer.on('git:change', handler);
    return () => {
      ipcRenderer.removeListener('git:change', handler);
      ipcRenderer.send('git:unwatch', { cwd });
    };
  },
  // 启动动画：renderer 首屏就绪后通知主进程显示窗口并淡出 splash（见 docs/adr/0003）。
  splashDone: () => ipcRenderer.send('splash:done'),
  // 受控外部链接通道：请求主进程用系统默认程序打开 URL（浏览器/mail 客户端）。
  // 协议白名单（http(s)/mailto）在主进程集中校验，file:// 不走此通道。
  // 注意：终端链接使用 window.open 方式（保留手势），不走此 IPC 通道。
  // 此通道供 Markdown 预览等组件使用（非手势上下文，用 shell.openExternal 直接打开）。
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('app:openExternal', url),
  // 用系统默认程序打开本地文件（二进制/无内置预览器的文件），等效双击文件。
  fsOpenWithSystem: (absPath: string): Promise<boolean> => ipcRenderer.invoke('fs:openWithSystem', absPath),
  // 在系统文件管理器中打开文件/目录所在位置并选中。
  fsShowInFolder: (absPath: string): Promise<boolean> => ipcRenderer.invoke('fs:showInFolder', absPath),
  // ── 集成终端（真实 shell）──
  spawnTerminal: (req: { command?: string; cwd: string; profile?: any; sessionFile?: string; name?: string; key?: string }) =>
    ipcRenderer.invoke('terminal:spawn', req),
  listTerminalProfiles: (): Promise<TerminalProfile[]> => ipcRenderer.invoke('terminal:listProfiles'),
  createTerminal: (req: { profile: TerminalProfile; cwd: string }): Promise<IntegratedTerminalInfo> => ipcRenderer.invoke('terminal:create', req),
  createTerminalInAppWorkDir: (req: { profile: TerminalProfile }): Promise<IntegratedTerminalInfo> => ipcRenderer.invoke('terminal:createInAppWorkDir', req),
  listIntegratedTerminals: (): Promise<IntegratedTerminalInfo[]> => ipcRenderer.invoke('terminal:list'),
  destroyTerminal: (id: string): Promise<void> => ipcRenderer.invoke('terminal:destroy', id),
  terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
  terminalResize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  onTerminalData: (cb: (id: string, data: string) => void) => {
    const handler = (_e: unknown, m: { id: string; data: string }) => cb(m.id, m.data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  onTerminalExit: (cb: (id: string) => void) => {
    const handler = (_e: unknown, m: { id: string }) => cb(m.id);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
  saveTerminalBuffer: (id: string, data: string) => ipcRenderer.send('terminal:saveBuffer', { id, data }),
  loadTerminalBuffer: (id: string): Promise<string | undefined> => ipcRenderer.invoke('terminal:loadBuffer', id),
  updateTerminalCwd: (id: string, cwd: string) => ipcRenderer.send('terminal:updateCwd', { id, cwd }),
  onTerminalList: (cb: (list: IntegratedTerminalInfo[]) => void) => {
    const handler = (_e: unknown, m: { list: IntegratedTerminalInfo[] }) => cb(m.list);
    ipcRenderer.on('terminal:list', handler);
    return () => ipcRenderer.removeListener('terminal:list', handler);
  },
  // pi 进程内部执行 /new 时主进程推送的通知
  onNewFromPi: (cb: (payload: { ptyId: string; uuid: string; cwd: string; name: string }) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('session:new-from-pi', handler);
    return () => ipcRenderer.removeListener('session:new-from-pi', handler);
  },
  // 会话名变更通知（/name 命令触发）
  onSessionNameChanged: (cb: (payload: { ptyId: string; name: string }) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('session:name-changed', handler);
    return () => ipcRenderer.removeListener('session:name-changed', handler);
  },
  // 注册 PTY 初始 owner（渲染进程通知主进程）
  registerPtyOwner: (ptyId: string, ownerKey: string) => {
    ipcRenderer.send('session:register-pty-owner', { ptyId, ownerKey });
  },
  // 查询 PTY 所有权（供 renderer 端替换 ptyOwnersRef 和 _virtualToPty）
  queryPtyOwner: (key: string): Promise<{ owner?: string; ptyId?: string; virtual?: string }> =>
    ipcRenderer.invoke('session:query-owner', key),

  // ╌╌ pi-tool 集成：Pi 配置、模型、MCP、Skills、扩展 ╌╌
  piSettingsGet: (scope: 'global' | 'project'): Promise<{ data: unknown; raw: string; path: string; exists: boolean }> =>
    ipcRenderer.invoke('pi:settings:get', scope),
  piSettingsSet: (payload: { scope: 'global' | 'project'; data?: Record<string, unknown>; raw?: string }): Promise<{ success: boolean; path: string }> =>
    ipcRenderer.invoke('pi:settings:set', payload),
  piModelsGet: (): Promise<{ providers: Record<string, unknown> }> =>
    ipcRenderer.invoke('pi:models:get'),
  piModelsSet: (data: unknown): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('pi:models:set', data),
  piMcpConfigs: (): Promise<Array<{ id: string; label: string; path: string; exists: boolean; config: unknown }>> =>
    ipcRenderer.invoke('pi:mcp:configs'),
  piMcpConfigsSave: (payload: { id: string; config: unknown }): Promise<{ success: boolean; path: string }> =>
    ipcRenderer.invoke('pi:mcp:configs:save', payload),
  piMcpStatus: (): Promise<{ installed: boolean; version?: string }> =>
    ipcRenderer.invoke('pi:mcp:status'),
  piSkillsList: (): Promise<{ skills: Array<{ name: string; disabled: boolean; description?: string; source: string | null; sourceUrl: string | null; sourceType: string | null }> }> =>
    ipcRenderer.invoke('pi:skills:list'),
  piSkillsDisable: (payload: { name: string; source?: string | null }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:skills:disable', payload),
  piSkillsEnable: (name: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:skills:enable', name),
  piSkillsDelete: (payload: { name: string; disabled?: boolean }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:skills:delete', payload),
  piSkillsBatchDisable: (payload: { names: string[]; source?: string | null }): Promise<{ results: Array<{ name: string; success: boolean; error?: string }> }> =>
    ipcRenderer.invoke('pi:skills:batchDisable', payload),
  piSkillsBatchDelete: (payload: { names: string[] }): Promise<{ results: Array<{ name: string; success: boolean; error?: string }> }> =>
    ipcRenderer.invoke('pi:skills:batchDelete', payload),
  piSkillsRefreshCache: (): Promise<{ skills: Array<{ name: string; disabled: boolean; description?: string; source: string | null; sourceUrl: string | null; sourceType: string | null }> }> =>
    ipcRenderer.invoke('pi:skills:refreshCache'),
  piExtensionsList: (): Promise<{ extensions: Array<{ name: string; type: string; source: string; disabled: boolean; managed: boolean; dir?: string }> }> =>
    ipcRenderer.invoke('pi:extensions:list'),
  piExtensionsDisable: (payload: { name: string; type: string; source: string; dir?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:extensions:disable', payload),
  piExtensionsEnable: (payload: { name: string; type: string; source: string; dir?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:extensions:enable', payload),
  piExtensionsDelete: (payload: { name: string; type: string; source: string; dir?: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:extensions:delete', payload),
  // 版本更新检查
  checkUpdate: (): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    hasUpdate: boolean;
    releaseUrl: string | null;
    releaseName: string | null;
    releaseBody: string | null;
    checkedAt: string | null;
    error: string | null;
  }> => ipcRenderer.invoke('update:check'),
  getUpdateStatus: (): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    hasUpdate: boolean;
    releaseUrl: string | null;
    releaseName: string | null;
    releaseBody: string | null;
    checkedAt: string | null;
    error: string | null;
    assets: Array<{ name: string; url: string; size: number }>;
  } | null> => ipcRenderer.invoke('update:get-status'),
  getCurrentVersion: (): Promise<string> => ipcRenderer.invoke('update:get-current-version'),
  // 下载更新
  downloadUpdate: (): Promise<{ success: boolean; filePath: string }> =>
    ipcRenderer.invoke('update:download'),
  // 取消下载
  cancelDownload: () => ipcRenderer.send('update:cancel-download'),
  // 安装更新
  installUpdate: (filePath: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('update:install', filePath),
  // 监听下载进度
  onDownloadProgress: (cb: (progress: {
    status: 'downloading' | 'completed' | 'error' | 'cancelled';
    percent: number;
    downloadedBytes: number;
    totalBytes: number;
    filePath?: string;
    error?: string;
  }) => void) => {
    const handler = (_e: unknown, progress: any) => cb(progress);
    ipcRenderer.on('update:download-progress', handler);
    return () => ipcRenderer.removeListener('update:download-progress', handler);
  },
});
