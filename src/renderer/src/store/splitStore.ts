// 分屏状态管理（SplitStore）
//
// 替代原 tabStore。每个工作目录（cwd）拥有独立的分屏树（SplitTree），
// 每个 SplitLeaf 持有自己的 tabs 和 activeTabId。切换 cwd 时中间区整体替换。
//
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），非活跃 cwd 用 opacity:0 隐藏。
//
// 数据模型：
//   SplitTree = SplitLeaf | SplitNode
//   SplitLeaf = { type: 'leaf', id, tabs, activeTabId }
//   SplitNode = { type: 'split', id, direction, ratios, children }

import { create } from 'zustand';
import type { IntegratedTerminalInfo } from '../types';
import { capturePaneScrollState } from '../components/paneManager';

// ── Tab 类型（同原 tabStore，保持向后兼容） ──

export type TabKind = 'session' | 'preview' | 'diff' | 'integrated-terminal' | 'session-content';

export type TabLocation = 'editor';

export interface BaseTab {
  id: string;
  kind: TabKind;
  location: TabLocation;
  title: string;
  hidden: boolean;
  order: number;
}

export interface SessionTab extends BaseTab {
  kind: 'session';
  location: 'editor';
  key: string;
  cwd: string;
  name: string;
}

export interface PreviewTab extends BaseTab {
  kind: 'preview';
  location: 'editor';
  root: string;
  path: string;
}

export interface DiffTab extends BaseTab {
  kind: 'diff';
  location: 'editor';
  cwd: string;
  commitHash: string | null;
  /** 该提交中的特定文件路径（null 时显示全量 diff）。 */
  filePath?: string | null;
}

export interface IntegratedTerminalTab extends BaseTab {
  kind: 'integrated-terminal';
  location: 'editor';
  cwd: string;
}

export interface SessionContentTab extends BaseTab {
  kind: 'session-content';
  location: 'editor';
  sessionKey: string;
  sessionName: string;
  cwd: string;
}

export type Tab = SessionTab | PreviewTab | DiffTab | IntegratedTerminalTab | SessionContentTab;

// ── 分屏数据模型 ──

export type SplitDirection = 'horizontal' | 'vertical';

export interface SplitLeaf {
  type: 'leaf';
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

export interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratios: number[];
  children: SplitChild[];
}

export type SplitChild = SplitLeaf | SplitNode;
export type SplitTree = SplitLeaf | SplitNode;

/** Tab 在分屏树中的位置。 */
export interface TabLoc {
  cwd: string;
  leaf: SplitLeaf;
  tab: Tab;
}

// ── 辅助函数 ──

/** 取 tab 所属的工作目录（cwd）。preview 的 cwd 是 root，其余直接用 cwd 字段。 */
export function getTabCwd(tab: Tab): string {
  switch (tab.kind) {
    case 'session':
    case 'integrated-terminal':
    case 'diff':
    case 'session-content':
      return tab.cwd;
    case 'preview':
      return tab.root;
  }
}

/** 过滤出属于指定 cwd 的可见 tab（按 order 排序）。 */
export function cwdVisibleTabs(tabs: Tab[], cwd: string): Tab[] {
  return tabs
    .filter((t) => !t.hidden && getTabCwd(t) === cwd)
    .sort((a, b) => a.order - b.order);
}

/** 生成唯一 ID。 */
let _idCounter = 0;
function uid(): string {
  return `split-${++_idCounter}`;
}

/** 创建初始 SplitLeaf。 */
function createLeaf(): SplitLeaf {
  return { type: 'leaf', id: uid(), tabs: [], activeTabId: null };
}

/** 创建初始 cwd 分屏树（单 leaf）。 */
function createTree(): SplitTree {
  return createLeaf();
}

/** 为新增 tab 计算下一个 order。 */
function nextOrder(tabs: Tab[]): number {
  if (tabs.length === 0) return 0;
  return tabs.reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

/** 在 tabs 中找指定 cwd 下第一个可见 tab；无则返回 null。 */
function firstVisibleInCwd(tabs: Tab[], cwd: string): string | null {
  const t = tabs.find((t) => !t.hidden && getTabCwd(t) === cwd);
  return t ? t.id : null;
}

/**
 * 更新 cwdActiveTab 的工具函数。
 * 先安全复制，清除旧值为无效 id 的条目（已被删除的 tab），再设置新值。
 */
function updateCwdActiveTab(
  prev: Record<string, string | null>,
  tabs: Tab[],
  cwd: string,
  tabId: string | null,
): Record<string, string | null> {
  const next: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(prev)) {
    if (v !== null && tabs.some((t) => t.id === v)) {
      next[k] = v;
    }
  }
  next[cwd] = tabId;
  return next;
}

/** 把 cwd 加入 cwdOrder（若还不存在）。 */
function ensureCwdOrder(order: string[], cwd: string): string[] {
  return order.includes(cwd) ? order : [...order, cwd];
}

/**
 * 将 tabId 加入 cwd 的访问历史（最近在末尾），去重。
 */
function pushTabHistory(
  history: Record<string, string[]>,
  cwd: string,
  tabId: string,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(history)) {
    next[k] = [...v];
  }
  const list = next[cwd] ?? [];
  next[cwd] = [...list.filter((id) => id !== tabId), tabId];
  return next;
}

/**
 * 从 cwd 的访问历史末尾往前找，返回第一个仍然可见的 tab id（排除 excludeId）。
 * 无匹配则返回 null。
 */
function previousTabInHistory(
  history: Record<string, string[]>,
  tabs: Tab[],
  cwd: string,
  excludeId: string,
): string | null {
  const list = history[cwd];
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i];
    if (id === excludeId) continue;
    const tab = tabs.find((t) => t.id === id);
    if (tab && !tab.hidden && getTabCwd(tab) === cwd) return id;
  }
  return null;
}

/**
 * 清理所有 cwd 历史中已不存在的 tab id，返回新对象。
 */
function cleanTabHistory(
  history: Record<string, string[]>,
  tabs: Tab[],
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  const validIds = new Set(tabs.map((t) => t.id));
  for (const [k, v] of Object.entries(history)) {
    const filtered = v.filter((id) => validIds.has(id));
    if (filtered.length > 0) next[k] = filtered;
  }
  return next;
}

/** 关闭 tab 后，从剩余 tab 中选出下一个激活的 tab。纯函数。 */
export function selectNextTabOnClose(
  remaining: Tab[],
  removedId: string,
  removedCwd: string,
  activeTabId: string | null,
  activeCwd: string | null,
  cwdActiveTab: Record<string, string | null>,
  cwdTabHistory: Record<string, string[]>,
): { activeTabId: string | null; cwdActiveTab: Record<string, string | null>; cwdTabHistory: Record<string, string[]> } | null {
  if (remaining.length === 0) {
    return { activeTabId: null, cwdActiveTab: {}, cwdTabHistory: {} };
  }

  if (activeTabId === removedId) {
    const cwd = activeCwd ?? removedCwd;
    const nextId =
      previousTabInHistory(cwdTabHistory, remaining, cwd, removedId) ??
      firstVisibleInCwd(remaining, cwd);
    return {
      activeTabId: nextId,
      cwdActiveTab: updateCwdActiveTab(cwdActiveTab, remaining, cwd, nextId),
      cwdTabHistory: nextId
        ? pushTabHistory(cwdTabHistory, cwd, nextId)
        : cleanTabHistory(cwdTabHistory, remaining),
    };
  }

  if (cwdActiveTab[removedCwd] === removedId) {
    const nextId = firstVisibleInCwd(remaining, removedCwd);
    return {
      activeTabId,
      cwdActiveTab: updateCwdActiveTab(cwdActiveTab, remaining, removedCwd, nextId),
      cwdTabHistory: cleanTabHistory(cwdTabHistory, remaining),
    };
  }

  return {
    activeTabId,
    cwdActiveTab,
    cwdTabHistory: cleanTabHistory(cwdTabHistory, remaining),
  };
}

