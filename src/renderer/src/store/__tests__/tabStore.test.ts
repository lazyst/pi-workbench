import { describe, it, expect, beforeEach, vi } from 'vitest';

// paneManager 引入 xterm（需要浏览器环境），在 tabStore 纯逻辑测试中 mock 掉。
vi.mock('../../components/paneManager', () => ({
  capturePaneScrollState: vi.fn(),
}));

import { useTabStore, selectNextTabOnClose } from '../tabStore';
import { findLeaf } from '../splitStore';
import type { Tab, TabLocation, SplitTree, SplitChild } from '../splitStore';

/** 取当前 store 状态快照。 */
function getState() {
  return useTabStore.getState();
}

/** 收集所有 cwd 中所有 tab。 */
function getTabs(): Tab[] {
  const state = getState();
  const result: Tab[] = [];
  function walk(node: SplitChild) {
    if (node.type === 'leaf') result.push(...node.tabs);
    else node.children.forEach(walk);
  }
  for (const tree of Object.values(state.cwdTrees)) {
    walk(tree);
  }
  return result;
}

/** 获取当前活跃 leaf 的 activeTabId。 */
function getActiveTabId(): string | null {
  const state = getState();
  if (!state.activeLeafId) return null;
  const found = findLeaf(state.cwdTrees, state.activeLeafId);
  return found?.leaf.activeTabId ?? null;
}

/** 重置 store 到初始空状态，保证用例间隔离。 */
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

/** 便捷读取某 location 下可见 tab（按 order 排序）。 */
function visibleIn(location: TabLocation): Tab[] {
  return getTabs()
    .filter((t) => t.location === location && !t.hidden)
    .sort((a, b) => a.order - b.order);
}

