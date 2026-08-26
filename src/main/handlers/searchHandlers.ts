// ─────────────────────────────────────────────────────────────────────────────
// 全局搜索 IPC handler。
//
// 通道：
//   search:run   (invoke) → 启动一次搜索，返回 searchId；结果经下列事件增量推送
//   search:result   (send) → { id, file }  某文件全部匹配
//   search:progress (send) → { id, matches, files }
//   search:done     (send) → { id, summary } 搜索结束（含 cancel / 全局限流 / 正常完成）
//   search:error    (send) → { id, message }
//   search:cancel   (send) → { id } 取消在途搜索
//
// 幂等：searchEngine 可能在 summary/exit/cancel 多处调 onDone，用 active.delete(id)
// 的返回值（首次 true）守卫，确保 done/error 只推送一次。
// ─────────────────────────────────────────────────────────────────────────────

import type { IpcMain, BrowserWindow } from 'electron';
import {
  runSearch,
  type SearchOptions,
  type SearchSummary,
  type SearchFileResult,
} from '../search/searchEngine';

let nextId = 1;
/** 在途搜索：searchId → cancel 句柄。 */
const active = new Map<number, () => void>();

export function registerSearchHandlers(ipcMain: IpcMain, win: BrowserWindow): void {
  const send = (channel: string, payload: unknown): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  ipcMain.handle(
    'search:run',
    (_e, req: { root: string; query: string; options: SearchOptions }) => {
      const id = nextId++;
      const { cancel } = runSearch(
        { root: req.root, query: req.query, options: req.options },
        {
          onFileResult: (file: SearchFileResult) => send('search:result', { id, file }),
          onProgress: (stats) => send('search:progress', { id, ...stats }),
          onDone: (summary?: SearchSummary) => {
            // 首次（active 仍持有 id）才推送 done 并清理；后续重复 onDone 忽略
            if (active.delete(id)) send('search:done', { id, summary: summary ?? null });
          },
          onError: (message: string) => {
            if (active.delete(id)) send('search:error', { id, message });
          },
        },
      );
      active.set(id, cancel);
      return id;
    },
  );

  ipcMain.on('search:cancel', (_e, id: number) => {
    const cancel = active.get(id);
    if (cancel) {
      active.delete(id);
      cancel();
    }
  });
}
