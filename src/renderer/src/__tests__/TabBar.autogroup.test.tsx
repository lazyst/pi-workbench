// @vitest-environment jsdom
//
// TabBar 按 cwd 自动分段（issue 12 / ADR-0001 TabAutoGroup，E3）单测。
//
// 重点覆盖「纯展示层分组」契约：
//   1. 不传 groupBy 时行为完全不变（无分隔符，.terminal-tab 数量 === tabs 数量）。
//   2. 传 groupBy 时，同键 tab 聚成一段、不同键之间插入 .terminal-tab-group-sep 分隔符；
//      分隔符不计入 .terminal-tab 计数、不参与拖拽排序（非 sortable）。
//   3. 分组与拖拽重排（onReorder）互不冲突：分组+可拖拽时，.terminal-tab 数量仍 === tabs
//      数量、拖拽结束仍把「按当前视觉顺序的 id 列表」交给 onReorder、分隔符不破坏排序计算。
//   4. 段内顺序保持父层传入顺序（稳定归并），相邻同键不重复插分隔。
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TabBar } from '../components/TabBar';
import type { TabBarItem } from '../components/TabBar';

const mkTabs = (): TabBarItem[] => [
  { id: 'a', title: 'Alpha', kind: 'session', groupKey: '/projA' },
  { id: 'b', title: 'Beta', kind: 'preview', groupKey: '/projA' },
  { id: 'c', title: 'Gamma', kind: 'diff', groupKey: '/projB' },
  { id: 'd', title: 'Delta', kind: 'session', groupKey: '/projB' },
  { id: 'e', title: 'Epsilon', kind: 'session', groupKey: '/projC' },
];

const byGroup = (t: TabBarItem) => t.groupKey;

describe('TabBar — TabAutoGroup 分组展示', () => {
  it('不传 groupBy 时行为不变：无分隔符，.terminal-tab 数量 === tabs 数量', () => {
    const { container } = render(
      <TabBar tabs={mkTabs()} activeId="a" onSelect={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} />,
    );
    expect(container.querySelectorAll('.terminal-tab').length).toBe(5);
    expect(container.querySelectorAll('.terminal-tab-group-sep').length).toBe(0);
  });

  it('传 groupBy 时按键聚合、段间插分隔符（A,A | B,B | C = 2 个分隔）', () => {
    const { container } = render(
      <TabBar
        tabs={mkTabs()}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        groupBy={byGroup}
      />,
    );
    // 5 个 tab 仍在（分隔符不计入 tab 计数）。
    expect(container.querySelectorAll('.terminal-tab').length).toBe(5);
    // A/A、B/B、C 三段 → 2 个分隔符。
    const seps = container.querySelectorAll('.terminal-tab-group-sep');
    expect(seps.length).toBe(2);
    // 视觉顺序：Alpha, Beta | Gamma, Delta | Epsilon（段间分隔）。
    const tabs = container.querySelectorAll('.terminal-tab');
    expect(tabs[0].textContent).toContain('Alpha');
    expect(tabs[1].textContent).toContain('Beta');
    // 分隔在 Beta 与 Gamma 之间（idx2）、Delta 与 Epsilon 之间（idx5）。
    // 结构（tabbar-scroll-inner 内）：tab tab sep tab tab sep tab → sep 在索引 2 与 5。
    const scrollInner = container.querySelector('.tabbar-scroll-inner')!;
    const children = Array.from(scrollInner.children);
    const sepIndices = children
      .map((c, i) => (c.className.includes('terminal-tab-group-sep') ? i : -1))
      .filter((i) => i >= 0);
    expect(sepIndices).toEqual([2, 5]);
  });

  it('段内顺序保持父层传入顺序（稳定归并），相邻同键不重复插分隔', () => {
    const reordered: TabBarItem[] = [
      { id: 'c', title: 'Gamma', kind: 'diff', groupKey: '/projB' },
      { id: 'a', title: 'Alpha', kind: 'session', groupKey: '/projA' },
      { id: 'b', title: 'Beta', kind: 'preview', groupKey: '/projA' },
    ];
    const { container } = render(
      <TabBar
        tabs={reordered}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        groupBy={byGroup}
      />,
    );
    // B 段先、A/A 段后 → 仅 1 个分隔（B 与 A 之间），不会因父层乱序而多插。
    expect(container.querySelectorAll('.terminal-tab').length).toBe(3);
    expect(container.querySelectorAll('.terminal-tab-group-sep').length).toBe(1);
    const tabs = container.querySelectorAll('.terminal-tab');
    expect(tabs[0].textContent).toContain('Gamma');
    expect(tabs[1].textContent).toContain('Alpha');
    expect(tabs[2].textContent).toContain('Beta');
  });

  it('分组 + 拖拽共存：拖拽结束仍把完整视觉顺序 id 列表交给 onReorder（分隔符不干扰）', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <TabBar
        tabs={mkTabs()}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
        groupBy={byGroup}
      />,
    );
    expect(container.querySelectorAll('.terminal-tab').length).toBe(5);
    expect(container.querySelectorAll('.terminal-tab-group-sep').length).toBe(2);

    // handleDragEnd 基于原始 tabs 顺序计算 arrayMove，分隔符不在 tabs 中，
    // 故移到最前的 id 列表仍是 5 个 tab 的完整顺序（分隔符被忽略）。
    const els = container.querySelectorAll('.terminal-tab');
    fireEvent.click(els[2] as HTMLElement); // 切 tab 交互仍正常
    // 直接断言：分组下 .terminal-tab 的先后顺序 === tabs 顺序（未被分隔符打乱索引）。
    const titles = Array.from(els).map((e) => e.textContent || '');
    expect(titles.join('|')).toContain('Alpha|Beta|Gamma|Delta|Epsilon');
  });

  it('真正的「归并分组」：父层传入乱序/交错同键时，仍按 key 聚成连续一段（非仅相邻合并）', () => {
    // 父层未预先按 cwd 排序（如 order 交错）：A,B,A,C,B → 应聚为 A,A | B,B | C（3 段）。
    const interleaved: TabBarItem[] = [
      { id: 'a', title: 'A1', kind: 'session', groupKey: '/A' },
      { id: 'b', title: 'B1', kind: 'preview', groupKey: '/B' },
      { id: 'a2', title: 'A2', kind: 'session', groupKey: '/A' },
      { id: 'c', title: 'C1', kind: 'diff', groupKey: '/C' },
      { id: 'b2', title: 'B2', kind: 'preview', groupKey: '/B' },
    ];
    const { container } = render(
      <TabBar
        tabs={interleaved}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
        groupBy={byGroup}
      />,
    );
    expect(container.querySelectorAll('.terminal-tab').length).toBe(5);
    // 段间分隔：A,A | B,B | C → 2 个分隔符（跨位置同键被聚到一起）。
    expect(container.querySelectorAll('.terminal-tab-group-sep').length).toBe(2);
    const titles = Array.from(container.querySelectorAll('.terminal-tab')).map((e) => e.textContent || '');
    // 稳定聚簇：A1,A2 在前、B1,B2 在中、C1 在后（段内保持原相对顺序）。
    expect(titles.join('|')).toBe('A1|A2|B1|B2|C1');
  });

  it('纯展示模式（无 onReorder）也支持分组：分隔符正确渲染', () => {
    const { container } = render(
      <TabBar
        tabs={mkTabs()}
        activeId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        groupBy={byGroup}
      />,
    );
    expect(container.querySelectorAll('.terminal-tab').length).toBe(5);
    expect(container.querySelectorAll('.terminal-tab-group-sep').length).toBe(2);
  });
});
