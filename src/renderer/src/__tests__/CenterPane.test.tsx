// @vitest-environment jsdom
//
// CenterPane 集成测试（按工作目录分组）。
//
// CenterPane 现在按 store.activeCwd 只显示当前工作目录的 tab 条和内容。
// 测试覆盖：
//   1. 按 activeCwd 过滤可见 tab
//   2. 会话 tab 关闭 → store 置 hidden:true，且内容实例不卸载（keep-alive）
//   3. preview / diff tab 关闭语义不变
//   4. 拖拽重排
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { CenterPane } from '../components/CenterPane';
import { useTabStore, getTabCwd } from '../store/tabStore';
import type { Tab } from '../store/tabStore';

// —— 轻量桩：只暴露可被断言的 data-* 与 className ——
vi.mock('../components/SessionPane', () => ({
  SessionPane: ({ sessionKey, active }: any) => (
    <div
      data-testid="terminal-pane"
      data-key={sessionKey}
      className={active ? 'tab-content active' : 'tab-content'}
    >
      {sessionKey}
    </div>
  ),
}));

vi.mock('../components/PreviewTab', () => ({
  PreviewTab: ({ tabId, active, onRegisterCloseGuard, onClose }: any) => {
    return (
      <div
        data-testid="preview-tab-body"
        data-id={tabId}
        className={active ? 'tab-content active' : 'tab-content'}
      >
        <button
          data-testid="preview-confirm-close"
          onClick={() => {
            onRegisterCloseGuard?.(tabId, () => onClose());
          }}
        >
          register-guard
        </button>
      </div>
    );
  },
}));

vi.mock('../components/DiffTab', () => ({
  DiffTab: ({ cwd, commitHash, active }: any) => (
    <div
      data-testid="diff-tab-body"
      data-cwd={cwd}
      className={active ? 'tab-content active' : 'tab-content'}
    >
      diff:{cwd}:{commitHash ?? 'work'}
    </div>
  ),
}));

/** 重置 store 到干净状态（splitStore 初始状态）。 */
function resetStore() {
  useTabStore.setState({
    cwdTrees: {},
    activeCwd: null,
    activeLeafId: null,
    cwdOrder: [],
    cwdActiveLeafId: {},
    cwdActiveTab: {},
    cwdTabHistory: {},
    terminals: [],
  });
}

