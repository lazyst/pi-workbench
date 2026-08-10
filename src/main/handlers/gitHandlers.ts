import * as fs from 'node:fs';
import { ReferenceCountedWatcher } from '../shared/ReferenceCountedWatcher';
import {
  gitStatus, gitLog, gitDiff, gitFileDiff, gitFileStatusMap, gitIgnoredPaths,
  gitStage, gitUnstage, gitCommit, gitRevert, gitClean,
  gitCurrentBranch, gitBranches, gitCreateBranch, gitCheckout, gitDeleteBranch, gitRenameBranch,
  gitRemotes, gitAddRemote, gitRemoveRemote,
  gitFetch, gitPull, gitPush, gitSync,
  gitLogAdvanced,
  type GitCommitOptions, type GitSyncOptions,
} from '../gitBridge';
import { getOperationManager, OperationKind } from '../operationManager';

/**
 * Git 相关 IPC handler 注册。
 *
 * 包含 git:* 系列 handler 以及工作区实时监听。
 */
export function registerGitHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
): void {
  // ── Git 只读查看 ──
  const gitCooldownUntil = new Map<string, number>();

  ipcMain.handle('git:status', async (_e, req: { cwd: string }) => {
    gitCooldownUntil.set(req.cwd, Date.now() + 2000);
    try {
      return await gitStatus(req.cwd);
    } finally {
      // 命令完成后保持冷却，避免 Windows fs.watch 延迟事件触发循环
    }
  });
  ipcMain.handle('git:log', (_e, req: { cwd: string; limit?: number }) => gitLog(req.cwd, req.limit));
  ipcMain.handle('git:diff', (_e, req: { cwd: string; ref?: string }) => gitDiff(req.cwd, req.ref));
  ipcMain.handle('git:fileDiff', (_e, req: { cwd: string; path: string }) => gitFileDiff(req.cwd, req.path));
  ipcMain.handle('git:fileStatusMap', async (_e, req: { cwd: string }) => {
    gitCooldownUntil.set(req.cwd, Date.now() + 2000);
    try {
      return await gitFileStatusMap(req.cwd);
    } finally {
      // 命令完成后保持冷却
    }
  });
  ipcMain.handle('git:ignoredPaths', async (_e, req: { cwd: string }) => {
    return await gitIgnoredPaths(req.cwd);
  });
  ipcMain.handle('git:logAdvanced', async (_e, req: { cwd: string; query?: any }) => {
    return await gitLogAdvanced(req.cwd, req.query ?? {});
  });

  // ── Git 写操作 ──
  // 每个写操作经过 OperationManager 管理，防止并发冲突并通知渲染进程操作状态。
  // 操作执行前发送 git:operation 事件（{ cwd, kind, running: true }），完成后发送 running: false。

  /** 包装写操作：通过 OperationManager 管理并发，发送操作状态事件。 */
  async function runWriteOp<T>(
    cwd: string,
    kind: OperationKind,
    fn: () => Promise<{ success: boolean; error?: string }>,
  ): Promise<{ success: boolean; error?: string }> {
    const ops = getOperationManager(cwd);
    const op = ops.start(kind);
    if (!win.isDestroyed()) win.webContents.send('git:operation', { cwd, kind, running: true });
    try {
      return await fn();
    } finally {
      ops.end(op);
      if (!win.isDestroyed()) win.webContents.send('git:operation', { cwd, kind, running: false });
    }
  }

  ipcMain.handle('git:stage', async (_e, req: { cwd: string; paths?: string[]; all?: boolean }) => {
    const ops = getOperationManager(req.cwd);
    // 如果正在执行 blocking 操作，跳过
    if (ops.shouldDisableCommands()) return { success: false, error: 'Operation in progress' };
    return runWriteOp(req.cwd, OperationKind.Stage, () => gitStage(req.cwd, req.paths, req.all));
  });

  ipcMain.handle('git:unstage', async (_e, req: { cwd: string; paths?: string[] }) => {
    const ops = getOperationManager(req.cwd);
    if (ops.shouldDisableCommands()) return { success: false, error: 'Operation in progress' };
    return runWriteOp(req.cwd, OperationKind.Unstage, () => gitUnstage(req.cwd, req.paths));
  });

  ipcMain.handle('git:commit', async (_e, req: { cwd: string; message: string; opts?: GitCommitOptions }) => {
    return runWriteOp(req.cwd, OperationKind.Commit, () => gitCommit(req.cwd, req.message, req.opts));
  });

  ipcMain.handle('git:revert', async (_e, req: { cwd: string; paths: string[] }) => {
    return runWriteOp(req.cwd, OperationKind.Revert, () => gitRevert(req.cwd, req.paths));
  });

  ipcMain.handle('git:clean', async (_e, req: { cwd: string; paths?: string[]; all?: boolean }) => {
    return runWriteOp(req.cwd, OperationKind.Clean, () => gitClean(req.cwd, req.paths, req.all));
  });

  // ── 分支 ──
  ipcMain.handle('git:currentBranch', async (_e, req: { cwd: string }) => {
    return await gitCurrentBranch(req.cwd);
  });
  ipcMain.handle('git:branches', async (_e, req: { cwd: string }) => {
    return await gitBranches(req.cwd);
  });
  ipcMain.handle('git:createBranch', async (_e, req: { cwd: string; name: string; from?: string }) => {
    return runWriteOp(req.cwd, OperationKind.Branch, () => gitCreateBranch(req.cwd, req.name, req.from));
  });
  ipcMain.handle('git:checkout', async (_e, req: { cwd: string; ref: string; create?: boolean }) => {
    return runWriteOp(req.cwd, OperationKind.Checkout, () => gitCheckout(req.cwd, req.ref, req.create));
  });
  ipcMain.handle('git:deleteBranch', async (_e, req: { cwd: string; name: string; force?: boolean }) => {
    return runWriteOp(req.cwd, OperationKind.DeleteBranch, () => gitDeleteBranch(req.cwd, req.name, req.force));
  });
  ipcMain.handle('git:renameBranch', async (_e, req: { cwd: string; newName: string }) => {
    return runWriteOp(req.cwd, OperationKind.RenameBranch, () => gitRenameBranch(req.cwd, req.newName));
  });

  // ── 远程同步 ──
  ipcMain.handle('git:remotes', async (_e, req: { cwd: string }) => {
    return await gitRemotes(req.cwd);
  });
  ipcMain.handle('git:addRemote', async (_e, req: { cwd: string; name: string; url: string }) => {
    return runWriteOp(req.cwd, OperationKind.Remote, () => gitAddRemote(req.cwd, req.name, req.url));
  });
  ipcMain.handle('git:removeRemote', async (_e, req: { cwd: string; name: string }) => {
    return runWriteOp(req.cwd, OperationKind.Remote, () => gitRemoveRemote(req.cwd, req.name));
  });
  ipcMain.handle('git:fetch', async (_e, req: { cwd: string }) => {
    return runWriteOp(req.cwd, OperationKind.Fetch, () => gitFetch(req.cwd));
  });
  ipcMain.handle('git:pull', async (_e, req: { cwd: string; opts?: GitSyncOptions }) => {
    return runWriteOp(req.cwd, OperationKind.Pull, () => gitPull(req.cwd, req.opts));
  });
  ipcMain.handle('git:push', async (_e, req: { cwd: string; opts?: GitSyncOptions }) => {
    return runWriteOp(req.cwd, OperationKind.Push, () => gitPush(req.cwd, req.opts));
  });
  ipcMain.handle('git:sync', async (_e, req: { cwd: string; opts?: GitSyncOptions }) => {
    return runWriteOp(req.cwd, OperationKind.Sync, () => gitSync(req.cwd, req.opts));
  });

  // ── Git 工作区实时监听（事件驱动刷新）──
  const gitWatchers = new ReferenceCountedWatcher<string>();
  ipcMain.on('git:watch', (_e, req: { cwd: string }) => {
    const cwd = req.cwd;
    gitWatchers.watch(cwd, (key) => {
      let watcher: fs.FSWatcher | undefined;
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        try { watcher?.close(); } catch { /* 已关闭，忽略 */ }
      };
      try {
        watcher = fs.watch(key, { recursive: true }, () => {
          // 跳过 git 命令自身触发的 .git/ 变更，避免无限循环
          if (Date.now() < (gitCooldownUntil.get(key) ?? 0)) return;
          if (!win.isDestroyed()) win.webContents.send('git:change', { cwd: key });
        });
        watcher.on('error', () => stop());
      } catch {
        return () => {};
      }
      return stop;
    });
  });
  ipcMain.on('git:unwatch', (_e, req: { cwd: string }) => {
    gitWatchers.unwatch(req.cwd);
  });
}