describe('tabStore — 状态容器与 action', () => {
  beforeEach(resetStore);

  describe('openSession', () => {
    it('创建新 session tab 并激活', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      const tab = getTabs()[0];
      expect(tab.kind).toBe('session');
      expect(tab.id).toBe('/a/session.jsonl');
      expect((tab as any).key).toBe('/a/session.jsonl');
      expect(tab.location).toBe('editor');
      expect(tab.hidden).toBe(false);
      expect(tab.order).toBe(0);
      expect(getActiveTabId()).toBe('/a/session.jsonl');
    });

    it('同 key 已存在则取消隐藏并激活（不重复创建）', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      getState().hideTab('/a/session.jsonl');
      expect(getTabs()).toHaveLength(1);
      getState().openSession({ key: '/a/session.jsonl' });
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].hidden).toBe(false);
      expect(getActiveTabId()).toBe('/a/session.jsonl');
    });

    it('key 缺失时用 cwd 作为 id 与 key', () => {
      getState().openSession({ cwd: '/b', name: 'sess-b' });
      const s = getState();
      expect(getTabs()[0].id).toBe('/b');
      expect((getTabs()[0] as any).key).toBe('/b');
    });

    it('多个 session 按创建顺序分配 order', () => {
      getState().openSession({ key: 'k1', cwd: '/a' });
      getState().openSession({ key: 'k2', cwd: '/a' });
      getState().openSession({ key: 'k3', cwd: '/a' });
      const orders = visibleIn('editor').map((t) => t.order);
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe('openPreview', () => {
    it('用 preview:<root>//<path> 作 id 创建并激活', () => {
      getState().openPreview('/repo', 'src/index.ts');
      const s = getState();
      const tab = getTabs()[0];
      expect(tab.kind).toBe('preview');
      expect(tab.id).toBe('preview:/repo//src/index.ts');
      expect(tab.location).toBe('editor');
      expect(tab.title).toBe('index.ts');
      expect(getActiveTabId()).toBe('preview:/repo//src/index.ts');
    });

    it('同 root+path 已存在则激活不重复创建', () => {
      getState().openPreview('/repo', 'a.ts');
      getState().hideTab('preview:/repo//a.ts');
      getState().openPreview('/repo', 'a.ts');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].hidden).toBe(false);
    });
  });

  describe('openDiff', () => {
    it('工作区 diff（commitHash=null）使用 work 后缀 id', () => {
      getState().openDiff('/repo', null);
      const s = getState();
      expect(getTabs()[0].id).toBe('diff:/repo//work');
      expect((getTabs()[0] as any).commitHash).toBeNull();
      expect(getTabs()[0].title).toBe('工作区改动');
    });

    it('指定 commitHash 时使用短 hash 标题', () => {
      getState().openDiff('/repo', 'abc1234def');
      const s = getState();
      expect(getTabs()[0].id).toBe('diff:/repo//abc1234def');
      expect(getTabs()[0].title).toBe('abc1234d');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openDiff('/repo', 'h1');
      getState().hideTab('diff:/repo//h1');
      getState().openDiff('/repo', 'h1');
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].hidden).toBe(false);
    });
  });

  describe('openTerminal', () => {
    it('创建 integrated-terminal tab 并激活指针', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const s = getState();
      const tab = getTabs()[0];
      expect(tab.kind).toBe('integrated-terminal');
      expect(tab.location).toBe('editor');
      expect(tab.id).toBe('terminal:/proj');
      expect(getActiveTabId()).toBe('terminal:/proj');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getActiveTabId()).toBe('terminal:/proj');
    });
  });

  describe('selectTab', () => {
    it('写入 activeTabId', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().selectTab('s1');
      expect(getActiveTabId()).toBe('s1');
    });

    it('写入 activeTabId（terminal tab）', () => {
      getState().openTerminal('terminal:/p1', '/p1', 'Terminal');
      getState().openTerminal('terminal:/p2', '/p2', 'Terminal');
      getState().selectTab('terminal:/p2');
      expect(getActiveTabId()).toBe('terminal:/p2');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().selectTab('nope');
      expect(getActiveTabId()).toBe('s1');
    });
  });

  describe('closeTab', () => {
    it('移除 tab；若为激活项则回退到下一个可见 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().closeTab('s1');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].id).toBe('s2');
      expect(getActiveTabId()).toBe('s2');
    });

    it('移除 terminal tab 后回退到下一个可见 tab', () => {
      getState().openTerminal('terminal:/p1', '/p1', 'Terminal');
      getState().openTerminal('terminal:/p2', '/p1', 'Terminal');
      getState().closeTab('terminal:/p1');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getActiveTabId()).toBe('terminal:/p2');
    });

    it('关闭隐藏（keep-alive）的 session 仍真移除（closeTab=卸载语义）', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().hideTab('s1');
      getState().closeTab('s1');
      expect(getTabs()).toHaveLength(0);
      expect(getActiveTabId()).toBeNull();
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().closeTab('nope');
      expect(getTabs()).toHaveLength(1);
    });
  });

  describe('hideTab', () => {
    it('置 hidden=true 且不卸载（tab 仍在 tabs 中）', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().hideTab('s1');
      const s = getState();
      expect(getTabs()).toHaveLength(2);
      expect(getTabs().find((t) => t.id === 's1')!.hidden).toBe(true);
    });

    it('隐藏激活的 tab 时，激活态切到下一个可见 tab', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().hideTab('s1');
      expect(getActiveTabId()).toBe('s2');
    });

    it('隐藏最后一个可见 tab 后激活指针为 null', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      expect(getActiveTabId()).toBeNull();
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('nope');
      expect(getTabs()[0].hidden).toBe(false);
    });
  });

  describe('setHidden', () => {
    it('setHidden(id, true) 等价于 hideTab', () => {
      getState().openSession({ key: 's1' });
      getState().setHidden('s1', true);
      expect(getTabs()[0].hidden).toBe(true);
    });

    it('setHidden(id, false) 取消隐藏；若无激活项则激活它', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      getState().setHidden('s1', false);
      const s = getState();
      expect(getTabs()[0].hidden).toBe(false);
      expect(getActiveTabId()).toBe('s1');
    });

    it('setHidden 与当前状态相同则为 no-op', () => {
      getState().openSession({ key: 's1' });
      const before = getState().cwdTrees;
      getState().setHidden('s1', false);
      expect(getState().cwdTrees).toBe(before);
    });
  });

  describe('closeCenterTab', () => {
    it('session 终端：关闭 = 真移除，激活指针移到同目录下一个可见 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/a', name: 'sess-b' });
      getState().selectTab('s1');
      // 关闭 s1 → 实例被移除，不再 keep-alive。
      getState().closeCenterTab('s1');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs().find((t) => t.id === 's1')).toBeUndefined();
      // 激活指针移到下一个可见 tab。
      expect(getActiveTabId()).toBe('s2');
    });

    it('session 已关闭再 closeCenterTab 为 no-op（同 id 不存在则跳过）', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().closeCenterTab('s1');
      const before = getState().cwdTrees;
      getState().closeCenterTab('s1');
      const s = getState();
      expect(getState().cwdTrees).toBe(before);
      expect(getTabs().find((t) => t.id === 's1')).toBeUndefined();
    });

    it('preview / diff 关闭 = 真移除（无 keep-alive）', () => {
      getState().openPreview('/repo', 'a.ts');
      getState().openDiff('/repo', null);
      getState().closeCenterTab('preview:/repo//a.ts');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].id).toBe('diff:/repo//work');
    });

    it('关闭激活的 preview tab 后激活指针回退到上一个历史 tab（preview 为真移除）', () => {
      getState().openSession({ key: 's1', cwd: '/repo', name: 'sess-a' });
      getState().openPreview('/repo', 'a.ts');
      getState().openPreview('/repo', 'b.ts');
      getState().selectTab('preview:/repo//a.ts');
      getState().closeCenterTab('preview:/repo//a.ts');
      const s = getState();
      // a.ts 被真移除；b.ts 预览仍保留（仅移除被关的那一个）。
      expect(getTabs().find((t) => t.id === 'preview:/repo//a.ts')).toBeUndefined();
      expect(getTabs().find((t) => t.id === 'preview:/repo//b.ts')).toBeTruthy();
      // 激活指针回退到上一个历史 tab（b.ts 是最近访问的）。
      expect(getActiveTabId()).toBe('preview:/repo//b.ts');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().closeCenterTab('nope');
      expect(getTabs()).toHaveLength(1);
    });
  });

  describe('removeTerminalTab', () => {
    it('移除 terminal tab（kind=integrated-terminal），激活态迁移到同目录下一个可见 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().openTerminal('t-2', '/a', 'Terminal');
      getState().openTerminal('t-3', '/a', 'Terminal');
      // activeTabId 现在指向最后打开的 t-3
      getState().selectTab('t-2');
      getState().removeTerminalTab('t-2');
      const s = getState();
      expect(getTabs().find((t) => t.kind === 'integrated-terminal' && t.id === 't-2')).toBeUndefined();
      // 激活态迁移到上一个历史 tab（t-3 是最近访问的）。
      expect(getActiveTabId()).toBe('t-3');
    });

    it('移除最后一个 terminal tab 后 activeTabId 迁移到同目录 session tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().removeTerminalTab('t-1');
      const s = getState();
      expect(getTabs()).toHaveLength(1);
      expect(getTabs()[0].kind).toBe('session');
      expect(getActiveTabId()).toBe('s1');
    });

    it('移除非激活 terminal tab 不影响当前 activeTabId', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().openTerminal('t-2', '/a', 'Terminal');
      getState().selectTab('t-1');
      getState().removeTerminalTab('t-2');
      expect(getActiveTabId()).toBe('t-1');
    });
  });

  describe('setTerminals（主进程推送覆盖）', () => {
    it('setTerminals 用主进程推送的完整列表覆盖（单一事实来源）', () => {
      const list = [
        { id: 't-1', profileId: 'p', cwd: '/a', title: 'a' },
        { id: 't-2', profileId: 'p', cwd: '/b', title: 'b' },
      ];
      getState().setTerminals(list);
      expect(getState().terminals).toHaveLength(2);
      // 再次推送（如 create 后广播）应整体覆盖，不产生重复 id。
      getState().setTerminals([{ id: 't-1', profileId: 'p', cwd: '/a', title: 'a' }]);
      const s = getState();
      expect(s.terminals).toHaveLength(1);
      expect(s.terminals[0].id).toBe('t-1');
    });
  });

  describe('selectNextTabOnClose (纯函数)', () => {
  const makeTab = (id: string, cwd: string, hidden = false): Tab => ({
    id, kind: 'session' as const, location: 'editor' as const, title: id, order: 0,
    hidden, key: id, cwd, name: id,
  });

  it('返回 patch 当关闭非激活、非记忆 tab（仅清理历史）', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/x'), makeTab('c', '/x')];
    const result = selectNextTabOnClose(tabs, 'c', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a', 'b'] });
    expect(result).not.toBeNull();
    expect(result!.activeTabId).toBe('a');
    expect(result!.cwdTabHistory['/x']).toEqual(['a', 'b']);
  });

  it('关闭激活 tab → 清空激活（无剩余 tab）', () => {
    const result = selectNextTabOnClose([], 'a', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a'] });
    expect(result).toEqual({ activeTabId: null, cwdActiveTab: {}, cwdTabHistory: {} });
  });

  it('关闭激活 tab → 选同 cwd 下一个可见 tab', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/x'), makeTab('c', '/x')];
    const result = selectNextTabOnClose([tabs[1], tabs[2]], 'a', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a', 'b', 'c'] });
    expect(result).not.toBeNull();
    // previousTabInHistory 从历史末尾向前找，'c' 是最后一个
    expect(result!.activeTabId).toBe('c');
  });

  it('关闭激活 tab，同 cwd 无其他 tab → activeTabId 置 null', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/y')];
    const result = selectNextTabOnClose([tabs[1]], 'a', '/x', 'a', '/x', { '/x': 'a', '/y': 'b' }, { '/x': ['a'], '/y': ['b'] });
    expect(result).not.toBeNull();
    expect(result!.activeTabId).toBeNull();
  });

  it('关闭的记忆 tab（非当前激活）→ 更新该 cwd 记忆', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/x'), makeTab('c', '/y')];
    const result = selectNextTabOnClose(tabs, 'b', '/x', 'c', '/y', { '/x': 'b', '/y': 'c' }, { '/x': ['a', 'b'], '/y': ['c'] });
    expect(result).not.toBeNull();
    expect(result!.activeTabId).toBe('c');
    expect(result!.cwdActiveTab['/x']).toBe('a');
  });

  it('关闭隐藏 tab → 清理历史', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/x', true)];
    const result = selectNextTabOnClose([tabs[0]], 'b', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a', 'b'] });
    expect(result).not.toBeNull();
    expect(result!.activeTabId).toBe('a');
    expect(result!.cwdTabHistory['/x']).toEqual(['a']);
  });

  it('清理历史中已移除的 tab', () => {
    const tabs = [makeTab('a', '/x'), makeTab('b', '/x')];
    const result = selectNextTabOnClose([tabs[0]], 'b', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a', 'b', 'c'] });
    expect(result).not.toBeNull();
    expect(result!.cwdTabHistory['/x']).toEqual(['a']);
  });
});

