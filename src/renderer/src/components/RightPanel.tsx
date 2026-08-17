// 右栏容器（重构阶段 2D）：取代 FilePanel 作为新的右栏 Tab 容器。
// 内含两个固定 tab——「文件」（kind:'preview'）与「Git」（kind:'diff'），
// 用通用 TabBar 切换。props 与现有 FilePanel 保持一致，便于阶段 3 App 直接替换。
//
// 注意：FilePanel.tsx 仍保留（仅为过渡，阶段 3 会决定是否删除），本组件是新的右栏实现。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TabBar } from './TabBar';
import { FileTree } from './FileTree';
import { GitView } from './GitView';
import { clampRightPanelWidth } from './sidebarGeometry';
import { pi } from '../ipc';
import { defaultConfig } from '../../../main/config';

// 跨平台取目录名（最后一段路径），与 FilePanel.basename 一致：渲染进程 sandbox
// 不能 import node:path，故自行实现。
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// 下拉框中“自动（跟随会话）”选项的特殊 value，不与任何真实目录冲突。
const AUTO_ROOT = '__auto__';

type RightTab = 'files' | 'git';

interface Props {
  addedDirs: string[];
  // 最后活跃会话的工作目录（稳定：即使当前激活 tab 是预览/diff 也不会归零，
  // 由 App 维护 lastSessionCwd 后传入）。右栏自动模式据此跟随，避免打开文件后丢失根目录。
  activeCwd: string | null;
  // 用户在右栏下拉框中手动选择目录时回调，用于持久化 lastActiveDir。
  onPickDirectory?: (cwd: string) => void;
  // 点击文件 → 中间区新增预览 tab（由 App 处理）；此处仅透传回调。
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  /** 文件树目录右键「添加为工作目录」：透传给 FileTree。 */
  onAddWorkDir?: (absDir: string) => void;
  // 点击 Git 工作区/提交 diff → 中间区新增 diff tab（由 App 处理）。
  onOpenWorkDiff: (cwd: string) => void;
  onOpenCommit: (cwd: string, hash: string) => void;
  onOpenCommitFile: (cwd: string, hash: string, filePath: string) => void;
  width: number;
  onResize: (w: number) => void;
  collapsed?: boolean;
}