/**
 * 保存当前 activeCwd 下所有终端 pane 的滚动位置。
 */
function captureOldCwdScrollStates(tabs: Tab[], activeCwd: string | null): void {
  if (!activeCwd) return;
  for (const t of tabs) {
    const tCwd = getTabCwd(t);
    if (tCwd !== activeCwd) continue;
    if (t.kind !== 'session' && t.kind !== 'integrated-terminal') continue;
    capturePaneScrollState(t.id);
  }
}

// ── 树遍历辅助函数 ──

/** 遍历树中的所有 leaf。 */
function* iterateLeaves(node: SplitChild): Generator<SplitLeaf> {
  if (node.type === 'leaf') {
    yield node;
  } else {
    for (const child of node.children) {
      yield* iterateLeaves(child);
    }
  }
}

/** 遍历树中的所有 leaf（从 tree 根开始）。 */
function* allLeaves(tree: SplitTree): Generator<SplitLeaf> {
  yield* iterateLeaves(tree);
}

/** 遍历所有 cwd 的所有 leaf。 */
function* allLeavesAcrossCwds(cwdTrees: Record<string, SplitTree>): Generator<{ cwd: string; leaf: SplitLeaf }> {
  for (const [cwd, tree] of Object.entries(cwdTrees)) {
    for (const leaf of allLeaves(tree)) {
      yield { cwd, leaf };
    }
  }
}

/** 收集所有 cwd 的所有 leaf 的所有 tab。 */
function collectAllTabs(cwdTrees: Record<string, SplitTree>): Tab[] {
  const result: Tab[] = [];
  for (const { leaf } of allLeavesAcrossCwds(cwdTrees)) {
    result.push(...leaf.tabs);
  }
  return result;
}

// ── 查找辅助函数 ──

/** 按 tabId 查找 tab 所在位置。 */
export function findTabById(cwdTrees: Record<string, SplitTree>, tabId: string): TabLoc | null {
  for (const { cwd, leaf } of allLeavesAcrossCwds(cwdTrees)) {
    const tab = leaf.tabs.find((t) => t.id === tabId);
    if (tab) return { cwd, leaf, tab };
  }
  return null;
}

/** 按 session key 查找 tab。 */
export function findTabByKey(cwdTrees: Record<string, SplitTree>, key: string): TabLoc | null {
  for (const { cwd, leaf } of allLeavesAcrossCwds(cwdTrees)) {
    const tab = leaf.tabs.find((t) => t.kind === 'session' && (t as SessionTab).key === key);
    if (tab) return { cwd, leaf, tab };
  }
  return null;
}

/** 按终端 id 查找 tab。 */
export function findTabByTerminalId(cwdTrees: Record<string, SplitTree>, id: string): TabLoc | null {
  for (const { cwd, leaf } of allLeavesAcrossCwds(cwdTrees)) {
    const tab = leaf.tabs.find((t) => t.kind === 'integrated-terminal' && t.id === id);
    if (tab) return { cwd, leaf, tab };
  }
  return null;
}

/**
 * 判断指定 tab 是否可以移动到目标 leaf（去重 + 同 cwd 检查）。
 * 导出供 SplitPaneDragProvider 使用。
 */
export function canMoveTabToLeaf(
  tab: Tab,
  targetLeaf: SplitLeaf,
  targetCwd: string,
  cwdTrees: Record<string, SplitTree>,
): boolean {
  // 检查 cwd 隔离：源 tab 的 cwd 必须与目标 leaf 的 cwd 一致
  // 通过 findLeaf 确认 targetLeaf 属于 targetCwd
  const targetFound = findLeaf(cwdTrees, targetLeaf.id);
  if (!targetFound || targetFound.cwd !== targetCwd) return false;

  switch (tab.kind) {
    case 'session': {
      const sessionKey = (tab as SessionTab).key;
      return !targetLeaf.tabs.some(
        (t) => t.kind === 'session' && (t as SessionTab).key === sessionKey,
      );
    }
    case 'diff': {
      const commitHash = (tab as DiffTab).commitHash;
      return !targetLeaf.tabs.some(
        (t) => t.kind === 'diff' && (t as DiffTab).commitHash === commitHash,
      );
    }
    case 'preview': {
      const path = (tab as PreviewTab).path;
      return !targetLeaf.tabs.some(
        (t) => t.kind === 'preview' && (t as PreviewTab).path === path,
      );
    }
    case 'integrated-terminal': {
      // 防御性检查：终端 id 全局唯一，但确保目标 leaf 没有同 id 终端
      return !targetLeaf.tabs.some(
        (t) => t.kind === 'integrated-terminal' && t.id === tab.id,
      );
    }
    case 'session-content': {
      const sessionKey = (tab as SessionContentTab).sessionKey;
      return !targetLeaf.tabs.some(
        (t) => t.kind === 'session-content' && (t as SessionContentTab).sessionKey === sessionKey,
      );
    }
    default:
      return true;
  }
}

/** 在分屏树中查找 leaf。 */
function findLeafInTree(tree: SplitTree, leafId: string): SplitLeaf | null {
  for (const leaf of allLeaves(tree)) {
    if (leaf.id === leafId) return leaf;
  }
  return null;
}

/** 在所有 cwd 树中查找 leaf。 */
export function findLeaf(cwdTrees: Record<string, SplitTree>, leafId: string): { cwd: string; leaf: SplitLeaf } | null {
  for (const [cwd, tree] of Object.entries(cwdTrees)) {
    const leaf = findLeafInTree(tree, leafId);
    if (leaf) return { cwd, leaf };
  }
  return null;
}

/** 从父节点中移除指定 leaf，返回更新后的树。 */
function removeLeafFromTree(tree: SplitTree, leafId: string): SplitTree | null {
  if (tree.type === 'leaf') {
    return tree.id === leafId ? null : tree;
  }
  const node = tree;
  const remaining = node.children
    .map((child) => removeLeafFromTree(child, leafId))
    .filter((child): child is SplitChild => child !== null);
  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];
  // 重新计算 ratios
  const keptIndices = node.children
    .map((child, idx) => (removeLeafFromTree(child, leafId) !== null ? idx : -1))
    .filter((idx) => idx >= 0);
  const newRatios = keptIndices.map((idx) => node.ratios[idx]);
  const total = newRatios.reduce((a, b) => a + b, 0);
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    ratios: total > 0 ? newRatios.map((r) => r / total) : newRatios.map(() => 1 / newRatios.length),
    children: remaining,
  };
}