describe('reorderTabs', () => {
    it('按传入顺序重排 order', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().openSession({ key: 's3', cwd: '/a' });
      getState().reorderTabsInLeaf(getState().activeLeafId!, ['s3', 's1', 's2']);
      const byId = Object.fromEntries(visibleIn('editor').map((t) => [t.id, t.order]));
      expect(byId['s3']).toBe(0);
      expect(byId['s1']).toBe(1);
      expect(byId['s2']).toBe(2);
    });

    it('不影响不在 orderedIds 中的 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openTerminal('terminal:/p1', '/a', 'Terminal');
      getState().openTerminal('terminal:/p2', '/a', 'Terminal');
      getState().reorderTabsInLeaf(getState().activeLeafId!, ['s1']);
      // 未在 orderedIds 中的 terminal tab 保持原 order
      expect(getTabs().find((t) => t.id === 's1')!.order).toBe(0);
      expect(getTabs().find((t) => t.id === 'terminal:/p1')!.order).toBe(1);
      expect(getTabs().find((t) => t.id === 'terminal:/p2')!.order).toBe(2);
    });

    it('传入顺序外的 tab 保持原 order', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().openSession({ key: 's3', cwd: '/a' });
      // 只重排 s1、s3，s2 保持 order=1
      getState().reorderTabsInLeaf(getState().activeLeafId!, ['s3', 's1']);
      const s2 = getTabs().find((t) => t.id === 's2')!;
      expect(s2.order).toBe(1);
      expect(getTabs().find((t) => t.id === 's3')!.order).toBe(0);
      expect(getTabs().find((t) => t.id === 's1')!.order).toBe(1);
    });
  });
});