export function RightPanel({
  addedDirs,
  activeCwd,
  onPickDirectory,
  onOpenFile,
  onAddWorkDir,
  onOpenWorkDiff,
  onOpenCommit,
  onOpenCommitFile,
  width,
  onResize,
  collapsed,
}: Props) {
  // 右栏自身的 Tab 切换（文件树 / Git）。
  const [tab, setTab] = useState<RightTab>('files');

  // 候选根目录：addedDirs ∪ activeCwd（去重）。
  const candidates = useMemo(() => {
    const set = new Set<string>(addedDirs);
    if (activeCwd) set.add(activeCwd);
    return Array.from(set);
  }, [addedDirs, activeCwd]);

  // root：默认跟随 activeCwd；用户手动选了具体目录则切为手动（不被 activeCwd 抢回）。
  const [root, setRoot] = useState<string>(activeCwd ?? '');
  const [isAuto, setIsAuto] = useState(true);
  useEffect(() => {
    if (isAuto && activeCwd) {
      setRoot(activeCwd);
    }
  }, [activeCwd, isAuto]);

  // 自修复 + 有效根：自动模式下回落到 activeCwd（有会话时），否则空；
  // 手动模式下若 root 仍合法则用之，否则空。
  const effectiveRoot = isAuto
    ? activeCwd ?? ''
    : root && candidates.includes(root)
      ? root
      : '';
  const selectValue = isAuto ? AUTO_ROOT : effectiveRoot;
  const onPickRoot = (r: string) => {
    if (r === AUTO_ROOT) {
      setIsAuto(true);
      setRoot(activeCwd ?? '');
    } else {
      setIsAuto(false);
      setRoot(r);
      onPickDirectory?.(r);
    }
  };

  const empty = candidates.length === 0;

  // Git 工作区是否有未提交改动（用于在 Git tab 上显示小黄点）。
  const [gitDirty, setGitDirty] = useState(false);
  // 订阅 effectiveRoot 的 git 变更：当文件有改动时检查 gitStatus，更新 dirty 标记。
  const gitDirtyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!effectiveRoot) { setGitDirty(false); return; }
    const checkDirty = async () => {
      try {
        const s = await pi.gitStatus(effectiveRoot);
        setGitDirty(s.isGit && (s.additions > 0 || s.deletions > 0));
      } catch {
        setGitDirty(false);
      }
    };
    void checkDirty();
    const scheduleCheck = () => {
      if (gitDirtyTimer.current) clearTimeout(gitDirtyTimer.current);
      gitDirtyTimer.current = setTimeout(() => {
        gitDirtyTimer.current = null;
        void checkDirty();
      }, 250);
    };
    const unsubscribe = pi.gitWatch(effectiveRoot, scheduleCheck);
    return () => {
      unsubscribe();
      if (gitDirtyTimer.current) clearTimeout(gitDirtyTimer.current);
    };
  }, [effectiveRoot]);

  // 右栏宽度由本地 state 控制（初始取 prop width，默认 320）；拖拽实时改、松手经
  // onResize 回写 config——完全对齐 Sidebar 的拖拽模式（解决原“每帧依赖父组件
  // prop 回流”导致的不跟手 / 方向错乱）。
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const [rpWidth, setRpWidth] = useState<number>(width ?? defaultConfig().rightPanelWidth);
  const rpWidthRef = useRef<number>(rpWidth);
  // 异步加载的 config.rightPanelWidth 经 prop 流入时同步到本地宽度 state；
  // 拖拽过程中只走本地 setRpWidth（prop 不变，故本 effect 不触发），因此不冲突。
  useEffect(() => {
    if (width != null) setRpWidth(width);
  }, [width]);
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  // 把最新的 onResize 存进 ref，使拖拽监听回调保持稳定、不依赖 prop 身份。
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    // 右栏方向语义与左栏相反：右栏右贴窗、左缘可拖。
    //   • 鼠标往左拖（clientX 减小）→ 右栏变宽、主内容区变窄；
    //   • 鼠标往右拖（clientX 增大）→ 右栏变窄、主内容区变宽。
    // 故用 startX - clientX（左拖为正、右拖为负），与左栏的 clientX - startX 相反。
    const next = clampRightPanelWidth(s.startWidth + (s.startX - e.clientX), window.innerWidth);
    rpWidthRef.current = next;
    setRpWidth(next); // 本地实时跟手；无需每帧回流父组件
  }, []);
  const onResizerUp = useCallback(() => {
    resizeStart.current = null;
    document.removeEventListener('mousemove', onResizerMove);
    document.removeEventListener('mouseup', onResizerUp);
    if (onResizeRef.current) onResizeRef.current(rpWidthRef.current);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onResizerMove]);
  const onResizerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // 取右栏实际渲染宽度作为起点（隐藏态 offsetWidth 为 0 时退回跟踪宽度）。
    const startWidth = rightPanelRef.current?.offsetWidth || rpWidthRef.current;
    resizeStart.current = { startX: e.clientX, startWidth };
    document.addEventListener('mousemove', onResizerMove);
    document.addEventListener('mouseup', onResizerUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [onResizerMove, onResizerUp]);

  return (
    <div className={`right-panel${collapsed ? ' right-panel--collapsed' : ''}`} ref={rightPanelRef} style={{ width: collapsed ? 0 : rpWidth }}>
      <TabBar
        tabs={[
          { id: 'files', title: '文件', kind: 'preview', closable: false },
          { id: 'git', title: 'Git', kind: 'diff', closable: false },
        ]}
        activeId={tab}
        onSelect={(id) => setTab(id as RightTab)}
        onClose={() => {}}
        showNew={false}
        tabDirty={{ git: gitDirty }}
      />

      {!empty && (
        <div className="right-panel-header">
          <select
            className="rp-root-select"
            value={selectValue}
            onChange={(e) => onPickRoot(e.target.value)}
            title="根目录"
          >
            <option value={AUTO_ROOT}>（自动 · {activeCwd ? basename(activeCwd) : '无会话'}）</option>
            {candidates.map((c) => (
              <option key={c} value={c}>{basename(c)}</option>
            ))}
          </select>
        </div>
      )}

      <div className="right-panel-body">
        {empty ? (
          <div className="file-panel-empty">
            先用 <b>+目录</b> 添加工作目录，即可浏览文件与 Git 状态。
          </div>
        ) : (
          <>
            <div className={`rp-tab-content ${tab === 'files' ? 'active' : 'inactive'}`} data-panel="files">
              <FileTree root={effectiveRoot} onOpenFile={onOpenFile} onAddWorkDir={onAddWorkDir} />
            </div>
            <div className={`rp-tab-content ${tab === 'git' ? 'active' : 'inactive'}`} data-panel="git">
              <GitView cwd={effectiveRoot} onOpenWorkDiff={onOpenWorkDiff} onOpenCommit={onOpenCommit} onOpenFile={onOpenFile} onOpenCommitFile={onOpenCommitFile} />
            </div>
          </>
        )}
      </div>

      {/* 右缘 4px 拖拽条：整高、ew-resize、hover 淡高亮 */}
      {!collapsed && (
        <div
          className="right-panel-resizer"
          onMouseDown={onResizerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整右栏宽度"
        />
      )}
    </div>
  );
}