/** 用 SplitNode 替换指定 leaf。 */
function replaceLeafWithNode(tree: SplitTree, leafId: string, newNode: SplitNode): SplitTree | null {
  if (tree.type === 'leaf') {
    return tree.id === leafId ? newNode : tree;
  }
  return {
    ...tree,
    children: tree.children.map((child) => replaceLeafWithNode(child, leafId, newNode)),
  } as SplitNode;
}

// ── Store ──

export interface SplitStore {
  // 状态
  cwdTrees: Record<string, SplitTree>;
  activeCwd: string | null;
  activeLeafId: string | null;
  cwdOrder: string[];
  cwdActiveLeafId: Record<string, string | null>; // per-cwd active leaf
  cwdActiveTab: Record<string, string | null>; // 各目录最后激活的 tab id（保持向后兼容）
  cwdTabHistory: Record<string, string[]>; // 各目录 tab 访问历史
  terminals: IntegratedTerminalInfo[];


  // Tab 管理 action（leafId 可选，默认使用 activeLeafId）
  setActiveCwd: (cwd: string) => void;
  openSession: (req: { key?: string; cwd?: string; name?: string }, leafId?: string) => void;
  openPreview: (root: string, path: string, fileName?: string, leafId?: string) => void;
  openDiff: (cwd: string, commitHash: string | null, leafId?: string, filePath?: string | null) => void;
  openSessionContent: (sessionKey: string, sessionName: string, cwd: string, leafId?: string) => void;
  openTerminal: (id: string, cwd: string, title: string, leafId?: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  hideTab: (id: string) => void;
  reorderTabsInLeaf: (leafId: string, orderedIds: string[]) => void;
  setHidden: (id: string, hidden: boolean) => void;
  setTerminals: (list: IntegratedTerminalInfo[]) => void;
  removeSessionTab: (key: string) => void;
  removeTerminalTab: (id: string) => void;
  closeCenterTab: (id: string) => void;
  promoteTabNames: (diskList: { key: string; name: string }[]) => void;
  renameSessionTab: (key: string, name: string) => void;
  // 终端 OSC 0 标题变化时更新 tab 标题（pi 扩展 spinner 标题帧 / shell 自设标题）。
  // 仅更新 title 展示字段，不动 name（会话真名由 /name → PiName → renameSessionTab 管理）。
  updateTabTitle: (id: string, title: string) => void;

  // 分屏专用 action
  splitPane: (leafId: string, direction: SplitDirection) => void;
  /** 分屏并将指定 tab 移到新 leaf（不自动创建终端）。 */
  splitPaneWithTab: (leafId: string, tabId: string, direction: SplitDirection) => void;
  closeLeaf: (leafId: string) => void;
  setRatios: (nodeId: string, ratios: number[]) => void;
  setActiveLeaf: (leafId: string) => void;
  moveTabAcrossLeafs: (tabId: string, sourceLeafId: string, targetLeafId: string, targetIndex: number) => void;
}

/** 获取当前活跃 leaf 的 id。leafId 可选，默认使用 activeLeafId。 */
function resolveLeafId(state: SplitStore, leafId?: string): string | null {
  return leafId ?? state.activeLeafId;
}

/** 获取当前活跃 leaf（优先指定 leafId，否则用 activeLeafId）。 */
function resolveLeaf(state: SplitStore, leafId?: string): SplitLeaf | null {
  const id = resolveLeafId(state, leafId);
  if (!id) return null;
  const found = findLeaf(state.cwdTrees, id);
  return found?.leaf ?? null;
}

/** 获取当前活跃 leaf 的 tabs（优先指定 leafId，否则用 activeLeafId）。 */
function resolveLeafTabs(state: SplitStore, leafId?: string): Tab[] {
  const leaf = resolveLeaf(state, leafId);
  return leaf?.tabs ?? [];
}

/** 获取当前活跃 leaf 的 cwd。 */
function resolveLeafCwd(state: SplitStore, leafId?: string): string | null {
  const id = resolveLeafId(state, leafId);
  if (!id) return null;
  const found = findLeaf(state.cwdTrees, id);
  return found?.cwd ?? null;
}

/** 确保指定 cwd 在 cwdTrees 中有树，若无则创建。 */
function ensureCwdTree(state: SplitStore, cwd: string): { tree: SplitTree; isNew: boolean } {
  if (state.cwdTrees[cwd]) {
    return { tree: state.cwdTrees[cwd], isNew: false };
  }
  const tree = createTree();
  return { tree, isNew: true };
}

export const useSplitStore = create<SplitStore>((set, get) => ({

  // 初始化状态
  cwdTrees: {},
  activeCwd: null,
  activeLeafId: null,
  cwdOrder: [],
  cwdActiveLeafId: {},
  cwdActiveTab: {},
  cwdTabHistory: {},
  terminals: [],

  setActiveCwd: (cwd: string) =>
    set((state) => {
      if (state.activeCwd === cwd) return {};
      captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      // 保存当前 cwd 的活跃 leaf
      const cwdActiveLeafId = { ...state.cwdActiveLeafId };
      if (state.activeCwd != null) {
        cwdActiveLeafId[state.activeCwd] = state.activeLeafId;
      }

      // 确保目标 cwd 有树
      const { tree, isNew } = ensureCwdTree(state, cwd);
      const cwdTrees = isNew ? { ...state.cwdTrees, [cwd]: tree } : state.cwdTrees;

      // 恢复目标 cwd 的活跃 leaf
      let activeLeafId = cwdActiveLeafId[cwd] ?? null;
      if (activeLeafId != null) {
        const found = findLeaf(cwdTrees, activeLeafId);
        if (!found) {
          activeLeafId = null;
          cwdActiveLeafId[cwd] = null;
        }
      }
      // 若没有活跃 leaf，用第一个 leaf
      if (activeLeafId == null) {
        for (const leaf of allLeaves(cwdTrees[cwd])) {
          activeLeafId = leaf.id;
          break;
        }
      }

      // 获取该 leaf 的 activeTabId
      let activeTabId: string | null = null;
      if (activeLeafId) {
        const leaf = findLeafInTree(cwdTrees[cwd], activeLeafId);
        activeTabId = leaf?.activeTabId ?? null;
      }

      return {
        cwdTrees,
        activeCwd: cwd,
        activeLeafId,
        cwdActiveLeafId,
        activeTabId: activeTabId as any, // 兼容旧代码读取
        cwdTabHistory: activeTabId
          ? pushTabHistory(state.cwdTabHistory, cwd, activeTabId)
          : state.cwdTabHistory,
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  openSession: (req, leafId) =>
    set((state) => {
      const cwdVal = req.cwd || req.key || '';
      const key = req.key ?? cwdVal;

      // 全局去重：检查 key 是否已存在
      const existing = findTabByKey(state.cwdTrees, key);
      if (existing) {
        // 已存在 → 取消隐藏，切换到该 leaf
        const leaf = existing.leaf;
        const tabs = leaf.tabs.map((t) =>
          t.id === existing.tab.id ? { ...t, hidden: false } : t,
        );
        // 更新 tree 中的 leaf
        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? { ...tree, tabs, activeTabId: existing.tab.id } : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };
        const cwdTrees = { ...state.cwdTrees, [existing.cwd]: updateTree(state.cwdTrees[existing.cwd]) };

        if (cwdVal !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

        return {
          cwdTrees,
          activeCwd: existing.cwd,
          activeLeafId: leaf.id,
          cwdActiveLeafId: { ...state.cwdActiveLeafId, [existing.cwd]: leaf.id },
          cwdTabHistory: pushTabHistory(state.cwdTabHistory, existing.cwd, existing.tab.id),
          cwdOrder: ensureCwdOrder(state.cwdOrder, existing.cwd),
        };
      }

      // 新建
      if (cwdVal !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      // 确保 cwd 树存在
      const { tree, isNew } = ensureCwdTree(state, cwdVal);
      let cwdTrees = isNew ? { ...state.cwdTrees, [cwdVal]: tree } : state.cwdTrees;

      // 确定目标 leaf
      const targetLeafId = resolveLeafId(state, leafId) ?? null;
      let targetLeaf: SplitLeaf | null = null;
      if (targetLeafId) {
        targetLeaf = findLeafInTree(cwdTrees[cwdVal], targetLeafId);
      }
      if (!targetLeaf) {
        // 取 cwd 的第一个 leaf
        for (const leaf of allLeaves(cwdTrees[cwdVal])) {
          targetLeaf = leaf;
          break;
        }
      }
      if (!targetLeaf) {
        // 创建新 leaf
        targetLeaf = createLeaf();
        cwdTrees = { ...cwdTrees, [cwdVal]: targetLeaf };
      }

      const leafTabs = targetLeaf.tabs;
      const id = key;
      const tab: SessionTab = {
        id,
        kind: 'session',
        location: 'editor',
        title: req.name || id,
        hidden: false,
        order: nextOrder(leafTabs),
        key: id,
        cwd: cwdVal,
        name: req.name || id,
      };

      const updatedLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: [...leafTabs, tab],
        activeTabId: id,
      };

      // 替换树中的 leaf
      const replaceFunc = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === updatedLeaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceFunc) };
      };
      cwdTrees = { ...cwdTrees, [cwdVal]: replaceFunc(cwdTrees[cwdVal]) };

      return {
        cwdTrees,
        activeCwd: cwdVal,
        activeLeafId: updatedLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwdVal]: updatedLeaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwdVal, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwdVal),
      };
    }),

  openPreview: (root, path, fileName, leafId) =>
    set((state) => {
      const id = `preview:${root}//${path}`;

      // 全局去重
      const existing = findTabById(state.cwdTrees, id);
      if (existing) {
        const leaf = existing.leaf;
        const tabs = leaf.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? { ...tree, tabs, activeTabId: id } : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };
        const cwdTrees = { ...state.cwdTrees, [existing.cwd]: updateTree(state.cwdTrees[existing.cwd]) };

        if (root !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

        return {
          cwdTrees,
          activeCwd: existing.cwd,
          activeLeafId: leaf.id,
          cwdActiveLeafId: { ...state.cwdActiveLeafId, [existing.cwd]: leaf.id },
          cwdTabHistory: pushTabHistory(state.cwdTabHistory, existing.cwd, id),
          cwdOrder: ensureCwdOrder(state.cwdOrder, existing.cwd),
        };
      }

      if (root !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      const { tree, isNew } = ensureCwdTree(state, root);
      let cwdTrees = isNew ? { ...state.cwdTrees, [root]: tree } : state.cwdTrees;

      const targetLeafId = resolveLeafId(state, leafId) ?? null;
      let targetLeaf: SplitLeaf | null = null;
      if (targetLeafId) {
        targetLeaf = findLeafInTree(cwdTrees[root], targetLeafId);
      }
      if (!targetLeaf) {
        for (const leaf of allLeaves(cwdTrees[root])) {
          targetLeaf = leaf;
          break;
        }
      }
      if (!targetLeaf) {
        targetLeaf = createLeaf();
        cwdTrees = { ...cwdTrees, [root]: targetLeaf };
      }

      const tab: PreviewTab = {
        id,
        kind: 'preview',
        location: 'editor',
        title: fileName || path.split('/').pop() || path,
        hidden: false,
        order: nextOrder(targetLeaf.tabs),
        root,
        path,
      };

      const updatedLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: [...targetLeaf.tabs, tab],
        activeTabId: id,
      };

      const replaceFunc = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === updatedLeaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceFunc) };
      };
      cwdTrees = { ...cwdTrees, [root]: replaceFunc(cwdTrees[root]) };

