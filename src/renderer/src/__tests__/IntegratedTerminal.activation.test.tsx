// @vitest-environment jsdom
//
// 集成终端：新建 / 切换 / 退出后激活指针正确迁移（issue 04 回归）。
//
// Phase 2 重构后，集成终端以 tab 形式在统一 TabBar 中展示：
//   - 新建 → openTerminal(id, cwd, title) 创建 tab，activeTabId 指向新 tab；
//   - 切换 → selectTab(id) 写 activeTabId；
//   - 退出 → removeTerminalTab(id) 移除 tab，若为激活态则迁移到下一个可见 tab 或 null。
//
// 本文件断言「新建 / 切换 / 退出」三种操作后激活指针的精确迁移。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTabStore } from '../store/tabStore';
import { findLeaf } from '../store/splitStore';

function getTabs() {
  const state = useTabStore.getState();
  const tabs: any[] = [];
  for (const tree of Object.values(state.cwdTrees)) {
    const collect = (node: any): void => {
      if (node.type === 'leaf') {
        tabs.push(...node.tabs);
      } else if (node.type === 'split') {
        node.children.forEach(collect);
      }
    };
    collect(tree);
  }
  return tabs;
}

function getActiveTabId() {
  const state = useTabStore.getState();
  if (!state.activeLeafId) return null;
  const found = findLeaf(state.cwdTrees, state.activeLeafId);
  return found?.leaf.activeTabId ?? null;
}

function seed(activeId: string | null) {
  // 所有 tab 用同一 cwd 以便在同目录内迁移激活指针。
  const cwd = '/a';
  const leafId = 'leaf-1';
  const tabs = [
    { id: 't-1', kind: 'integrated-terminal', location: 'editor', title: 'PowerShell', hidden: false, order: 0, cwd },
    { id: 't-2', kind: 'integrated-terminal', location: 'editor', title: 'bash', hidden: false, order: 1, cwd },
    { id: 't-3', kind: 'integrated-terminal', location: 'editor', title: 'shell', hidden: false, order: 2, cwd },
  ] as any[];
  const cwdActiveTab: Record<string, string | null> = {};
  if (activeId) cwdActiveTab[cwd] = activeId;
  useTabStore.setState({
    cwdTrees: {
      [cwd]: { type: 'leaf', id: leafId, tabs, activeTabId: activeId },
    },
    activeCwd: cwd,
    activeLeafId: leafId,
    cwdOrder: [cwd],
    cwdActiveTab,
    terminals: [
      { id: 't-1', profileId: 'pwsh', cwd, title: 'PowerShell' },
      { id: 't-2', profileId: 'bash', cwd, title: 'bash' },
      { id: 't-3', profileId: 'pwsh', cwd, title: 'shell' },
    ],
  });
}

describe('集成终端激活指针迁移（store 为单一事实来源）', () => {
  beforeEach(() => {
    useTabStore.setState({
      cwdTrees: {},
      activeCwd: null,
      activeLeafId: null,
      cwdOrder: [],
      cwdActiveTab: {},
      cwdTabHistory: {},
      terminals: [],
    });
  });

  describe('新建（openTerminal → activeTabId）', () => {
    it('新建终端 tab 后激活指针指向新终端 id', () => {
      useTabStore.getState().openTerminal('t-9', '/x', 'zsh');
      expect(getActiveTabId()).toBe('t-9');
    });

    it('已存在的 tab 不重复创建，activeTabId 指向已有 tab', () => {
      seed('t-1');
      useTabStore.getState().openTerminal('t-1', '/a', 'PowerShell');
      expect(getTabs()).toHaveLength(3);
      expect(getActiveTabId()).toBe('t-1');
    });
  });

  describe('切换（selectTab → activeTabId）', () => {
    it('selectTab 写入 activeTabId', () => {
      seed('t-1');
      useTabStore.getState().selectTab('t-3');
      expect(getActiveTabId()).toBe('t-3');
    });
  });

  describe('退出（removeTerminalTab → 激活指针迁移）', () => {
    it('移除激活的 terminal tab → 激活指针迁移到下一个可见 tab', () => {
      seed('t-2');
      useTabStore.getState().removeTerminalTab('t-2');
      expect(getTabs().find((t: any) => t.kind === 'integrated-terminal' && t.id === 't-2')).toBeUndefined();
      expect(getActiveTabId()).toBe('t-1');
    });

    it('移除最后一个 terminal tab → 激活指针置 null', () => {
      useTabStore.setState({
        cwdTrees: {
          '/x': { type: 'leaf', id: 'leaf-1', tabs: [{ id: 't-1', kind: 'integrated-terminal', location: 'editor', title: 'shell', hidden: false, order: 0, cwd: '/x' }] as any[], activeTabId: 't-1' },
        },
        activeCwd: '/x',
        activeLeafId: 'leaf-1',
        terminals: [{ id: 't-1', profileId: 'p', cwd: '/x', title: 'shell' }],
      });
      useTabStore.getState().removeTerminalTab('t-1');
      expect(getTabs()).toHaveLength(0);
      expect(getActiveTabId()).toBeNull();
    });

    it('移除非激活 terminal tab → 激活指针不变', () => {
      seed('t-1');
      useTabStore.getState().removeTerminalTab('t-3');
      expect(getActiveTabId()).toBe('t-1');
    });
  });
});
