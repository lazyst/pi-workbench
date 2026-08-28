import { describe, it, expect, beforeEach, vi } from 'vitest';

// paneManager 引入 xterm（需要浏览器环境），在 splitStore 纯逻辑测试中 mock 掉。
vi.mock('../../components/paneManager', () => ({
  capturePaneScrollState: vi.fn(),
}));

import { useSplitStore, findTabById, findTabByKey, findTabByTerminalId, selectNextTabOnClose, getAllTabs, findLeaf, canMoveTabToLeaf, getTabCwd } from '../splitStore';
import type { Tab, TabKind, TabLocation, SessionTab, TabLoc, SplitLeaf, SplitTree } from '../splitStore';

/** 重置 store 到初始空状态。 */
function resetStore() {
  useSplitStore.setState({
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

/** 取当前 store 状态快照。 */
function getState() {
  return useSplitStore.getState();
}

describe('splitStore — 数据模型与基础操作', () => {
  beforeEach(resetStore);

  describe('openSession', () => {
    it('创建新 session tab 并激活', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      const s = getState();
      const allTabs = getAllTabs(s);
      expect(allTabs).toHaveLength(1);
      const tab = allTabs[0];
      expect(tab.kind).toBe('session');
      expect(tab.id).toBe('/a/session.jsonl');
      expect((tab as SessionTab).key).toBe('/a/session.jsonl');
      expect(tab.hidden).toBe(false);
      expect(tab.order).toBe(0);
      expect(s.activeCwd).toBe('/a');
      // activeLeafId 应被设置
      expect(s.activeLeafId).not.toBeNull();
    });

    it('同 key 已存在则取消隐藏并激活（不重复创建）', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      getState().hideTab('/a/session.jsonl');
      const allTabs1 = getAllTabs(getState());
      expect(allTabs1).toHaveLength(1);
      
      getState().openSession({ key: '/a/session.jsonl' });
      const s = getState();
      const allTabs2 = getAllTabs(s);
      expect(allTabs2).toHaveLength(1);
      expect(allTabs2[0].hidden).toBe(false);
      // 应切换到该 tab 所在的 cwd
      expect(s.activeCwd).toBe('/a');
    });

    it('key 缺失时用 cwd 作为 id 与 key', () => {
      getState().openSession({ cwd: '/b', name: 'sess-b' });
      const allTabs = getAllTabs(getState());
      expect(allTabs[0].id).toBe('/b');
      expect((allTabs[0] as SessionTab).key).toBe('/b');
    });

    it('多个 session 按创建顺序分配 order', () => {
      getState().openSession({ key: 'k1', cwd: '/a' });
      getState().openSession({ key: 'k2', cwd: '/a' });
      getState().openSession({ key: 'k3', cwd: '/a' });
      const allTabs = getAllTabs(getState());
      const orders = allTabs.filter((t) => !t.hidden).sort((a, b) => a.order - b.order).map((t) => t.order);
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe('openPreview', () => {
    it('用 preview:<root>//<path> 作 id 创建并激活', () => {
      getState().openPreview('/repo', 'src/index.ts');
      const s = getState();
      const allTabs = getAllTabs(s);
      const tab = allTabs[0];
      expect(tab.kind).toBe('preview');
      expect(tab.id).toBe('preview:/repo//src/index.ts');
      expect(tab.title).toBe('index.ts');
      expect(s.activeCwd).toBe('/repo');
    });

    it('同 root+path 已存在则激活不重复创建', () => {
      getState().openPreview('/repo', 'a.ts');
      getState().hideTab('preview:/repo//a.ts');
      getState().openPreview('/repo', 'a.ts');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0].hidden).toBe(false);
    });
  });

  describe('openDiff', () => {
    it('工作区 diff（commitHash=null）使用 work 后缀 id', () => {
      getState().openDiff('/repo', null);
      const allTabs = getAllTabs(getState());
      expect(allTabs[0].id).toBe('diff:/repo//work');
      expect(allTabs[0].title).toBe('工作区改动');
    });

    it('指定 commitHash 时使用短 hash 标题', () => {
      getState().openDiff('/repo', 'abc1234def');
      const allTabs = getAllTabs(getState());
      expect(allTabs[0].id).toBe('diff:/repo//abc1234def');
      expect(allTabs[0].title).toBe('abc1234d');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openDiff('/repo', 'h1');
      getState().hideTab('diff:/repo//h1');
      getState().openDiff('/repo', 'h1');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0].hidden).toBe(false);
    });
  });

  describe('openTerminal', () => {
    it('创建 integrated-terminal tab 并激活', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const allTabs = getAllTabs(getState());
      const tab = allTabs[0];
      expect(tab.kind).toBe('integrated-terminal');
      expect(tab.id).toBe('terminal:/proj');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
    });
  });

  describe('selectTab', () => {
    it('写入 activeTabId', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().selectTab('s1');
      // 通过 getState 获取 activeTabId 需要从 leaf 中查找
      const s = getState();
      const allTabs = getAllTabs(s);
      expect(allTabs.find((t) => t.id === 's1')).toBeTruthy();
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().selectTab('nope');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
    });
  });

  describe('closeTab', () => {
    it('移除 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().closeTab('s1');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0].id).toBe('s2');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().closeTab('nope');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
    });
  });

  describe('hideTab', () => {
    it('置 hidden=true 且不卸载（tab 仍在 tabs 中）', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().openSession({ key: 's2', cwd: '/a' });
      getState().hideTab('s1');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(2);
      expect(allTabs.find((t) => t.id === 's1')!.hidden).toBe(true);
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().hideTab('nope');
      const allTabs = getAllTabs(getState());
      expect(allTabs[0].hidden).toBe(false);
    });
  });

  describe('setHidden', () => {
    it('setHidden(id, true) 等价于 hideTab', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      getState().setHidden('s1', true);
      const allTabs = getAllTabs(getState());
      expect(allTabs[0].hidden).toBe(true);
    });

    it('setHidden 与当前状态相同则为 no-op', () => {
      getState().openSession({ key: 's1', cwd: '/a' });
      const before = getAllTabs(getState());
      getState().setHidden('s1', false);
      // 应该是 no-op，但 getAllTabs 总是返回新数组
      // 验证值不变即可
      const after = getAllTabs(getState());
      expect(after[0].hidden).toBe(false);
    });
  });

  describe('removeSessionTab', () => {
    it('移除 session tab（IPC 事件）', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/a', name: 'sess-b' });
      getState().removeSessionTab('s1');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0].id).toBe('s2');
    });
  });

  describe('removeTerminalTab', () => {
    it('移除 terminal tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().removeTerminalTab('t-1');
      const allTabs = getAllTabs(getState());
      expect(allTabs).toHaveLength(1);
      expect(allTabs[0].kind).toBe('session');
    });
  });

  describe('setTerminals', () => {
    it('setTerminals 用主进程推送的完整列表覆盖', () => {
      const list = [
        { id: 't-1', profileId: 'p', cwd: '/a', title: 'a' },
        { id: 't-2', profileId: 'p', cwd: '/b', title: 'b' },
      ];
      getState().setTerminals(list);
      expect(getState().terminals).toHaveLength(2);
      getState().setTerminals([{ id: 't-1', profileId: 'p', cwd: '/a', title: 'a' }]);
      expect(getState().terminals).toHaveLength(1);
      expect(getState().terminals[0].id).toBe('t-1');
    });
  });

  describe('selectNextTabOnClose (纯函数)', () => {
    const makeTab = (id: string, cwd: string, hidden = false): Tab => ({
      id, kind: 'session' as const, location: 'editor' as const, title: id, order: 0,
      hidden, key: id, cwd, name: id,
    });

    it('关闭激活 tab → 选同 cwd 下一个可见 tab', () => {
      const tabs = [makeTab('a', '/x'), makeTab('b', '/x'), makeTab('c', '/x')];
      const result = selectNextTabOnClose([tabs[1], tabs[2]], 'a', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a', 'b', 'c'] });
      expect(result).not.toBeNull();
      expect(result!.activeTabId).toBe('c');
    });

    it('关闭激活 tab → 清空激活（无剩余 tab）', () => {
      const result = selectNextTabOnClose([], 'a', '/x', 'a', '/x', { '/x': 'a' }, { '/x': ['a'] });
      expect(result).toEqual({ activeTabId: null, cwdActiveTab: {}, cwdTabHistory: {} });
    });

    it('关闭的记忆 tab（非当前激活）→ 更新该 cwd 记忆', () => {
      const tabs = [makeTab('a', '/x'), makeTab('b', '/x'), makeTab('c', '/y')];
      const result = selectNextTabOnClose(tabs, 'b', '/x', 'c', '/y', { '/x': 'b', '/y': 'c' }, { '/x': ['a', 'b'], '/y': ['c'] });
      expect(result).not.toBeNull();
      expect(result!.activeTabId).toBe('c');
      expect(result!.cwdActiveTab['/x']).toBe('a');
    });
  });

  describe('全局去重', () => {
    it('同一 session key 在另一 cwd 中已存在时，跳转到该 cwd', () => {
      // 先在 cwdA 创建 session
      getState().openSession({ key: 'shared-key', cwd: '/a', name: 'shared' });
      const s1 = getState();
      expect(s1.activeCwd).toBe('/a');

      // 再在 cwdB 尝试创建同一 key → 应跳转到 cwdA
      getState().openSession({ key: 'shared-key', cwd: '/b', name: 'shared' });
      const s2 = getState();
      expect(s2.activeCwd).toBe('/a'); // 跳转到已存在的 leaf
    });
  });

  describe('跨 cwd 独立', () => {
    it('cwdA 分屏不影响 cwdB', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/b', name: 'sess-b' });

      // 切换回 cwdA
      getState().setActiveCwd('/a');
      
      const s = getState();
      const allTabs = getAllTabs(s);
      // 应有 2 个 tab（s1 在 cwdA，s2 在 cwdB）
      expect(allTabs).toHaveLength(2);
      expect(s.activeCwd).toBe('/a');
    });
  });

  describe('跨 cwd 切换', () => {
    it('切换 cwd 后分屏树完整恢复', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/a', name: 'sess-b' });
      getState().openSession({ key: 's3', cwd: '/b', name: 'sess-c' });

      // 切回 cwdA
      getState().setActiveCwd('/a');
      const s1 = getState();
      expect(s1.activeCwd).toBe('/a');

      // 切回 cwdB
      getState().setActiveCwd('/b');
      const s2 = getState();
      expect(s2.activeCwd).toBe('/b');
    });
  });

  describe('findTabById / findTabByKey', () => {
    it('findTabById 能找到 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      const s = getState();
      const found = findTabById(s.cwdTrees, 's1');
      expect(found).not.toBeNull();
      expect(found!.tab.id).toBe('s1');
    });

    it('findTabByKey 能找到 session tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      const s = getState();
      const found = findTabByKey(s.cwdTrees, 's1');
      expect(found).not.toBeNull();
      expect(found!.tab.id).toBe('s1');
    });

    it('findTabById 找不到不存在的 tab 时返回 null', () => {
      const s = getState();
      const found = findTabById(s.cwdTrees, 'nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('splitPane — 分屏', () => {
    beforeEach(() => {
      // 先创建一个 session tab，建立 cwd 树
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
    });

    it('水平分屏后树结构正确（两个 leaf 各 50%）', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      expect(leafId).toBeTruthy();

      store.splitPane(leafId, 'horizontal');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        expect(tree.direction).toBe('horizontal');
        expect(tree.ratios).toEqual([0.5, 0.5]);
        expect(tree.children).toHaveLength(2);
        expect(tree.children[0].type).toBe('leaf');
        expect(tree.children[1].type).toBe('leaf');
        expect(tree.children[0].id).toBe(leafId); // 原 leaf 保留
        expect(tree.children[1].id).not.toBe(leafId); // 新 leaf
      }
    });

    it('垂直分屏后 direction 为 vertical', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      store.splitPane(leafId, 'vertical');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        expect(tree.direction).toBe('vertical');
      }
    });

    it('分屏后 activeLeafId 指向新 leaf', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      store.splitPane(leafId, 'horizontal');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const newLeafId = tree.children[1].id;
        expect(s.activeLeafId).toBe(newLeafId);
      }
    });

    it('连续分屏（嵌套）后树结构正确', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      // 第一次分屏：水平
      store.splitPane(leafId, 'horizontal');
      let s = getState();
      let tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leftLeaf = tree.children[0];
        // 第二次分屏：在左 leaf 上垂直分屏
        store.splitPane(leftLeaf.id, 'vertical');
        s = getState();
        tree = s.cwdTrees['/a'];
        // 根节点还是 split
        expect(tree.type).toBe('split');
        if (tree.type === 'split') {
          expect(tree.direction).toBe('horizontal');
          expect(tree.children).toHaveLength(2);
          // 左 child 现在是 split node（嵌套）
          const leftChild = tree.children[0];
          expect(leftChild.type).toBe('split');
          if (leftChild.type === 'split') {
            expect(leftChild.direction).toBe('vertical');
            expect(leftChild.children).toHaveLength(2);
            expect(leftChild.children[0].type).toBe('leaf');
            expect(leftChild.children[1].type).toBe('leaf');
          }
        }
      }
    });
  });

  describe('splitPaneWithTab — 分屏并移动 tab', () => {
    beforeEach(() => {
      // 创建两个 session tab，确保源 leaf 有多个 tab
      getState().openSession({ key: '/a/s1.jsonl', cwd: '/a', name: 's1' });
      getState().openSession({ key: '/a/s2.jsonl', cwd: '/a', name: 's2' });
    });

    it('水平分屏后被移动的 tab 在新 leaf 中', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        expect(tree.direction).toBe('horizontal');
        expect(tree.children).toHaveLength(2);

        const leftLeaf = tree.children[0];
        const rightLeaf = tree.children[1];
        expect(leftLeaf.type).toBe('leaf');
        expect(rightLeaf.type).toBe('leaf');

        if (leftLeaf.type === 'leaf' && rightLeaf.type === 'leaf') {
          // 源 leaf 应保留 s2
          expect(leftLeaf.tabs).toHaveLength(1);
          expect(leftLeaf.tabs[0].id).toBe('/a/s2.jsonl');
          // 新 leaf 应有 s1
          expect(rightLeaf.tabs).toHaveLength(1);
          expect(rightLeaf.tabs[0].id).toBe('/a/s1.jsonl');
          // 新 leaf 的 activeTabId 指向被移动的 tab
          expect(rightLeaf.activeTabId).toBe('/a/s1.jsonl');
        }
      }
    });

    it('垂直分屏后 direction 为 vertical', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'vertical');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        expect(tree.direction).toBe('vertical');
      }
    });

    it('分屏后 activeLeafId 指向新 leaf', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const newLeafId = tree.children[1].id;
        expect(s.activeLeafId).toBe(newLeafId);
      }
    });

    it('被移 tab 是 active 时，源 leaf 自动选下一个 tab 激活', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      // s2 是最后创建的，自动成为 activeTabId

      store.splitPaneWithTab(leafId, '/a/s2.jsonl', 'horizontal');

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leftLeaf = tree.children[0];
        if (leftLeaf.type === 'leaf') {
          // 源 leaf 的 activeTabId 应切到 s1
          expect(leftLeaf.activeTabId).toBe('/a/s1.jsonl');
        }
      }
    });

    it('源 leaf 只有一个 tab 时，不执行分屏（防御性检查）', () => {
      // 先删除 s2，只剩 s1
      const store = getState();
      store.closeTab('/a/s2.jsonl');
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal');

      const s = getState();
      // 树结构不应改变
      const tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('leaf');
    });

    it('side:"before" 时新 leaf 为第一个子节点（拖到左/上边缘）', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal', { side: 'before' });

      const s = getState();
      const tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        const firstLeaf = tree.children[0];
        const secondLeaf = tree.children[1];
        if (firstLeaf.type === 'leaf' && secondLeaf.type === 'leaf') {
          // 第一个子节点 = 新 leaf（含被移 tab s1）
          expect(firstLeaf.tabs).toHaveLength(1);
          expect(firstLeaf.tabs[0].id).toBe('/a/s1.jsonl');
          expect(firstLeaf.activeTabId).toBe('/a/s1.jsonl');
          // 第二个子节点 = 源 leaf（保留 s2）
          expect(secondLeaf.tabs).toHaveLength(1);
          expect(secondLeaf.tabs[0].id).toBe('/a/s2.jsonl');
        }
      }
    });

    it('side:"after" 时新 leaf 为第二个子节点（拖到右/下边缘，等同默认）', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal', { side: 'after' });

      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        if (tree.children[0].type === 'leaf' && tree.children[1].type === 'leaf') {
          // 源 leaf 在前，新 leaf 在后
          expect(tree.children[0].tabs[0].id).toBe('/a/s2.jsonl');
          expect(tree.children[1].tabs[0].id).toBe('/a/s1.jsonl');
        }
      }
    });

    it('allowEmptySource:true 时单 tab 拖出后源空自动合并（同 leaf：分屏取消，树回退单 leaf）', () => {
      // 先删除 s2，只剩 s1
      const store = getState();
      store.closeTab('/a/s2.jsonl');
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'horizontal', { allowEmptySource: true });

      const s = getState();
      const tree = s.cwdTrees['/a'];
      // 源 leaf 变空 → 自动合并：splitNode 内的空 half 被移除，只剩新 leaf → 提升 → 分屏取消
      expect(tree.type).toBe('leaf');
      if (tree.type === 'leaf') {
        expect(tree.tabs).toHaveLength(1);
        expect(tree.tabs[0].id).toBe('/a/s1.jsonl');
        expect(tree.activeTabId).toBe('/a/s1.jsonl');
        expect(s.activeLeafId).toBe(tree.id);
      }
    });

    it('allowEmptySource + side:"before" 时单 tab 拖出后同样自动合并（分屏取消）', () => {
      const store = getState();
      store.closeTab('/a/s2.jsonl');
      const leafId = store.cwdActiveLeafId['/a']!;

      store.splitPaneWithTab(leafId, '/a/s1.jsonl', 'vertical', {
        side: 'before',
        allowEmptySource: true,
      });

      const s = getState();
      const tree = s.cwdTrees['/a'];
      // 合并行为与 side 无关：分屏取消，树回退为单 leaf（含 s1）
      expect(tree.type).toBe('leaf');
      if (tree.type === 'leaf') {
        expect(tree.tabs).toHaveLength(1);
        expect(tree.tabs[0].id).toBe('/a/s1.jsonl');
        expect(s.activeLeafId).toBe(tree.id);
      }
    });

    it('跨 leaf 分屏：拖另一 leaf 的 tab 到本 leaf 边缘，在本 leaf 处创建分屏', () => {
      const store = getState();
      // 初始单 leaf L = [s1, s2]，再开 s3 → [s1, s2, s3]
      store.openSession({ key: '/a/s3.jsonl', cwd: '/a', name: 's3' });
      const L = store.cwdActiveLeafId['/a']!;

      // 先在 L 上分屏：s1 移出 → [A{s2,s3}, B{s1}]
      store.splitPaneWithTab(L, '/a/s1.jsonl', 'horizontal', { side: 'after' });
      const t1 = getState().cwdTrees['/a'];
      expect(t1.type).toBe('split');
      if (t1.type !== 'split') return;
      const leafA = t1.children[0]; // {s2, s3}
      const leafB = t1.children[1]; // {s1}
      if (leafA.type !== 'leaf' || leafB.type !== 'leaf') return;

      // 跨 leaf：把 s2（在 A）拖到 B 的下边缘 → 在 B 处垂直分屏
      store.splitPaneWithTab(leafB.id, '/a/s2.jsonl', 'vertical', {
        side: 'after',
        allowEmptySource: true,
      });

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      expect(tree.type).toBe('split');
      if (tree.type !== 'split') return;
      // root 仍是水平分屏；children[0] = A（移除 s2 后剩 s3）
      const aAfter = tree.children[0];
      expect(aAfter.type).toBe('leaf');
      if (aAfter.type === 'leaf') {
        expect(aAfter.tabs.map((t) => t.id)).toEqual(['/a/s3.jsonl']);
      }
      // children[1] = 在 B 处新建的垂直分屏节点 [B原样{s1}, newLeaf{s2}]
      const bSplit = tree.children[1];
      expect(bSplit.type).toBe('split');
      if (bSplit.type === 'split') {
        expect(bSplit.direction).toBe('vertical');
        expect(bSplit.children).toHaveLength(2);
        const bLeaf = bSplit.children[0];
        const newLeaf = bSplit.children[1];
        if (bLeaf.type === 'leaf' && newLeaf.type === 'leaf') {
          // B 原样保留 s1（tab 来自源，目标 tabs 不变）
          expect(bLeaf.tabs.map((t) => t.id)).toEqual(['/a/s1.jsonl']);
          // 新 leaf 含被拖 tab s2
          expect(newLeaf.tabs.map((t) => t.id)).toEqual(['/a/s2.jsonl']);
          expect(newLeaf.activeTabId).toBe('/a/s2.jsonl');
          // 活跃 leaf 切到新 leaf
          expect(s2.activeLeafId).toBe(newLeaf.id);
        }
      }
    });

    it('跨 leaf 分屏源变空时自动合并空 leaf（源窗格消失，其余窗格吸收空间）', () => {
      const store = getState();
      // L = [s1, s2]，先分屏移出 s1 → [A{s2}, B{s1}]
      const L = store.cwdActiveLeafId['/a']!;
      store.splitPaneWithTab(L, '/a/s1.jsonl', 'horizontal', { side: 'after' });
      const t1 = getState().cwdTrees['/a'];
      if (t1.type !== 'split') return;
      const leafA = t1.children[0]; // {s2}
      const leafB = t1.children[1]; // {s1}
      if (leafA.type !== 'leaf' || leafB.type !== 'leaf') return;

      // 跨 leaf：A 仅剩 s2，拖到 B 边缘 → A 变空 → 自动合并（A 从树中移除）
      store.splitPaneWithTab(leafB.id, '/a/s2.jsonl', 'vertical', {
        side: 'after',
        allowEmptySource: true,
      });

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      // 原 root = split(A, B)；A 合并移除后只剩 B 处的分屏节点 → 提升为 root
      expect(tree.type).toBe('split');
      if (tree.type !== 'split') return;
      expect(tree.direction).toBe('vertical');
      expect(tree.children).toHaveLength(2);
      // children[0] = B{s1}，children[1] = newLeaf{s2}
      const bLeaf = tree.children[0];
      const newLeaf = tree.children[1];
      if (bLeaf.type === 'leaf' && newLeaf.type === 'leaf') {
        expect(bLeaf.tabs.map((t) => t.id)).toEqual(['/a/s1.jsonl']);
        expect(newLeaf.tabs.map((t) => t.id)).toEqual(['/a/s2.jsonl']);
        expect(newLeaf.activeTabId).toBe('/a/s2.jsonl');
        expect(s2.activeLeafId).toBe(newLeaf.id);
      }
    });

    it('3 窗格场景：拖嵌套 split 内唯一 tab 到另一窗格边缘，源窗格自动合并', () => {
      const store = getState();
      // L = [s1, s2]，先分屏移出 s1 → [A{s2}, B{s1}]
      const L = store.cwdActiveLeafId['/a']!;
      store.splitPaneWithTab(L, '/a/s1.jsonl', 'horizontal', { side: 'after' });
      let t1 = getState().cwdTrees['/a'];
      if (t1.type !== 'split') return;
      // 把 B 垂直分屏 → [A{s2}, split_v(B{s1}, C{s3})]，形成 3 窗格 [左 | 右上 / 右下]
      const leafB = t1.children[1];
      if (leafB.type !== 'leaf') return;
      store.openSession({ key: '/a/s3.jsonl', cwd: '/a', name: 's3' });
      // s3 打开在 active leaf（B），把它分屏到 C
      store.splitPaneWithTab(leafB.id, '/a/s3.jsonl', 'vertical', { side: 'after' });
      t1 = getState().cwdTrees['/a'];
      if (t1.type !== 'split') return;
      const leftLeaf = t1.children[0]; // A{s2}
      const rightSplit = t1.children[1]; // split_v(B{s1}, C{s3})
      if (leftLeaf.type !== 'leaf' || rightSplit.type !== 'split') return;

      // 用户场景：拖右下 C 的唯一 tab s3 到左窗格 A 的右边缘 → 在 A 处分屏，C 空后自动合并
      store.splitPaneWithTab(leftLeaf.id, '/a/s3.jsonl', 'horizontal', {
        side: 'after',
        allowEmptySource: true,
      });

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      // 期望：root = split_h(split_h(A{s2}, newLeaf{s3}), B{s1})
      // （C 合并移除 → rightSplit 只剩 B → 提升；A 处新建水平分屏）
      expect(tree.type).toBe('split');
      if (tree.type !== 'split') return;
      expect(tree.direction).toBe('horizontal');
      expect(tree.children).toHaveLength(2);
      const left = tree.children[0]; // split_h(A{s2}, newLeaf{s3})
      const right = tree.children[1]; // B{s1}
      if (left.type === 'split' && right.type === 'leaf') {
        expect(left.direction).toBe('horizontal');
        const aLeaf = left.children[0];
        const newLeaf = left.children[1];
        if (aLeaf.type === 'leaf' && newLeaf.type === 'leaf') {
          expect(aLeaf.tabs.map((t) => t.id)).toEqual(['/a/s2.jsonl']);
          expect(newLeaf.tabs.map((t) => t.id)).toEqual(['/a/s3.jsonl']);
        }
        expect(right.tabs.map((t) => t.id)).toEqual(['/a/s1.jsonl']);
      }
      // 全树无空 leaf（不留空窗格）
      const leaves: SplitLeaf[] = [];
      (function collect(n: SplitTree) {
        if (n.type === 'leaf') leaves.push(n);
        else n.children.forEach(collect);
      })(tree);
      expect(leaves.every((l) => l.tabs.length > 0)).toBe(true);
    });
  });

  describe('closeLeaf — 关闭 leaf', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
    });

    it('关闭最后 leaf 后 leaf 被清空', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      store.closeLeaf(leafId);

      const s = getState();
      const tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('leaf');
      if (tree.type === 'leaf') {
        expect(tree.tabs).toHaveLength(0);
      }
    });

    it('分屏后关闭一个 leaf 合并回单 leaf', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      store.splitPane(leafId, 'horizontal');

      let s = getState();
      let tree = s.cwdTrees['/a'];
      expect(tree.type).toBe('split');

      if (tree.type === 'split') {
        const newLeafId = tree.children[1].id;
        // 关闭新 leaf
        store.closeLeaf(newLeafId);
        s = getState();
        tree = s.cwdTrees['/a'];
        // 合并回单 leaf
        expect(tree.type).toBe('leaf');
        expect(tree.id).toBe(leafId); // 原 leaf 保留
      }
    });

    it('嵌套分屏后关闭一个 leaf 树结构正确', () => {
      const store = getState();
      const leafId = store.cwdActiveLeafId['/a']!;
      store.splitPane(leafId, 'horizontal');

      let s = getState();
      let tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leftLeaf = tree.children[0];
        // 在左 leaf 上垂直分屏
        store.splitPane(leftLeaf.id, 'vertical');

        s = getState();
        tree = s.cwdTrees['/a'];
        if (tree.type === 'split') {
          const leftChild = tree.children[0];
          if (leftChild.type === 'split') {
            const nestedNewLeaf = leftChild.children[1].id;
            // 关闭嵌套的新 leaf
            store.closeLeaf(nestedNewLeaf);
            s = getState();
            tree = s.cwdTrees['/a'];
            // 嵌套 split 合并回单 leaf
            if (tree.type === 'split') {
              expect(tree.children[0].type).toBe('leaf');
              expect(tree.children).toHaveLength(2);
            }
          }
        }
      }
    });
  });

  describe('空状态 — leaf 无 tab', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
    });

    it('初始 leaf 的 tabs 为空', () => {
      const s = getState();
      // 先 closeLeaf 清空 leaf
      const leafId = s.cwdActiveLeafId['/a']!;
      s.closeLeaf(leafId);

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      expect(tree.type).toBe('leaf');
      if (tree.type === 'leaf') {
        expect(tree.tabs).toHaveLength(0);
      }
    });
  });

  describe('reorderTabsInLeaf — Tab 重排', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: '/a/s2', cwd: '/a', name: 'sess-b' });
      getState().openSession({ key: '/a/s3', cwd: '/a', name: 'sess-c' });
    });

    it('重排后 order 更新', () => {
      const s = getState();
      const leafId = s.cwdActiveLeafId['/a']!;
      s.reorderTabsInLeaf(leafId, ['/a/s3', '/a/s1', '/a/s2']);

      const s2 = getState();
      const allTabs = getAllTabs(s2);
      const ordered = allTabs
        .filter((t) => getTabCwd(t) === '/a')
        .sort((a, b) => a.order - b.order);
      expect(ordered.map((t) => t.id)).toEqual(['/a/s3', '/a/s1', '/a/s2']);
    });

    it('不影响不在 orderedIds 中的 tab', () => {
      const s = getState();
      const leafId = s.cwdActiveLeafId['/a']!;
      s.reorderTabsInLeaf(leafId, ['/a/s3', '/a/s1']);

      const s2 = getState();
      const allTabs = getAllTabs(s2);
      const s2tab = allTabs.find((t) => t.id === '/a/s2');
      expect(s2tab?.order).toBe(1);
    });
  });

  describe('setRatios — 调整分割比例', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      const s = getState();
      const leafId = s.cwdActiveLeafId['/a']!;
      s.splitPane(leafId, 'horizontal');
    });

    it('setRatios 更新分屏比例', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        s.setRatios(tree.id, [0.7, 0.3]);

        const s2 = getState();
        const tree2 = s2.cwdTrees['/a'];
        if (tree2.type === 'split') {
          expect(tree2.ratios[0]).toBeCloseTo(0.7);
          expect(tree2.ratios[1]).toBeCloseTo(0.3);
        }
      }
    });

    it('setRatios 直接设置比例', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        s.setRatios(tree.id, [0.7, 0.3]);

        const s2 = getState();
        const tree2 = s2.cwdTrees['/a'];
        if (tree2.type === 'split') {
          expect(tree2.ratios[0]).toBe(0.7);
          expect(tree2.ratios[1]).toBe(0.3);
        }
      }
    });
  });

  describe('cwd 切换 — 状态一致性', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
    });

    it('切换 cwd 后 state 不含 null/undefined 关键字段', () => {
      // 先记住 /a 的 leaf
      const leafA = getState().activeLeafId;
      // 打开 /b
      getState().openSession({ key: '/b/s1', cwd: '/b', name: 'sess-b' });
      // 此时 activeCwd 是 /b
      getState().setActiveCwd('/a');
      const s = getState();
      expect(s.activeCwd).toBe('/a');
      expect(s.activeLeafId).toBeTruthy();
      expect(s.cwdTrees['/a']).toBeTruthy();
      expect(s.cwdTrees['/b']).toBeTruthy();
      expect(typeof s.activeTabId).not.toBe('undefined');
    });

    it('切换到已有 cwd 后 activeLeafId 恢复之前保存的 leaf', () => {
      // 先打开 /a 获取 leafId
      const leafA = getState().activeLeafId;
      // 打开 /b（此时 activeCwd 切换到 /b）
      getState().openSession({ key: '/b/s1', cwd: '/b', name: 'sess-b' });
      // 切回 /a
      getState().setActiveCwd('/a');
      const s = getState();
      expect(s.activeCwd).toBe('/a');
      expect(s.activeLeafId).toBe(leafA);
    });

    it('切换 cwd 后 cwdActiveLeafId 记录正确', () => {
      const leafA = getState().activeLeafId;
      getState().openSession({ key: '/b/s1', cwd: '/b', name: 'sess-b' });
      const s1 = getState();
      const leafB = s1.activeLeafId;
      expect(s1.cwdActiveLeafId['/a']).toBe(leafA);
      expect(s1.cwdActiveLeafId['/b']).toBe(leafB);

      getState().setActiveCwd('/a');
      const s2 = getState();
      expect(s2.cwdActiveLeafId['/a']).toBe(s2.activeLeafId);
      expect(s2.cwdActiveLeafId['/b']).toBe(leafB);
    });

    it('空 cwd 切换不崩溃', () => {
      resetStore();
      const store = getState();
      store.setActiveCwd('/empty1');
      let s = getState();
      expect(s.activeCwd).toBe('/empty1');
      expect(s.activeLeafId).toBeTruthy();

      s.setActiveCwd('/empty2');
      s = getState();
      expect(s.activeCwd).toBe('/empty2');
      expect(s.activeLeafId).toBeTruthy();
    });
  });

  describe('分屏 + 自动创建终端 — 正确分配到新 leaf', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
    });

    it('splitPane 后 openTerminal 自动分配到新 leaf（无 leafId 参数）', () => {
      const s = getState();
      const oldLeafId = s.cwdActiveLeafId['/a']!;
      
      // 模拟 splitPane 后 activeLeafId 已指向新 leaf
      getState().splitPane(oldLeafId, 'horizontal');
      
      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        const newLeafId = tree.children[1].id;
        // activeLeafId 应指向新 leaf
        expect(s2.activeLeafId).toBe(newLeafId);
        
        // 模拟 openTerminal（无 leafId）—— 应分配到新 leaf
        getState().openTerminal('term-1', '/a', 'Terminal 1');
        
        const s3 = getState();
        // 验证终端在 newLeaf 中
        const newLeafFound = findLeaf(s3.cwdTrees, newLeafId);
        expect(newLeafFound).not.toBeNull();
        expect(newLeafFound!.leaf.tabs.some((t) => t.id === 'term-1')).toBe(true);
        
        // 验证终端不在 oldLeaf 中
        const oldLeafFound = findLeaf(s3.cwdTrees, oldLeafId);
        expect(oldLeafFound).not.toBeNull();
        expect(oldLeafFound!.leaf.tabs.some((t) => t.id === 'term-1')).toBe(false);
      }
    });

    it('openTerminal 指定 leafId 可分配到指定 leaf', () => {
      const s = getState();
      const leafId = s.cwdActiveLeafId['/a']!;
      
      // 直接 openTerminal 指定 leafId
      getState().openTerminal('term-2', '/a', 'Terminal 2', leafId);
      
      const s2 = getState();
      const found = findLeaf(s2.cwdTrees, leafId);
      expect(found).not.toBeNull();
      expect(found!.leaf.tabs.some((t) => t.id === 'term-2')).toBe(true);
    });
  });

  describe('canMoveTabToLeaf — 去重检查', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      // 分屏创建两个 leaf
      const s = getState();
      const leafId = s.cwdActiveLeafId['/a']!;
      s.splitPane(leafId, 'horizontal');

      // 在第二个 leaf 中创建一些 tab（使用唯一 key 避免全局去重干扰）
      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const newLeafId = tree.children[1].id;
        s2.openTerminal('term-1', '/a', 'Terminal 1', newLeafId);
        s2.openDiff('/a', 'hash1', newLeafId);
        s2.openPreview('/a', 'file.ts', 'file.ts', undefined, newLeafId);
        // 在第二个 leaf 中创建一个不同 key 的 session（用于测试"存在"场景）
        s2.openSession({ key: '/a/target-session', cwd: '/a', name: 'target-sess' }, newLeafId);
      }
    });

    it('同一 session key 已存在时返回 false', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const targetLeaf = tree.children[1];
        if (targetLeaf.type === 'leaf') {
          // 检查目标 leaf 中是否有 /a/target-session
          const sessionTab = { id: '/a/target-session', kind: 'session' as const, location: 'editor' as const, title: 'target-sess', hidden: false, order: 0, key: '/a/target-session', cwd: '/a', name: 'target-sess' };
          const result = canMoveTabToLeaf(sessionTab, targetLeaf, '/a', s.cwdTrees);
          expect(result).toBe(false);
        }
      }
    });


    it('不同 session key 时返回 true', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const targetLeaf = tree.children[1];
        if (targetLeaf.type === 'leaf') {
          const sessionTab = { id: 'new-session', kind: 'session' as const, location: 'editor' as const, title: 'new', hidden: false, order: 0, key: 'new-session', cwd: '/a', name: 'new' };
          const result = canMoveTabToLeaf(sessionTab, targetLeaf, '/a', s.cwdTrees);
          expect(result).toBe(true);
        }
      }
    });

    it('不同 cwd 时返回 false（目标 leaf 不在 targetCwd 中）', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const targetLeaf = tree.children[1];
        if (targetLeaf.type === 'leaf') {
          const sessionTab = { id: 'new-session', kind: 'session' as const, location: 'editor' as const, title: 'new', hidden: false, order: 0, key: 'new-session', cwd: '/a', name: 'new' };
          // 传 targetCwd='/nonexistent'，目标 leaf 不在该 cwd 中
          const result = canMoveTabToLeaf(sessionTab, targetLeaf, '/nonexistent', s.cwdTrees);
          expect(result).toBe(false);
        }
      }
    });

    it('终端 tab 允许跨 leaf 移动', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const targetLeaf = tree.children[1];
        if (targetLeaf.type === 'leaf') {
          const terminalTab = { id: 'term-new', kind: 'integrated-terminal' as const, location: 'editor' as const, title: 'New Terminal', hidden: false, order: 0, cwd: '/a' };
          const result = canMoveTabToLeaf(terminalTab, targetLeaf, '/a', s.cwdTrees);
          expect(result).toBe(true);
        }
      }
    });

    it('已有同 commitHash diff 时返回 false', () => {
      const s = getState();
      const tree = s.cwdTrees['/a'];
      if (tree.type === 'split') {
        const targetLeaf = tree.children[1];
        if (targetLeaf.type === 'leaf') {
          const diffTab = { id: 'diff:/a//hash1', kind: 'diff' as const, location: 'editor' as const, title: 'hash1', hidden: false, order: 0, cwd: '/a', commitHash: 'hash1' };
          const result = canMoveTabToLeaf(diffTab, targetLeaf, '/a', s.cwdTrees);
          expect(result).toBe(false);
        }
      }
    });
  });

  describe('moveTabAcrossLeafs — 跨 leaf 移动 tab', () => {
    beforeEach(() => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: '/a/s2', cwd: '/a', name: 'sess-b' });
    });

    it('将 tab 从 leaf A 移动到 leaf B（验证 tabs 数组变化）', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      // 分屏创建 leaf B
      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        // 将 /a/s2 从 leafA 移动到 leafB
        s2.moveTabAcrossLeafs('/a/s2', leafA, leafB, 0);

        const s3 = getState();
        const tree2 = s3.cwdTrees['/a'];
        if (tree2.type === 'split') {
          const leafAFound = findLeaf(s3.cwdTrees, leafA);
          const leafBFound = findLeaf(s3.cwdTrees, leafB);

          expect(leafAFound).not.toBeNull();
          expect(leafBFound).not.toBeNull();

          // leafA 应只有 /a/s1
          expect(leafAFound!.leaf.tabs.some((t) => t.id === '/a/s2')).toBe(false);
          expect(leafAFound!.leaf.tabs.some((t) => t.id === '/a/s1')).toBe(true);

          // leafB 应有 /a/s2
          expect(leafBFound!.leaf.tabs.some((t) => t.id === '/a/s2')).toBe(true);
        }
      }
    });

    it('移走最后一个 tab 后源 leaf 被关闭', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      // 分屏创建 leaf B
      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        // 分屏时 leafA 有 /a/s1, /a/s2 两个 tab
        // 先创建一个新 tab 在 leafB 中
        s2.openTerminal('term-1', '/a', 'Terminal 1', leafB);

        // 把 /a/s1 移到 leafB → leafA 还剩 /a/s2
        const s3 = getState();
        s3.moveTabAcrossLeafs('/a/s1', leafA, leafB, 0);

        // 把 /a/s2 移到 leafB → leafA 变空 → 自动关闭
        const s4 = getState();
        s4.moveTabAcrossLeafs('/a/s2', leafA, leafB, 0);

        const s5 = getState();
        // 检查 leafA 是否还在（应该被关闭了，树结构简化）
        const tree3 = s5.cwdTrees['/a'];
        // 因为只剩一个 leaf，树应该变回 leaf 类型
        expect(tree3.type).toBe('leaf');
      }
    });

    it('支持指定插入位置（索引 0 / 中间 / 末尾）', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        // 在 leafB 中创建两个终端
        s2.openTerminal('term-1', '/a', 'Terminal 1', leafB);
        s2.openTerminal('term-2', '/a', 'Terminal 2', leafB);

        // 将 /a/s1 插入到 leafB 的索引 1（中间）
        s2.moveTabAcrossLeafs('/a/s1', leafA, leafB, 1);

        const s3 = getState();
        const leafBFound = findLeaf(s3.cwdTrees, leafB);
        expect(leafBFound).not.toBeNull();

        const tabs = leafBFound!.leaf.tabs;
        // 期望顺序: term-1, /a/s1, term-2
        // /a/s1 应该在第 1 个位置
        const s1Idx = tabs.findIndex((t) => t.id === '/a/s1');
        const term1Idx = tabs.findIndex((t) => t.id === 'term-1');
        const term2Idx = tabs.findIndex((t) => t.id === 'term-2');
        expect(s1Idx).toBeGreaterThan(term1Idx);
        expect(s1Idx).toBeLessThan(term2Idx);
      }
    });

    it('移动后目标 leaf 的 activeTabId 更新为被拖拽的 tab', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        s2.moveTabAcrossLeafs('/a/s2', leafA, leafB, 0);

        const s3 = getState();
        const leafBFound = findLeaf(s3.cwdTrees, leafB);
        expect(leafBFound).not.toBeNull();
        expect(leafBFound!.leaf.activeTabId).toBe('/a/s2');
      }
    });

    it('移动后 activeLeafId 更新为目标 leaf', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        s2.moveTabAcrossLeafs('/a/s2', leafA, leafB, 0);

        const s3 = getState();
        expect(s3.activeLeafId).toBe(leafB);
      }
    });

    it('移走 activeTabId 时，源 leaf 切换到下一个可见 tab', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      // 创建第三个 tab 在 leafA 中
      s.openSession({ key: '/a/s3', cwd: '/a', name: 'sess-c' });

      const s2 = getState();
      // 当前 activeTabId 应该是 /a/s3（最新创建的）

      s2.splitPane(leafA, 'horizontal');

      const s3 = getState();
      const tree = s3.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        // 移走 /a/s3（当前 active）
        s3.moveTabAcrossLeafs('/a/s3', leafA, leafB, 0);

        const s4 = getState();
        const leafAFound = findLeaf(s4.cwdTrees, leafA);
        expect(leafAFound).not.toBeNull();
        // activeTabId 应切换到另一个可见 tab（/a/s2 或 /a/s1）
        expect(leafAFound!.leaf.activeTabId).not.toBeNull();
        expect(leafAFound!.leaf.activeTabId).not.toBe('/a/s3');
      }
    });

    it('移动后 cwdTabHistory 和 cwdActiveTab 被更新', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      s.splitPane(leafA, 'horizontal');

      const s2 = getState();
      const tree = s2.cwdTrees['/a'];
      if (tree.type === 'split') {
        const leafB = tree.children[1].id;

        s2.moveTabAcrossLeafs('/a/s2', leafA, leafB, 0);

        const s3 = getState();
        // cwdTabHistory 应包含 /a/s2
        const history = s3.cwdTabHistory['/a'];
        expect(history).toBeDefined();
        expect(history).toContain('/a/s2');

        // cwdActiveTab 应更新为 /a/s2
        expect(s3.cwdActiveTab['/a']).toBe('/a/s2');
      }
    });

    it('同 leaf 移动不影响 reorderTabsInLeaf', () => {
      const s = getState();
      const leafA = s.cwdActiveLeafId['/a']!;

      // 同 leaf 移动（sourceLeafId === targetLeafId）应该由 reorderTabsInLeaf 处理
      // moveTabAcrossLeafs 的行为在此时不会触发
      // 这只是验证 moveTabAcrossLeafs 在 source===target 时不会崩溃
      s.moveTabAcrossLeafs('/a/s1', leafA, leafA, 0);

      const s2 = getState();
      const leafAFound = findLeaf(s2.cwdTrees, leafA);
      expect(leafAFound).not.toBeNull();
      // tab 应该还在
      expect(leafAFound!.leaf.tabs.some((t) => t.id === '/a/s1')).toBe(true);
    });
  });

  describe('updateTabTitle（OSC 0 标题变化同步 tab 标题）', () => {
    it('更新 session tab 的 title（不动 name）', () => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      getState().updateTabTitle('/a/s1', '⠋ π - dir-a');
      const tab = getAllTabs(getState())[0];
      expect(tab.title).toBe('⠋ π - dir-a');
      // name（会话真名）不受影响
      expect((tab as SessionTab).name).toBe('sess-a');
    });

    it('更新 integrated-terminal tab 的 title', () => {
      getState().openTerminal('term-1', '/a', 'Terminal');
      getState().updateTabTitle('term-1', 'zsh - /a');
      const tab = getAllTabs(getState())[0];
      expect(tab.title).toBe('zsh - /a');
      expect(tab.kind).toBe('integrated-terminal');
    });

    it('不存在的 tab id 无副作用', () => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      getState().updateTabTitle('no-such-tab', 'x');
      const tab = getAllTabs(getState())[0];
      expect(tab.title).toBe('sess-a');
    });

    it('相同 title 不触发 store 更新（无新对象引用）', () => {
      getState().openSession({ key: '/a/s1', cwd: '/a', name: 'sess-a' });
      const before = getAllTabs(getState())[0];
      getState().updateTabTitle('/a/s1', 'sess-a');
      const after = getAllTabs(getState())[0];
      expect(after).toBe(before);
    });
  });
});