/** 获取当前活跃 leaf 的 tabs。 */
function getTabs(): Tab[] {
  const s = useTabStore.getState();
  if (!s.activeCwd || !s.activeLeafId) return [];
  const tree = s.cwdTrees[s.activeCwd];
  if (!tree) return [];
  const findLeaf = (node: any): any => {
    if (node.type === 'leaf') return node.id === s.activeLeafId ? node : null;
    for (const child of node.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(tree);
  return leaf?.tabs ?? [];
}

/** 获取当前活跃 leaf 的 activeTabId。 */
function getActiveTabId(): string | null {
  const s = useTabStore.getState();
  if (!s.activeCwd || !s.activeLeafId) return null;
  const tree = s.cwdTrees[s.activeCwd];
  if (!tree) return null;
  const findLeaf = (node: any): any => {
    if (node.type === 'leaf') return node.id === s.activeLeafId ? node : null;
    for (const child of node.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(tree);
  return leaf?.activeTabId ?? null;
}

/** 设置当前活跃 leaf 的 activeTabId。 */
function setActiveTab(tabId: string) {
  const s = useTabStore.getState();
  if (!s.activeCwd) return;
  const tree = s.cwdTrees[s.activeCwd];
  if (!tree || tree.type !== 'leaf') return;
  useTabStore.setState({
    cwdTrees: { ...s.cwdTrees, [s.activeCwd]: { ...tree, activeTabId: tabId } },
  });
}

/** 用 tabs 灌入 store，自动根据第一个非 hidden tab 的 cwd 设置 activeCwd。
 *  创建一个单 leaf 的树结构（splitStore 数据模型）。 */
function seedTabs(tabs: Tab[]) {
  const firstVisible = tabs.find((t) => !t.hidden) || tabs[0];
  const cwd = firstVisible ? getTabCwd(firstVisible) : null;
  const leafId = 'leaf-1';
  const activeTabId = firstVisible?.id ?? null;
  const cwdOrder = cwd ? [cwd] : [];
  const cwdActiveLeafId = cwd && firstVisible ? { [cwd]: leafId } : {};
  const cwdActiveTab = cwd && firstVisible ? { [cwd]: activeTabId } : {};
  useTabStore.setState({
    cwdTrees: cwd ? { [cwd]: { type: 'leaf', id: leafId, tabs, activeTabId } } : {},
    activeCwd: cwd,
    activeLeafId: cwd ? leafId : null,
    cwdOrder,
    cwdActiveLeafId,
    cwdActiveTab,
    cwdTabHistory: {},
    terminals: [],
  });
}

function renderCenterPane(overrides: Partial<React.ComponentProps<typeof CenterPane>> = {}) {
  return render(<CenterPane {...overrides} />);
}

describe('CenterPane — 按工作目录分组', () => {
  beforeEach(resetStore);

  describe('按 activeCwd 过滤 tab', () => {
    it('只渲染 activeCwd 下的可见 tab，其他目录的 tab 不出现', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/root', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: true, order: 1, key: '/b', cwd: '/root', name: 'sess-b' } as Tab,
      ]);
      const { container } = renderCenterPane();
      const tabEls = container.querySelectorAll('.center-pane .terminal-tab');
      // s2 已 hidden → 不进 TabBar。
      expect(tabEls.length).toBe(1);
      expect(tabEls[0].textContent).toContain('sess-a');
    });

    it('active 指针驱动 TabBar 的 active class，取数自 store.activeTabId', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/root', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/root', name: 'sess-b' } as Tab,
      ]);
      setActiveTab('s2');
      const { container } = renderCenterPane();
      const tabEls = container.querySelectorAll('.center-pane .terminal-tab');
      expect(tabEls[0].className).not.toContain('active');
      expect(tabEls[1].className).toContain('active');
    });

    it('activeCwd 为 null 时渲染目录选择提示', () => {
      useTabStore.setState({
        cwdTrees: {},
        activeCwd: null,
        activeLeafId: null,
        cwdOrder: [],
        cwdActiveLeafId: {},
        cwdActiveTab: {},
        cwdTabHistory: {},
        terminals: [],
      });
      const { container } = renderCenterPane();
      // 无 activeCwd 时，cwd 选择器显示「选择工作目录」提示
      expect(container.querySelector('.cwd-select')?.textContent).toContain('选择工作目录');
    });

    it('activeCwd 有值但目录下无任何 tab 时渲染新建会话按钮', () => {
      useTabStore.setState({
        cwdTrees: { '/a': { type: 'leaf', id: 'leaf-1', tabs: [], activeTabId: null } },
        activeCwd: '/a',
        activeLeafId: 'leaf-1',
        cwdOrder: ['/a'],
        cwdActiveLeafId: { '/a': 'leaf-1' },
        cwdActiveTab: {},
        cwdTabHistory: {},
        terminals: [],
      });
      const { container } = renderCenterPane();
      expect(container.querySelector('.empty-state')).toBeTruthy();
      expect(container.querySelector('.empty-state-new-session-btn')).toBeTruthy();
    });

    it('activeCwd 有值且目录下有隐藏 tab 时不显示空状态', () => {
      useTabStore.setState({
        cwdTrees: { '/a': { type: 'leaf', id: 'leaf-1', tabs: [
          { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: true, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
        ], activeTabId: null } },
        activeCwd: '/a',
        activeLeafId: 'leaf-1',
        cwdOrder: ['/a'],
        cwdActiveLeafId: { '/a': 'leaf-1' },
        cwdActiveTab: { '/a': null },
        cwdTabHistory: {},
        terminals: [],
      });
      const { container } = renderCenterPane();
      // hidden tab 内容仍挂载（keep-alive），不应显示空状态
      expect(container.querySelector('.empty-state')).toBeFalsy();
      expect(container.querySelector('[data-testid="terminal-pane"]')).toBeTruthy();
    });
  });

  describe('关闭会话 tab 后 tab 被移除', () => {
    it('关闭会话 tab → 调 store.closeCenterTab，tab 被移除', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/root', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/root', name: 'sess-b' } as Tab,
      ]);
      setActiveTab('s1');
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      // 所有 tab 内容 div 都挂载。
      const panes = container.querySelectorAll('[data-testid="terminal-pane"]');
      expect(panes.length).toBe(2);

      // 点 TabBar 上 s1 的 ×。
      const closeBtns = container.querySelectorAll('.center-pane .terminal-tab .tab-close');
      expect(closeBtns.length).toBe(2);
      fireEvent.click(closeBtns[0] as HTMLElement);

      expect(closeCenterTab).toHaveBeenCalledWith('s1');
      expect(getTabs().find((t) => t.id === 's1')).toBeUndefined();
      expect(getTabs()).toHaveLength(1);
    });

    it('关闭后重新打开会创建新 tab 实例', () => {
      seedTabs([
        { id: '/a', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/a', name: 'sess-a' } as Tab,
      ]);
      const { container } = renderCenterPane();
      // 关闭 tab
      const closeBtn = container.querySelector('.center-pane .terminal-tab .tab-close') as HTMLElement;
      fireEvent.click(closeBtn);

      // tab 被移除，内容 div 不再挂载
      expect(container.querySelectorAll('[data-testid="terminal-pane"]').length).toBe(0);
      expect(getTabs().find((t) => t.id === '/a')).toBeUndefined();
    });
  });

  describe('preview / diff 关闭：guard 拦截与真移除', () => {
    it('preview 关闭 × 经 CenterPane guard 注册 → 调用注册的 guard', () => {
      seedTabs([
        { id: 'preview:/repo//a.ts', kind: 'preview', location: 'editor', title: 'a.ts', hidden: false, order: 0, root: '/repo', path: 'a.ts' } as Tab,
      ]);
      setActiveTab('preview:/repo//a.ts');
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      const registerBtn = container.querySelector('[data-testid="preview-confirm-close"]') as HTMLElement;
      act(() => { fireEvent.click(registerBtn); });

      const closeBtn = container.querySelector('.center-pane .terminal-tab .tab-close') as HTMLElement;
      fireEvent.click(closeBtn);
      expect(closeCenterTab).toHaveBeenCalledWith('preview:/repo//a.ts');
    });

    it('diff tab 的 × 直接走 store.closeCenterTab（无 guard）', () => {
      seedTabs([
        { id: 'preview:/repo//a.ts', kind: 'preview', location: 'editor', title: 'a.ts', hidden: false, order: 0, root: '/repo', path: 'a.ts' } as Tab,
        { id: 'diff:/repo//work', kind: 'diff', location: 'editor', title: '工作区改动', hidden: false, order: 1, cwd: '/repo', commitHash: null } as Tab,
      ]);
      setActiveTab('diff:/repo//work');
      const closeCenterTab = vi.spyOn(useTabStore.getState(), 'closeCenterTab');

      const { container } = renderCenterPane();
      const closeBtns = container.querySelectorAll('.center-pane .terminal-tab .tab-close');
      fireEvent.click(closeBtns[1] as HTMLElement);
      expect(closeCenterTab).toHaveBeenCalledWith('diff:/repo//work');
    });
  });

  describe('拖拽重排（issue 11 / ADR-0001 TabReorder）', () => {
    it('父层按 store.order 排序后传入 TabBar，视觉顺序跟随 order', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/root', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/root', name: 'sess-b' } as Tab,
        { id: 's3', kind: 'session', location: 'editor', title: 'sess-c', hidden: false, order: 2, key: '/c', cwd: '/root', name: 'sess-c' } as Tab,
      ]);
      const { container } = renderCenterPane();
      const els = container.querySelectorAll('.center-pane .terminal-tab');
      expect(els[0].textContent).toContain('sess-a');
      expect(els[1].textContent).toContain('sess-b');
      expect(els[2].textContent).toContain('sess-c');
    });

    it('reorderTabs 仅改 order、不重排内容实例', () => {
      seedTabs([
        { id: 's1', kind: 'session', location: 'editor', title: 'sess-a', hidden: false, order: 0, key: '/a', cwd: '/root', name: 'sess-a' } as Tab,
        { id: 's2', kind: 'session', location: 'editor', title: 'sess-b', hidden: false, order: 1, key: '/b', cwd: '/root', name: 'sess-b' } as Tab,
        { id: 's3', kind: 'session', location: 'editor', title: 'sess-c', hidden: false, order: 2, key: '/c', cwd: '/root', name: 'sess-c' } as Tab,
      ]);
      const { container } = renderCenterPane();
      const panesBefore = container.querySelectorAll('[data-testid="terminal-pane"]');
      expect(panesBefore).toHaveLength(3);

      act(() => {
        const leafId = useTabStore.getState().activeLeafId!;
        useTabStore.getState().reorderTabsInLeaf(leafId, ['s3', 's1', 's2']);
      });

      const els = container.querySelectorAll('.center-pane .terminal-tab');
      expect(els[0].textContent).toContain('sess-c');
      expect(els[1].textContent).toContain('sess-a');
      expect(els[2].textContent).toContain('sess-b');

      const panesAfter = container.querySelectorAll('[data-testid="terminal-pane"]');
      expect(panesAfter).toHaveLength(3);
      const keys = Array.from(panesAfter).map((p) => p.getAttribute('data-key')).sort();
      expect(keys).toEqual(['/a', '/b', '/c']);
    });
  });
});