      return {
        cwdTrees,
        activeCwd: root,
        activeLeafId: updatedLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [root]: updatedLeaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, root, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, root),
      };
    }),

  openDiff: (cwd, commitHash, leafId, filePath) =>
    set((state) => {
      const fp = filePath ?? '';
      const id = `diff:${cwd}//${commitHash ?? 'work'}` + (fp ? `/${fp}` : '');

      const existing = findTabById(state.cwdTrees, id);
      if (existing) {
        const leaf = existing.leaf;
        const tabs = leaf.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? { ...tree, tabs, activeTabId: id } : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };
        const cwdTrees = { ...state.cwdTrees, [existing.cwd]: updateTree(state.cwdTrees[existing.cwd]) };

        if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

        return {
          cwdTrees,
          activeCwd: existing.cwd,
          activeLeafId: leaf.id,
          cwdActiveLeafId: { ...state.cwdActiveLeafId, [existing.cwd]: leaf.id },
          cwdTabHistory: pushTabHistory(state.cwdTabHistory, existing.cwd, id),
          cwdOrder: ensureCwdOrder(state.cwdOrder, existing.cwd),
        };
      }

      if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      const { tree, isNew } = ensureCwdTree(state, cwd);
      let cwdTrees = isNew ? { ...state.cwdTrees, [cwd]: tree } : state.cwdTrees;

      const targetLeafId = resolveLeafId(state, leafId) ?? null;
      let targetLeaf: SplitLeaf | null = null;
      if (targetLeafId) {
        targetLeaf = findLeafInTree(cwdTrees[cwd], targetLeafId);
      }
      if (!targetLeaf) {
        for (const leaf of allLeaves(cwdTrees[cwd])) {
          targetLeaf = leaf;
          break;
        }
      }
      if (!targetLeaf) {
        targetLeaf = createLeaf();
        cwdTrees = { ...cwdTrees, [cwd]: targetLeaf };
      }

      const tab: DiffTab = {
        id,
        kind: 'diff',
        location: 'editor',
        title: filePath ? filePath.split('/').pop() ?? filePath : (commitHash ? commitHash.slice(0, 8) : '工作区改动'),
        hidden: false,
        order: nextOrder(targetLeaf.tabs),
        cwd,
        commitHash,
        filePath,
      };

      const updatedLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: [...targetLeaf.tabs, tab],
        activeTabId: id,
      };

      const replaceFunc = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === updatedLeaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceFunc) };
      };
      cwdTrees = { ...cwdTrees, [cwd]: replaceFunc(cwdTrees[cwd]) };

      return {
        cwdTrees,
        activeCwd: cwd,
        activeLeafId: updatedLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: updatedLeaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwd, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  openSessionContent: (sessionKey, sessionName, cwd, leafId) =>
    set((state) => {
      const id = `session-content:${sessionKey}`;

      const existing = findTabById(state.cwdTrees, id);
      if (existing) {
        const leaf = existing.leaf;
        const tabs = leaf.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? { ...tree, tabs, activeTabId: id } : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };
        const cwdTrees = { ...state.cwdTrees, [existing.cwd]: updateTree(state.cwdTrees[existing.cwd]) };

        if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

        return {
          cwdTrees,
          activeCwd: existing.cwd,
          activeLeafId: leaf.id,
          cwdActiveLeafId: { ...state.cwdActiveLeafId, [existing.cwd]: leaf.id },
          cwdTabHistory: pushTabHistory(state.cwdTabHistory, existing.cwd, id),
          cwdOrder: ensureCwdOrder(state.cwdOrder, existing.cwd),
        };
      }

      if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      const { tree, isNew } = ensureCwdTree(state, cwd);
      let cwdTrees = isNew ? { ...state.cwdTrees, [cwd]: tree } : state.cwdTrees;

      const targetLeafId = resolveLeafId(state, leafId) ?? null;
      let targetLeaf: SplitLeaf | null = null;
      if (targetLeafId) {
        targetLeaf = findLeafInTree(cwdTrees[cwd], targetLeafId);
      }
      if (!targetLeaf) {
        for (const leaf of allLeaves(cwdTrees[cwd])) {
          targetLeaf = leaf;
          break;
        }
      }
      if (!targetLeaf) {
        targetLeaf = createLeaf();
        cwdTrees = { ...cwdTrees, [cwd]: targetLeaf };
      }

      const tab: SessionContentTab = {
        id,
        kind: 'session-content',
        location: 'editor',
        title: sessionName,
        hidden: false,
        order: nextOrder(targetLeaf.tabs),
        sessionKey,
        sessionName,
        cwd,
      };

      const updatedLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: [...targetLeaf.tabs, tab],
        activeTabId: id,
      };

      const replaceFunc = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === updatedLeaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceFunc) };
      };
      cwdTrees = { ...cwdTrees, [cwd]: replaceFunc(cwdTrees[cwd]) };

      return {
        cwdTrees,
        activeCwd: cwd,
        activeLeafId: updatedLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: updatedLeaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwd, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  openTerminal: (id, cwd, title, leafId) =>
    set((state) => {
      const existing = findTabById(state.cwdTrees, id);
      if (existing) {
        const leaf = existing.leaf;
        const tabs = leaf.tabs.map((t) =>
          t.id === id ? { ...t, hidden: false } : t,
        );
        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? { ...tree, tabs, activeTabId: id } : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };
        const cwdTrees = { ...state.cwdTrees, [existing.cwd]: updateTree(state.cwdTrees[existing.cwd]) };

        return {
          cwdTrees,
          activeCwd: existing.cwd,
          activeLeafId: leaf.id,
          cwdActiveLeafId: { ...state.cwdActiveLeafId, [existing.cwd]: leaf.id },
          cwdTabHistory: pushTabHistory(state.cwdTabHistory, existing.cwd, id),
          cwdOrder: ensureCwdOrder(state.cwdOrder, existing.cwd),
        };
      }

      const { tree, isNew } = ensureCwdTree(state, cwd);
      let cwdTrees = isNew ? { ...state.cwdTrees, [cwd]: tree } : state.cwdTrees;

      const targetLeafId = resolveLeafId(state, leafId) ?? null;
      let targetLeaf: SplitLeaf | null = null;
      if (targetLeafId) {
        targetLeaf = findLeafInTree(cwdTrees[cwd], targetLeafId);
      }
      if (!targetLeaf) {
        for (const leaf of allLeaves(cwdTrees[cwd])) {
          targetLeaf = leaf;
          break;
        }
      }
      if (!targetLeaf) {
        targetLeaf = createLeaf();
        cwdTrees = { ...cwdTrees, [cwd]: targetLeaf };
      }

      const tab: IntegratedTerminalTab = {
        id,
        kind: 'integrated-terminal',
        location: 'editor',
        title,
        hidden: false,
        order: nextOrder(targetLeaf.tabs),
        cwd,
      };

      const updatedLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: [...targetLeaf.tabs, tab],
        activeTabId: id,
      };

      const replaceFunc = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === updatedLeaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceFunc) };
      };
      cwdTrees = { ...cwdTrees, [cwd]: replaceFunc(cwdTrees[cwd]) };

      return {
        cwdTrees,
        activeCwd: cwd,
        activeLeafId: updatedLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: updatedLeaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwd, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  selectTab: (id) =>
    set((state) => {
      // 在所有 cwd 和 leaf 中查找 tab
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      // 更新 leaf 的 activeTabId
      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? { ...tree, activeTabId: id } : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
        activeCwd: cwd,
        activeLeafId: leaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: leaf.id },
        cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwd, id),
        cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
      };
    }),

  closeTab: (id) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      const leafTabs = leaf.tabs.filter((t) => t.id !== id);
      const isLastTab = leafTabs.length === 0;

      if (isLastTab) {
        // 最后一个 tab → 关闭 leaf
        const tree = state.cwdTrees[cwd];
        const newTree = removeLeafFromTree(tree, leaf.id);
        if (!newTree) {
          // 树空了 → 创建空 leaf
          const emptyLeaf = createLeaf();
          const cwdTrees = { ...state.cwdTrees, [cwd]: emptyLeaf };
          const cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, [], cwd, null);
          return {
            cwdTrees,
            activeTabId: null,
            activeLeafId: emptyLeaf.id,
            cwdActiveTab: { ...cwdActiveTab, [cwd]: null },
            cwdTabHistory: {},
          };
        }
        const cwdTrees = { ...state.cwdTrees, [cwd]: newTree };

        // 找下一个活跃 leaf
        let nextLeaf: SplitLeaf | null = null;
        for (const lf of allLeaves(newTree)) {
          nextLeaf = lf;
          break;
        }

        const cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, leafTabs, cwd, nextLeaf?.activeTabId ?? null);
        return {
          cwdTrees,
          activeTabId: nextLeaf?.activeTabId ?? null,
          activeLeafId: nextLeaf?.id ?? null,
          cwdActiveTab: { ...cwdActiveTab, [cwd]: nextLeaf?.activeTabId ?? null },
          cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
        };
      }

      // 普通关闭 tab
      const updatedLeaf: SplitLeaf = {
        ...leaf,
        tabs: leafTabs,
      };

      const tabCwd = getTabCwd(found.tab);
      const next = selectNextTabOnClose(
        leafTabs, id, tabCwd,
        leaf.activeTabId, state.activeCwd,
        state.cwdActiveTab, state.cwdTabHistory,
      );

      if (next) {
        updatedLeaf.activeTabId = next.activeTabId;
      }

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      const patch: any = {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
      };
      if (next) {
        patch.activeTabId = next.activeTabId;
        patch.cwdActiveTab = next.cwdActiveTab;
        patch.cwdTabHistory = next.cwdTabHistory;
      }
      return patch;
    }),

  hideTab: (id) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      const tabs = leaf.tabs.map((t) => (t.id === id ? { ...t, hidden: true } : t));
      const updatedLeaf: SplitLeaf = { ...leaf, tabs };

      const patch: any = {};
      if (leaf.activeTabId === id) {
        const tabCwd = getTabCwd(found.tab);
        const next = selectNextTabOnClose(
          tabs, id, tabCwd,
          leaf.activeTabId, state.activeCwd,
          state.cwdActiveTab, state.cwdTabHistory,
        );
        if (next) {
          updatedLeaf.activeTabId = next.activeTabId;
          patch.activeTabId = next.activeTabId;
          patch.cwdActiveTab = next.cwdActiveTab;
          patch.cwdTabHistory = next.cwdTabHistory;
        }
      }

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      patch.cwdTrees = { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) };
      return patch;
    }),

  setHidden: (id, hidden) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found || found.tab.hidden === hidden) return {};
      const { cwd, leaf } = found;

      const tabs = leaf.tabs.map((t) => (t.id === id ? { ...t, hidden } : t));
      const updatedLeaf: SplitLeaf = { ...leaf, tabs };

      const patch: any = {};
      if (!hidden && leaf.activeTabId === null) {
        // 取消隐藏且当前无激活
        updatedLeaf.activeTabId = id;
        patch.activeTabId = id;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, tabs, state.activeCwd, id);
          patch.cwdTabHistory = pushTabHistory(state.cwdTabHistory, state.activeCwd, id);
        }
      } else if (hidden && leaf.activeTabId === id) {
        const tabCwd = getTabCwd(found.tab);
        const next = selectNextTabOnClose(
          tabs, id, tabCwd,
          leaf.activeTabId, state.activeCwd,
          state.cwdActiveTab, state.cwdTabHistory,
        );
        if (next) {
          updatedLeaf.activeTabId = next.activeTabId;
          patch.activeTabId = next.activeTabId;
          patch.cwdActiveTab = next.cwdActiveTab;
          patch.cwdTabHistory = next.cwdTabHistory;
        }
      }

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      patch.cwdTrees = { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) };
      return patch;
    }),

  reorderTabsInLeaf: (leafId, orderedIds) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      const { cwd, leaf } = found;

      const orderMap = new Map<string, number>();
      orderedIds.forEach((id, idx) => orderMap.set(id, idx));
      const tabs = leaf.tabs.map((t) => {
        if (orderMap.has(t.id)) return { ...t, order: orderMap.get(t.id)! };
        return t;
      });

      const updatedLeaf: SplitLeaf = { ...leaf, tabs };
      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      return { cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) } };
    }),

  setTerminals: (list) => set({ terminals: list }),

  removeSessionTab: (key) =>
    set((state) => {
      const found = findTabByKey(state.cwdTrees, key);
      if (!found) return {};
      const { cwd, leaf } = found;

      const remaining = leaf.tabs.filter(
        (t) => !(t.kind === 'session' && (t as SessionTab).key === key),
      );
      if (remaining.length === leaf.tabs.length) return {};

      const isLastTab = remaining.length === 0;
      if (isLastTab) {
        const tree = state.cwdTrees[cwd];
        const newTree = removeLeafFromTree(tree, leaf.id);
        if (!newTree) {
          const emptyLeaf = createLeaf();
          return {
            cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
            activeTabId: null,
            activeLeafId: emptyLeaf.id,
            cwdActiveTab: {},
            cwdTabHistory: {},
          };
        }
        const cwdTrees = { ...state.cwdTrees, [cwd]: newTree };
        let nextLeaf: SplitLeaf | null = null;
        for (const lf of allLeaves(newTree)) {
          nextLeaf = lf;
          break;
        }
        return {
          cwdTrees,
          activeTabId: nextLeaf?.activeTabId ?? null,
          activeLeafId: nextLeaf?.id ?? null,
          cwdActiveTab: {},
          cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
        };
      }

      const tabCwd = getTabCwd(found.tab);
      const next = selectNextTabOnClose(
        remaining, found.tab.id, tabCwd,
        leaf.activeTabId, state.activeCwd,
        state.cwdActiveTab, state.cwdTabHistory,
      );

      const updatedLeaf: SplitLeaf = {
        ...leaf,
        tabs: remaining,
        activeTabId: next?.activeTabId ?? leaf.activeTabId,
      };

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      const patch: any = {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
      };
      if (next) {
        patch.activeTabId = next.activeTabId;
        patch.cwdActiveTab = next.cwdActiveTab;
        patch.cwdTabHistory = next.cwdTabHistory;
      }
      return patch;
    }),

  removeTerminalTab: (id) =>
    set((state) => {
      const found = findTabByTerminalId(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      const remaining = leaf.tabs.filter(
        (t) => !(t.kind === 'integrated-terminal' && t.id === id),
      );
      if (remaining.length === leaf.tabs.length) return {};

      const isLastTab = remaining.length === 0;
      if (isLastTab) {
        const tree = state.cwdTrees[cwd];
        const newTree = removeLeafFromTree(tree, leaf.id);
        if (!newTree) {
          const emptyLeaf = createLeaf();
          return {
            cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
            activeTabId: null,
            activeLeafId: emptyLeaf.id,
            cwdActiveTab: {},
            cwdTabHistory: {},
          };
        }
        const cwdTrees = { ...state.cwdTrees, [cwd]: newTree };
        let nextLeaf: SplitLeaf | null = null;
        for (const lf of allLeaves(newTree)) {
          nextLeaf = lf;
          break;
        }
        return {
          cwdTrees,
          activeTabId: nextLeaf?.activeTabId ?? null,
          activeLeafId: nextLeaf?.id ?? null,
          cwdActiveTab: {},
          cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
        };
      }

      const tabCwd = getTabCwd(found.tab);
      const next = selectNextTabOnClose(
        remaining, id, tabCwd,
        leaf.activeTabId, state.activeCwd,
        state.cwdActiveTab, state.cwdTabHistory,
      );

      const updatedLeaf: SplitLeaf = {
        ...leaf,
        tabs: remaining,
        activeTabId: next?.activeTabId ?? leaf.activeTabId,
      };

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      const patch: any = {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
      };
      if (next) {
        patch.activeTabId = next.activeTabId;
        patch.cwdActiveTab = next.cwdActiveTab;
        patch.cwdTabHistory = next.cwdTabHistory;
      }
      return patch;
    }),

  closeCenterTab: (id) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      const tab = found.tab;
      if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
        const remaining = leaf.tabs.filter((t) => t.id !== id);
        const isLastTab = remaining.length === 0;
        if (isLastTab) {
          const tree = state.cwdTrees[cwd];
          const newTree = removeLeafFromTree(tree, leaf.id);
          if (!newTree) {
            const emptyLeaf = createLeaf();
            return {
              cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
              activeTabId: null,
              activeLeafId: emptyLeaf.id,
              cwdActiveTab: {},
              cwdTabHistory: {},
            };
          }
          const cwdTrees = { ...state.cwdTrees, [cwd]: newTree };
          let nextLeaf: SplitLeaf | null = null;
          for (const lf of allLeaves(newTree)) {
            nextLeaf = lf;
            break;
          }
          return {
            cwdTrees,
            activeTabId: nextLeaf?.activeTabId ?? null,
            activeLeafId: nextLeaf?.id ?? null,
            cwdActiveTab: {},
            cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
          };
        }

        const tabCwd = getTabCwd(tab);
        const next = selectNextTabOnClose(
          remaining, id, tabCwd,
          leaf.activeTabId, state.activeCwd,
          state.cwdActiveTab, state.cwdTabHistory,
        );

        const updatedLeaf: SplitLeaf = {
          ...leaf,
          tabs: remaining,
          activeTabId: next?.activeTabId ?? leaf.activeTabId,
        };

        const updateTree = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === leaf.id ? updatedLeaf : tree;
          }
          return { ...tree, children: tree.children.map(updateTree) };
        };

        const patch: any = {
          cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
        };
        if (next) {
          patch.activeTabId = next.activeTabId;
          patch.cwdActiveTab = next.cwdActiveTab;
          patch.cwdTabHistory = next.cwdTabHistory;
        }
        return patch;
      }

      // preview / diff：真移除
      const remaining = leaf.tabs.filter((t) => t.id !== id);
      const isLastTab = remaining.length === 0;
      if (isLastTab) {
        const tree = state.cwdTrees[cwd];
        const newTree = removeLeafFromTree(tree, leaf.id);
        if (!newTree) {
          const emptyLeaf = createLeaf();
          return {
            cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
            activeTabId: null,
            activeLeafId: emptyLeaf.id,
            cwdActiveTab: {},
            cwdTabHistory: {},
          };
        }
        const cwdTrees = { ...state.cwdTrees, [cwd]: newTree };
        let nextLeaf: SplitLeaf | null = null;
        for (const lf of allLeaves(newTree)) {
          nextLeaf = lf;
          break;
        }
        return {
          cwdTrees,
          activeTabId: nextLeaf?.activeTabId ?? null,
          activeLeafId: nextLeaf?.id ?? null,
          cwdActiveTab: {},
          cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
        };
      }

      const tabCwd = getTabCwd(tab);
      const next = selectNextTabOnClose(
        remaining, id, tabCwd,
        leaf.activeTabId, state.activeCwd,
        state.cwdActiveTab, state.cwdTabHistory,
      );

      const updatedLeaf: SplitLeaf = {
        ...leaf,
        tabs: remaining,
        activeTabId: next?.activeTabId ?? leaf.activeTabId,
      };

      const updateTree = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === leaf.id ? updatedLeaf : tree;
        }
        return { ...tree, children: tree.children.map(updateTree) };
      };

      const patch: any = {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateTree(state.cwdTrees[cwd]) },
      };
      if (next) {
        patch.activeTabId = next.activeTabId;
        patch.cwdActiveTab = next.cwdActiveTab;
        patch.cwdTabHistory = next.cwdTabHistory;
      }
      return patch;
    }),

  promoteTabNames: (diskList) =>
    set((state) => {
      let changed = false;
      let cwdTrees = { ...state.cwdTrees };
      for (const [cwd, tree] of Object.entries(cwdTrees)) {
        const updateTree = (t: SplitTree): SplitTree => {
          if (t.type === 'leaf') {
            let changedLeaf = false;
            const tabs = t.tabs.map((tab) => {
              if (tab.kind !== 'session') return tab;
              const d = diskList.find((x) => x.key === (tab as SessionTab).key);
              if (d && d.name && d.name !== tab.name) {
                changedLeaf = true;
                return { ...tab, name: d.name, title: d.name };
              }
              return tab;
            });
            return changedLeaf ? { ...t, tabs } : t;
          }
          return { ...t, children: t.children.map(updateTree) };
        };
        const updated = updateTree(tree);
        if (updated !== tree) {
          changed = true;
          cwdTrees[cwd] = updated;
        }
      }
      return changed ? { cwdTrees } : {};
    }),

  renameSessionTab: (key, name) =>
    set((state) => {
      let changed = false;
      let cwdTrees = { ...state.cwdTrees };
      for (const [cwd, tree] of Object.entries(cwdTrees)) {
        const updateTree = (t: SplitTree): SplitTree => {
          if (t.type === 'leaf') {
            let changedLeaf = false;
            const tabs = t.tabs.map((tab) => {
              if (tab.kind !== 'session' || (tab as SessionTab).key !== key) return tab;
              changedLeaf = true;
              return { ...tab, name, title: name };
            });
            return changedLeaf ? { ...t, tabs } : t;
          }
          return { ...t, children: t.children.map(updateTree) };
        };
        const updated = updateTree(tree);
        if (updated !== tree) {
          changed = true;
          cwdTrees[cwd] = updated;
        }
      }
      return changed ? { cwdTrees } : {};
    }),

  updateTabTitle: (id, title) =>
    set((state) => {
      let changed = false;
      let cwdTrees = { ...state.cwdTrees };
      for (const [cwd, tree] of Object.entries(cwdTrees)) {
        const updateTree = (t: SplitTree): SplitTree => {
          if (t.type === 'leaf') {
            let changedLeaf = false;
            const tabs = t.tabs.map((tab) => {
              if (tab.id !== id || tab.title === title) return tab;
              changedLeaf = true;
              return { ...tab, title };
            });
            return changedLeaf ? { ...t, tabs } : t;
          }
          return { ...t, children: t.children.map(updateTree) };
        };
        const updated = updateTree(tree);
        if (updated !== tree) {
          changed = true;
          cwdTrees[cwd] = updated;
        }
      }
      return changed ? { cwdTrees } : {};
    }),

  // ── 分屏专用 action ──

  splitPane: (leafId, direction) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      const { cwd, leaf } = found;

      // 创建新 leaf
      const newLeaf = createLeaf();

      // 构建 split node
      const nodeId = uid();
      const splitNode: SplitNode = {
        type: 'split',
        id: nodeId,
        direction,
        ratios: [0.5, 0.5],
        children: [leaf, newLeaf],
      };

      // 替换树中的 leaf
      const newTree = replaceLeafWithNode(state.cwdTrees[cwd], leafId, splitNode);
      if (!newTree) return {};

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: newTree },
        activeLeafId: newLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: newLeaf.id },
      };
    }),

  splitPaneWithTab: (leafId, tabId, direction) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      const { cwd, leaf } = found;

      const tab = leaf.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      // 保存滚动位置（终端/会话类 tab）
      if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
        capturePaneScrollState(tab.id);
      }

      // 从源 leaf 移除 tab
      const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);
      // 源 leaf 不应为空（UI 侧已禁用单 tab 分屏）
      if (remainingTabs.length === 0) return {};

      // 更新源 leaf
      let updatedLeaf: SplitLeaf = { ...leaf, tabs: remainingTabs };
      let nextCwdActiveTab = state.cwdActiveTab;
      let nextCwdTabHistory = state.cwdTabHistory;

      if (leaf.activeTabId === tabId) {
        const next = selectNextTabOnClose(
          remainingTabs, tabId, cwd,
          leaf.activeTabId, state.activeCwd,
          state.cwdActiveTab, state.cwdTabHistory,
        );
        if (next) {
          updatedLeaf = { ...updatedLeaf, activeTabId: next.activeTabId };
          nextCwdActiveTab = next.cwdActiveTab;
          nextCwdTabHistory = next.cwdTabHistory;
        }
      }

      // 创建新 leaf 并放入被移动的 tab
      const newLeaf = createLeaf();
      newLeaf.tabs = [{ ...tab }];
      newLeaf.activeTabId = tabId;

      // 构建 split node：源 leaf（已移除 tab）+ 新 leaf
      const nodeId = uid();
      const splitNode: SplitNode = {
        type: 'split',
        id: nodeId,
        direction,
        ratios: [0.5, 0.5],
        children: [updatedLeaf, newLeaf],
      };

      // 替换树中的 leaf
      const newTree = replaceLeafWithNode(state.cwdTrees[cwd], leafId, splitNode);
      if (!newTree) return {};

      // 更新历史
      nextCwdTabHistory = pushTabHistory(nextCwdTabHistory, cwd, tabId);
      const allTabs = collectAllTabs({ [cwd]: newTree });
      nextCwdActiveTab = updateCwdActiveTab(nextCwdActiveTab, allTabs, cwd, tabId);

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: newTree },
        activeLeafId: newLeaf.id,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: newLeaf.id },
        cwdTabHistory: nextCwdTabHistory,
        cwdActiveTab: nextCwdActiveTab,
      };
    }),

  closeLeaf: (leafId) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      const { cwd, leaf } = found;

      const tree = state.cwdTrees[cwd];

      // 如果树中只有一个 leaf，且是同一 leaf → 清空它
      let leafCount = 0;
      for (const _ of allLeaves(tree)) leafCount++;
      if (leafCount <= 1) {
        const emptyLeaf = createLeaf();
        return {
          cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
          activeLeafId: emptyLeaf.id,
          activeTabId: null,
        };
      }

      const newTree = removeLeafFromTree(tree, leafId);
      if (!newTree) return {};

      // 找到活跃 leaf
      let nextLeaf: SplitLeaf | null = null;
      for (const lf of allLeaves(newTree)) {
        nextLeaf = lf;
        break;
      }

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: newTree },
        activeLeafId: nextLeaf?.id ?? null,
        activeTabId: nextLeaf?.activeTabId ?? null,
      };
    }),

  setRatios: (nodeId, ratios) =>
    set((state) => {
      let cwdTrees = { ...state.cwdTrees };
      for (const [cwd, tree] of Object.entries(cwdTrees)) {
        const updateTree = (t: SplitTree): SplitTree => {
          if (t.type === 'leaf') return t;
          if (t.id === nodeId) {
            return { ...t, ratios };
          }
          return { ...t, children: t.children.map(updateTree) };
        };
        cwdTrees[cwd] = updateTree(tree);
      }
      return { cwdTrees };
    }),

  moveTabAcrossLeafs: (tabId, sourceLeafId, targetLeafId, targetIndex) =>
    set((state) => {
      const sourceFound = findLeaf(state.cwdTrees, sourceLeafId);
      const targetFound = findLeaf(state.cwdTrees, targetLeafId);
      if (!sourceFound || !targetFound) return {};
      const { cwd: sourceCwd, leaf: sourceLeaf } = sourceFound;
      const { cwd: targetCwd, leaf: targetLeaf } = targetFound;

      // 跨 cwd 移动是防御性检查（不允许），但保留逻辑
      if (sourceCwd !== targetCwd) return {};

      const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      // 保存滚动位置
      if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
        capturePaneScrollState(tab.id);
      }

      // 从 source leaf 移除 tab
      const sourceRemaining = sourceLeaf.tabs.filter((t) => t.id !== tabId);
      const isLastTab = sourceRemaining.length === 0;

      // 更新树结构
      let cwdTrees = { ...state.cwdTrees };

      if (isLastTab) {
        // 移走最后一个 tab → 关闭 source leaf
        const tree = cwdTrees[sourceCwd];
        const newTree = removeLeafFromTree(tree, sourceLeafId);
        if (!newTree) {
          // 树空了 → 创建空 leaf
          const emptyLeaf = createLeaf();
          cwdTrees = { ...cwdTrees, [sourceCwd]: emptyLeaf };
        } else {
          cwdTrees = { ...cwdTrees, [sourceCwd]: newTree };
        }
      } else {
        // 更新 source leaf 的 activeTabId
        let updatedSourceLeaf: SplitLeaf = { ...sourceLeaf, tabs: sourceRemaining };

        if (sourceLeaf.activeTabId === tabId) {
          const tabCwd = getTabCwd(tab);
          const next = selectNextTabOnClose(
            sourceRemaining, tabId, tabCwd,
            sourceLeaf.activeTabId, state.activeCwd,
            state.cwdActiveTab, state.cwdTabHistory,
          );
          if (next && next.activeTabId) {
            updatedSourceLeaf = { ...updatedSourceLeaf, activeTabId: next.activeTabId };
          } else {
            updatedSourceLeaf = { ...updatedSourceLeaf, activeTabId: null };
          }
        }

        // 替换树中的 source leaf
        const replaceSource = (tree: SplitTree): SplitTree => {
          if (tree.type === 'leaf') {
            return tree.id === sourceLeafId ? updatedSourceLeaf : tree;
          }
          return { ...tree, children: tree.children.map(replaceSource) };
        };
        cwdTrees = { ...cwdTrees, [sourceCwd]: replaceSource(cwdTrees[sourceCwd]) };
      }

      // 将 tab 插入到 target leaf
      const targetLeafTabs = [...targetLeaf.tabs];
      const safeIndex = Math.min(targetIndex, targetLeafTabs.length);
      targetLeafTabs.splice(safeIndex, 0, tab);

      const updatedTargetLeaf: SplitLeaf = {
        ...targetLeaf,
        tabs: targetLeafTabs,
        activeTabId: tabId,
      };

      const replaceTarget = (tree: SplitTree): SplitTree => {
        if (tree.type === 'leaf') {
          return tree.id === targetLeafId ? updatedTargetLeaf : tree;
        }
        return { ...tree, children: tree.children.map(replaceTarget) };
      };
      cwdTrees = { ...cwdTrees, [targetCwd]: replaceTarget(cwdTrees[targetCwd]) };

      // 更新历史记录与活跃状态
      const cwdTabHistory = pushTabHistory(state.cwdTabHistory, targetCwd, tabId);
      const cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, collectAllTabs(cwdTrees), targetCwd, tabId);

      return {
        cwdTrees,
        activeLeafId: targetLeafId,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [targetCwd]: targetLeafId },
        cwdTabHistory,
        cwdActiveTab: { ...cwdActiveTab, [targetCwd]: tabId },
      };
    }),

  setActiveLeaf: (leafId) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      return {
        activeLeafId: leafId,
        cwdActiveLeafId: { ...state.cwdActiveLeafId, [found.cwd]: leafId },
      };
    }),
}));

// ── 计算属性（供外部 hooks 使用） ──

/** 收集所有 cwd 的所有 leaf 的所有 tab（供 useSidebarState/useSessionStatus 等使用）。 */
export function getAllTabs(state: SplitStore): Tab[] {
  return collectAllTabs(state.cwdTrees);
}

/** 获取单个 leaf 中的全部 tab（含 hidden）。 */
export function getLeafTabs(state: SplitStore, leafId: string): Tab[] {
  const found = findLeaf(state.cwdTrees, leafId);
  return found?.leaf.tabs ?? [];
}