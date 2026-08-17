// 中间区容器（按工作目录分组 + 分屏支持）
//
// 根据 store.activeCwd 只显示当前工作目录的分屏树。
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），
// 非活跃 cwd 用 opacity:0 隐藏。

import { useRef, useMemo, useEffect, useCallback, useState } from 'react';
import { SplitPane } from './SplitPane';
import { useSplitStore, getTabCwd, cwdVisibleTabs } from '../store/splitStore';
import type { Tab, SessionContentTab } from '../store/splitStore';
import { restorePaneScrollState } from './paneManager';

interface Props {
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  /** 集成终端 × 关闭：先在主进程杀 PTY，再移除 tab。 */
  onDestroyTerminal?: (id: string) => void;
  /** session tab × 关闭：终止进程后再移除 tab。 */
  onDestroySession?: (id: string) => void;
  /** 已添加到左侧栏的工作目录列表（供下拉切换）。 */
  addedDirs?: string[];
  /** 新建会话（来自空状态按钮）。 */
  onOpen?: (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => void;
  /** 新建终端（默认 profile） */
  onNewTerminal?: () => void;
  /** 新建终端（指定 profile） */
  onNewTerminalWithProfile?: (profileId: string) => void;
  /** 可用终端 profile 列表 */
  terminalProfiles?: Array<{ id: string; label: string }>;
  /** 分屏回调 */
  onSplitPane?: (leafId: string, direction: 'horizontal' | 'vertical') => void;
  /** 删除会话文件（直接删除，不弹确认框） */
  onDeleteSession?: (key: string, name: string) => void;
  /** 删除会话文件（带确认弹窗，确认后关闭对应 tab） */
  onDeleteSessionRequest?: (key: string, name: string, tabId: string) => void;
}

export function CenterPane({ onOpenFile, onDestroyTerminal, onDestroySession, addedDirs, onOpen, onNewTerminal, onNewTerminalWithProfile, terminalProfiles, onSplitPane, onDeleteSession, onDeleteSessionRequest }: Props) {
  const cwdTrees = useSplitStore((s) => s.cwdTrees);
  const activeCwd = useSplitStore((s) => s.activeCwd);
  const cwdOrder = useSplitStore((s) => s.cwdOrder);
  const setActiveCwd = useSplitStore((s) => s.setActiveCwd);
  const closeCenterTab = useSplitStore((s) => s.closeCenterTab);
  const [cwdDropdownOpen, setCwdDropdownOpen] = useState(false);
  const cwdDropdownRef = useRef<HTMLDivElement>(null);

  // 各 tab 关闭请求拦截器（如 PreviewTab 的 dirty 确认）。
  const closeGuards = useRef<Map<string, () => void>>(new Map());

  const requestCloseTab = useCallback((id: string) => {
    const guard = closeGuards.current.get(id);
    if (guard) guard();
    else if (onDestroyTerminal) {
      // 在所有 cwd 树的 leaf 中查找 tab
      let tab: Tab | undefined;
      for (const [, tree] of Object.entries(cwdTrees)) {
        const findTab = (node: any): void => {
          if (node.type === 'leaf') {
            tab = node.tabs.find((t: Tab) => t.id === id);
          } else {
            for (const child of node.children) findTab(child);
          }
        };
        findTab(tree);
        if (tab) break;
      }
      if (tab?.kind === 'integrated-terminal') {
        onDestroyTerminal(id);
      } else if (tab?.kind === 'session' && onDestroySession) {
        onDestroySession(id);
      } else {
        closeCenterTab(id);
      }
    } else {
      closeCenterTab(id);
    }
  }, [closeCenterTab, closeGuards, onDestroyTerminal, onDestroySession, cwdTrees]);

  const registerCloseGuard = useCallback((id: string, guard: (() => void) | null) => {
    if (guard) closeGuards.current.set(id, guard);
    else closeGuards.current.delete(id);
  }, []);

  // 目录 → 可见 tab 数量映射（供 cwd-select 下拉显示）
  const cwdTabCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of addedDirs ?? []) {
      const tree = cwdTrees[c];
      if (!tree) { counts.set(c, 0); continue; }
      let count = 0;
      const traverse = (node: any): void => {
        if (node.type === 'leaf') {
          count += node.tabs.filter((t: Tab) => !t.hidden).length;
        } else {
          for (const child of node.children) traverse(child);
        }
      };
      traverse(tree);
      counts.set(c, count);
    }
    return counts;
  }, [cwdTrees, addedDirs]);

  // 点击外部关闭下拉框
  useEffect(() => {
    if (!cwdDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (cwdDropdownRef.current && !cwdDropdownRef.current.contains(e.target as Node)) {
        setCwdDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [cwdDropdownOpen]);

  // 恢复 pane 滚动位置（activeCwd 变化时）
  useEffect(() => {
    if (!activeCwd) return;
    const tree = cwdTrees[activeCwd];
    if (!tree) return;
    const traverse = (node: any): void => {
      if (node.type === 'leaf') {
        for (const t of node.tabs) {
          if (t.kind !== 'session' && t.kind !== 'integrated-terminal' && t.kind !== 'session-content') continue;
          restorePaneScrollState(t.id);
        }
      } else {
        for (const child of node.children) traverse(child);
      }
    };
    traverse(tree);
  }, [activeCwd, cwdTrees]);

  return (
    <div className="center-pane">
      {/* 目录标签：下拉菜单切换工作区 */}
      <div className="center-pane-cwd-bar">
        <div className="cwd-select-wrapper" ref={cwdDropdownRef}>
          <button
            className="cwd-select"
            onClick={() => setCwdDropdownOpen(!cwdDropdownOpen)}
          >
            {activeCwd
              ? (() => {
                  const name = activeCwd.split(/[\\/]/).pop() || activeCwd;
                  const count = cwdTabCounts.get(activeCwd) ?? 0;
                  return <>{name}{count > 0 && <span className="cwd-tab-count"> ({count})</span>}</>;
                })()
              : '选择工作目录'}
          </button>
          {cwdDropdownOpen && (
            <div className="cwd-dropdown">
              {addedDirs?.map((c) => {
                const name = c.split(/[\\/]/).pop() || c;
                const count = cwdTabCounts.get(c) ?? 0;
                const isActive = c === activeCwd;
                return (
                  <div
                    key={c}
                    className={`cwd-dropdown-item${isActive ? ' active' : ''}`}
                    onClick={() => {
                      setActiveCwd(c);
                      setCwdDropdownOpen(false);
                    }}
                  >
                    {name}
                    {count > 0 && <span className="cwd-tab-count"> ({count})</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 分屏树渲染：所有 cwd 同时存在于 DOM 中，非活跃的用 opacity:0 隐藏 */}
      <div className="center-pane-split-container" style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        {Object.entries(cwdTrees).map(([cwd, tree]) => (
          <SplitPane
            key={cwd}
            tree={tree}
            cwd={cwd}
            isActive={cwd === activeCwd}
            onOpenFile={onOpenFile}
            onDestroyTerminal={onDestroyTerminal}
            onDestroySession={onDestroySession}
            onOpen={onOpen}
            onNewTerminal={onNewTerminal}
            onNewTerminalWithProfile={onNewTerminalWithProfile}
            terminalProfiles={terminalProfiles}
            closeGuards={closeGuards}
            requestCloseTab={requestCloseTab}
            registerCloseGuard={registerCloseGuard}
            addedDirs={addedDirs}
            onSplitPane={onSplitPane}
            onDeleteSession={onDeleteSession}
            onDeleteSessionRequest={onDeleteSessionRequest}
          />
        ))}
      </div>
    </div>
  );
}