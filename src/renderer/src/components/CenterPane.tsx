// 中间区容器（按工作目录分组 + 分屏支持）
//
// 根据 store.activeCwd 只显示当前工作目录的分屏树。
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），非活跃 cwd 用 opacity:0 隐藏。
//
// 订阅细化（性能）：CenterPane 不再订阅整个 cwdTrees——否则任何一个 tab 的标题
// 变化（updateTabTitle）都会让所有 cwd 的所有 tab 内容一起 re-render（含 keep-alive
// 隐藏的 MarkdownPreview 的 ReactMarkdown 全量重渲染，详见根因报告）。改为：
//   - CenterPane 只订阅 activeCwd / cwdOrder（低频变化）
//   - 每个 cwd 由 CwdPane 独立订阅 cwdTrees[cwd]，只有该 cwd 的树变化才 re-render
//   - cwd 计数由 CwdSelect 独立订阅 cwdTrees

import { memo, useRef, useMemo, useEffect, useCallback, useState } from 'react';
import { SplitPane } from './SplitPane';
import { useSplitStore } from '../store/splitStore';
import type { SplitTree, Tab } from '../store/splitStore';
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
  const activeCwd = useSplitStore((s) => s.activeCwd);
  const cwdOrder = useSplitStore((s) => s.cwdOrder);
  const setActiveCwd = useSplitStore((s) => s.setActiveCwd);
  const closeCenterTab = useSplitStore((s) => s.closeCenterTab);

  // 各 tab 关闭请求拦截器（如 PreviewTab 的 dirty 确认）。
  const closeGuards = useRef<Map<string, () => void>>(new Map());

  const requestCloseTab = useCallback((id: string) => {
    const guard = closeGuards.current.get(id);
    if (guard) guard();
    else if (onDestroyTerminal) {
      // 用 getState() 读 cwdTrees：非订阅，避免本回调依赖 cwdTrees 而引入全树 re-render。
      const cwdTrees = useSplitStore.getState().cwdTrees;
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
  }, [closeCenterTab, closeGuards, onDestroyTerminal, onDestroySession]);

  const registerCloseGuard = useCallback((id: string, guard: (() => void) | null) => {
    if (guard) closeGuards.current.set(id, guard);
    else closeGuards.current.delete(id);
  }, []);

  // 恢复 pane 滚动位置（activeCwd 变化时）。用 getState() 读树，避免订阅 cwdTrees。
  useEffect(() => {
    if (!activeCwd) return;
    const tree = useSplitStore.getState().cwdTrees[activeCwd];
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
  }, [activeCwd]);

  return (
    <div className="center-pane">
      {/* 目录标签：下拉菜单切换工作区 */}
      <div className="center-pane-cwd-bar">
        <CwdSelect addedDirs={addedDirs ?? []} activeCwd={activeCwd} onSelect={setActiveCwd} />
      </div>

      {/* 分屏树渲染：所有 cwd 同时存在于 DOM 中，非活跃的用 opacity:0 隐藏。
          每个 cwd 由 CwdPane 独立订阅自己的 tree，互不牵连。 */}
      <div className="center-pane-split-container" style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
        {cwdOrder.map((cwd) => (
          <CwdPane
            key={cwd}
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

// 递归统计分屏树中可见（未隐藏）tab 数（供 cwd 下拉计数）。
function visibleTabCount(node: SplitTree): number {
  if (node.type === 'leaf') return node.tabs.filter((t) => !t.hidden).length;
  return node.children.reduce((n, child) => n + visibleTabCount(child), 0);
}

// cwd 选择下拉：独立订阅 cwdTrees 计算各 cwd 的可见 tab 数，避免 CenterPane 被
// 高频 store 变化拖累 re-render。open state 与 dropdown ref 都内聚在本组件内。
function CwdSelect({ addedDirs, activeCwd, onSelect }: {
  addedDirs: string[];
  activeCwd: string | null;
  onSelect: (cwd: string) => void;
}) {
  const cwdTrees = useSplitStore((s) => s.cwdTrees);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of addedDirs) m.set(c, cwdTrees[c] ? visibleTabCount(cwdTrees[c]) : 0);
    return m;
  }, [cwdTrees, addedDirs]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // 按钮与下拉项共用同一标签渲染（cwd 名 + 可选 tab 计数）。
  const cwdLabel = (cwd: string) => {
    const name = cwd.split(/[\\/]/).pop() || cwd;
    const count = counts.get(cwd) ?? 0;
    return <>{name}{count > 0 && <span className="cwd-tab-count"> ({count})</span>}</>;
  };

  return (
    <div className="cwd-select-wrapper" ref={dropdownRef}>
      <button className="cwd-select" onClick={() => setOpen(!open)}>
        {activeCwd ? cwdLabel(activeCwd) : '选择工作目录'}
      </button>
      {open && (
        <div className="cwd-dropdown">
          {addedDirs.map((c) => {
            const isActive = c === activeCwd;
            return (
              <div
                key={c}
                className={`cwd-dropdown-item${isActive ? ' active' : ''}`}
                onClick={() => { onSelect(c); setOpen(false); }}
              >
                {cwdLabel(c)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// CwdPane 需要透传给 SplitPane 的全部字段：CenterPane 的 Props + 自建的三个 guard。
interface CwdPaneProps extends Props {
  cwd: string;
  isActive: boolean;
  closeGuards: React.MutableRefObject<Map<string, () => void>>;
  requestCloseTab: (id: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
}

// 单个 cwd 的分屏树渲染：独立订阅 cwdTrees[cwd]。
// memo 仅比较 cwd/isActive：回调引用变化（CenterPane/上层 re-render 时 props 新建）
// 不触发重渲染——这些回调（onOpenFile/onDestroyTerminal 等）行为一致、仅依赖模块级
// pi / store.getState()，旧引用与新引用等价，安全跳过。从而把「切 cwd 之外的」
// CenterPane re-render 完全挡在本 cwd 的 SplitPane → tab 内容之外。
const CwdPane = memo(function CwdPane({ cwd, isActive, ...rest }: CwdPaneProps) {
  const tree = useSplitStore((s) => s.cwdTrees[cwd]);
  if (!tree) return null;
  return <SplitPane tree={tree} cwd={cwd} isActive={isActive} {...rest} />;
}, (prev, next) => prev.cwd === next.cwd && prev.isActive === next.isActive);
