import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { pi } from '../ipc';
import { useTabStore } from '../store/tabStore';
import {
  acquirePane,
  mountPane,
  setPaneActive,
  schedulePaneResize,
  setPaneScrollHandler,
  scrollPaneToBottom,
  paneHandleContextMenu,
  releasePane,
  focusPane,
} from './paneManager';
import type { XtermTerminal } from './XtermTerminal';
import {
  scheduleFollowOutputIfNeeded,
  rememberVisibleScrollSnapshot,
} from '../lib/terminal/scroll-visibility-memory';

interface Props {
  sessionKey: string;
  active: boolean;
}

// 会话终端壳（替代原 TerminalPane）：仅负责生命周期宿主（active 时挂载 XtermTerminal、非 active
// 时隐藏）、提供 host div、转发右键菜单与置底按钮。所有 keep-alive / resize / 缓冲 / 度量逻辑收编
// 进 PaneManager + XtermTerminal（见 docs/adr/0002）。对外契约（props、DOM class / data-*、行为语义）
// 与原 TerminalPane 完全一致，对 App.tsx / 主进程 / preload 完全透明。
export function SessionPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    paneHandleContextMenu(sessionKey, e);
  }, [sessionKey]);

  const handleJumpBottom = useCallback(() => {
    scrollPaneToBottom(sessionKey);
  }, [sessionKey]);

  // 创建终端实例一次（keep-alive）：经 PaneManager.acquirePane 取/建实例，跨 active 切换保留
  // （对齐 VS Code setVisible 不析构语义）。非 active 时只隐藏 host，实例本身不销毁。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = acquirePane({ key: sessionKey, kind: 'session', pi });
    termRef.current = term;
    // 视口贴底状态变化 → 驱动浮钮显隐（仅在状态翻转时回调，见 XtermTerminal.notifyScrollState）。
    setPaneScrollHandler(sessionKey, (bottom) => setAtBottom(bottom));
    // 文件链接点击 → 在 pi-desktop 编辑器中打开（通过 tabStore.openPreview）。
    term.onOpenFile = (path, line, col) => {
      const fileName = path.split(/[\\/]/).filter(Boolean).pop() || path;
      useTabStore.getState().openPreview('', path, fileName);
    };
    // 终端标题变化（OSC 0 序列，pi 扩展的 spinner 标题帧）：同步更新 tab 标题。
    // 标题更新是渲染端纯本地状态（splitStore），直接调 store action，无需 IPC 往返。
    term.onTitleChange = (title) => {
      useTabStore.getState().updateTabTitle(sessionKey, title);
    };
    // 仅当当前就是 active 才立即 open；非 active 时实例已建但等待 setActive(true) 时 open。
    if (active) mountPane(sessionKey, host);
    return () => {
      // 统一经 PaneManager.releasePane 销毁并注销实例（会话 pty 由主进程会话生命周期管理，此处不杀）。
      releasePane(sessionKey);
      termRef.current = null;
    };
  }, [sessionKey]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  // 关键：切回可见时显式调 setPaneActive(true) 而非仅 mount——mount 对"已挂载实例"是 no-op
  // （if mounted return），不会触发 resize；但 opacity:0 隐藏期间 xterm 尺寸为 0，
  // 切回后必须 flush + doResize 用真实容器尺寸重测，否则沿用隐藏期的 0 尺寸渲染，
  // 表现为"切回的终端变空白新终端、历史输出丢失 / 不能滚动"。
  // 滚动位置保存/恢复：隐藏前保存快照，恢复时调度 followOutput 检查。
  //
  // 注意：不再调用 setPaneActive(false) 来取消激活终端。隐藏期由父容器 .tab-content
  // 的 opacity:0 控制（非 .terminal-host 的 display:none），IntersectionObserver 不会
  // 暂停 RenderService，WebGL 上下文不丢失，切换 tab 时终端内容立即可见——对齐 VS Code
  // 的「terminal 始终在 DOM 中 display:block，切换仅改变 CSS 可见性」策略。
  useEffect(() => {
    if (active) {
      mountPane(sessionKey, hostRef.current!); // 幂等：已挂载则直接 return
      setPaneActive(sessionKey, true);         // 切回：flush + 强制 resize 校准尺寸
      // 焦点交给终端：首次激活时 xterm 尚未 mount（SplitPane 点击 tab 时 focusPane 为空操作），
      // 这里在 mount 后补聚焦；已激活 tab 被再次点击时由 SplitPane.handleSelectTab 负责。
      focusPane(sessionKey);
      // 调度 followOutput 检查：如果隐藏期间有新输出且意图是 followOutput，scrollToBottom
      scheduleFollowOutputIfNeeded(sessionKey);
    } else {
      // 隐藏前保存当前滚动快照，供恢复时判断是否需要 followOutput
      // 不调用 setPaneActive(false)：终端始终 active（RenderService 不暂停），
      // 仅 CSS 隐藏（opacity:0），保证 WebGL canvas 上下文不被销毁。
      const term = termRef.current;
      if (term?.rawTerminal) {
        rememberVisibleScrollSnapshot(sessionKey, term.rawTerminal);
      }
    }
  }, [active, sessionKey]);

  // 尺寸变化：交给 PaneManager → XtermTerminal 执行 refit。
  // 对齐 Orca：ResizeObserver 150ms 防抖，避免连续 resize 时频繁触发整屏重排。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timerId !== null) clearTimeout(timerId);
      timerId = setTimeout(() => {
        timerId = null;
        schedulePaneResize(sessionKey);
      }, 150);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [sessionKey]);

  return (
    <>
      <div
        ref={hostRef}
        data-session={sessionKey}
        className={active ? 'terminal-host active' : 'terminal-host'}
        onContextMenu={handleContextMenu}
      />
      {/* 「跳到底部」浮钮：仅在视口上滚离底、且当前面板为 active 时显示（见 XtermTerminal.onScrollState）。
          点击调用 term.scrollToBottom() 回到最新输出。不参与非 active 面板的滚动态。 */}
      {active && !atBottom && (
        <button
          type="button"
          className="jump-bottom visible"
          title="跳到底部"
          aria-label="跳到底部"
          onClick={handleJumpBottom}
        >
          ↓
        </button>
      )}
    </>
  );
}
