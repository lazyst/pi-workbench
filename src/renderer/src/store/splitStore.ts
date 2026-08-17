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
  /** 单栏 unified diff（对齐 Monaco inline diff），false 为左右分栏。 */
  singleColumn?: boolean;
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

/** 遍历树中的所有 leaf（含嵌套 split 节点）。 */
function* allLeaves(node: SplitChild): Generator<SplitLeaf> {
  if (node.type === 'leaf') {
    yield node;
    return;
  }
  for (const child of node.children) {
    yield* allLeaves(child);
  }
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
  const remaining = tree.children
    .map((child) => removeLeafFromTree(child, leafId))
    .filter((child): child is SplitChild => child !== null);
  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];
  // 重新计算 ratios
  const keptIndices = tree.children
    .map((child, idx) => (removeLeafFromTree(child, leafId) !== null ? idx : -1))
    .filter((idx) => idx >= 0);
  const newRatios = keptIndices.map((idx) => tree.ratios[idx]);
  const total = newRatios.reduce((a, b) => a + b, 0);
  return {
    type: 'split',
    id: tree.id,
    direction: tree.direction,
    ratios: total > 0 ? newRatios.map((r) => r / total) : newRatios.map(() => 1 / newRatios.length),
    children: remaining,
  };
}

/** 在树中按 id 替换指定 leaf（replacement 可为普通 leaf 或 split 节点）；未找到时返回原树。 */
function updateLeaf(tree: SplitTree, leafId: string, replacement: SplitLeaf | SplitNode): SplitTree {
  if (tree.type === 'leaf') {
    return tree.id === leafId ? replacement : tree;
  }
  const children = tree.children.map((child) => updateLeaf(child, leafId, replacement));
  return children.every((child, i) => child === tree.children[i]) ? tree : { ...tree, children };
}

/** 对树做后序映射：visit 先看到 children 已映射完的节点；未变化的路径保持原对象引用。 */
function mapTree(tree: SplitTree, visit: (node: SplitChild) => SplitChild): SplitTree {
  if (tree.type === 'leaf') return visit(tree);
  const children = tree.children.map((child) => mapTree(child, visit));
  const node: SplitChild = children.every((child, i) => child === tree.children[i]) ? tree : { ...tree, children };
  return visit(node);
}

/** 对所有 cwd 树各应用一次 mapTree，返回新的 cwdTrees 与是否有变化（引用比较）。 */
function mapCwdTrees(
  cwdTrees: Record<string, SplitTree>,
  visit: (node: SplitChild) => SplitChild,
): { cwdTrees: Record<string, SplitTree>; changed: boolean } {
  const next: Record<string, SplitTree> = {};
  let changed = false;
  for (const [cwd, tree] of Object.entries(cwdTrees)) {
    const updated = mapTree(tree, visit);
    if (updated !== tree) changed = true;
    next[cwd] = updated;
  }
  return { cwdTrees: next, changed };
}

/** 取树中第一个 leaf（空树返回 null）。 */
function firstLeaf(tree: SplitTree): SplitLeaf | null {
  return allLeaves(tree).next().value ?? null;
}

// ── Store ──

export interface SplitStore {
  // 状态
  cwdTrees: Record<string, SplitTree>;
  activeCwd: string | null;
  activeLeafId: string | null;
  /** 当前激活 tab id（由 active leaf 派生写入，兼容旧版直接读取）。 */
  activeTabId: string | null;
  cwdOrder: string[];
  cwdActiveLeafId: Record<string, string | null>; // per-cwd active leaf
  cwdActiveTab: Record<string, string | null>; // 各目录最后激活的 tab id（保持向后兼容）
  cwdTabHistory: Record<string, string[]>; // 各目录 tab 访问历史
  terminals: IntegratedTerminalInfo[];

  // Tab 管理 action（leafId 可选，默认使用 activeLeafId）
  setActiveCwd: (cwd: string) => void;
  openSession: (req: { key?: string; cwd?: string; name?: string }, leafId?: string) => void;
  openPreview: (root: string, path: string, fileName?: string, leafId?: string) => void;
  openDiff: (cwd: string, commitHash: string | null, leafId?: string, filePath?: string | null, singleColumn?: boolean) => void;
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

/** 确保指定 cwd 在 cwdTrees 中有树，若无则创建。 */
function ensureCwdTree(state: SplitStore, cwd: string): { tree: SplitTree; isNew: boolean } {
  if (state.cwdTrees[cwd]) {
    return { tree: state.cwdTrees[cwd], isNew: false };
  }
  return { tree: createLeaf(), isNew: true };
}

/** 在 cwd 树中定位目标 leaf：优先 preferredId，其次第一个 leaf；无树或无 leaf 返回 null。 */
function findTargetLeaf(tree: SplitTree | undefined, preferredId: string | null): SplitLeaf | null {
  if (preferredId && tree) {
    const found = findLeafInTree(tree, preferredId);
    if (found) return found;
  }
  return tree ? firstLeaf(tree) : null;
}

/** diff tab 的标题：有文件路径取文件名，否则取短 hash；工作区 diff 用固定文案。 */
function diffTabTitle(filePath: string | null | undefined, commitHash: string | null): string {
  if (filePath) return filePath.split('/').pop() ?? filePath;
  return commitHash ? commitHash.slice(0, 8) : '工作区改动';
}

/**
 * 打开/激活 tab 的公共收尾：已存在则取消隐藏并激活，否则在目标 leaf 新建并激活。
 * 统一了 openSession/openPreview/openDiff/openSessionContent/openTerminal 五个 action 的样板。
 */
function upsertTab(
  state: SplitStore,
  opts: {
    cwd: string; // 新建分支归属的 cwd
    id: string; // tab id
    existing: TabLoc | null; // 预先查重结果（null = 新建）
    scrollCompareCwd: string | null; // 切换离开旧 cwd 前保存滚动位置；null = 不保存
    preferredLeafId: string | null; // 目标 leaf（默认 activeLeafId）
    createTab: (leaf: SplitLeaf) => Tab; // 依据目标 leaf 构造新 tab
  },
): Partial<SplitStore> {
  const captureOldScroll = () => captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

  if (opts.existing) {
    const { cwd, leaf, tab } = opts.existing;
    const tabs = leaf.tabs.map((t) => (t.id === tab.id ? { ...t, hidden: false } : t));
    const updatedLeaf: SplitLeaf = { ...leaf, tabs, activeTabId: tab.id };
    if (opts.scrollCompareCwd && opts.scrollCompareCwd !== state.activeCwd) captureOldScroll();
    return {
      cwdTrees: { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, updatedLeaf) },
      activeCwd: cwd,
      activeLeafId: leaf.id,
      cwdActiveLeafId: { ...state.cwdActiveLeafId, [cwd]: leaf.id },
      cwdTabHistory: pushTabHistory(state.cwdTabHistory, cwd, tab.id),
      cwdOrder: ensureCwdOrder(state.cwdOrder, cwd),
    };
  }

  if (opts.scrollCompareCwd && opts.scrollCompareCwd !== state.activeCwd) captureOldScroll();
  const { tree, isNew } = ensureCwdTree(state, opts.cwd);
  let cwdTrees = isNew ? { ...state.cwdTrees, [opts.cwd]: tree } : state.cwdTrees;

  let targetLeaf = findTargetLeaf(cwdTrees[opts.cwd], opts.preferredLeafId);
  if (!targetLeaf) {
    targetLeaf = createLeaf();
    cwdTrees = { ...cwdTrees, [opts.cwd]: targetLeaf };
  }
  const tab = opts.createTab(targetLeaf);
  const updatedLeaf: SplitLeaf = { ...targetLeaf, tabs: [...targetLeaf.tabs, tab], activeTabId: opts.id };
  cwdTrees = { ...cwdTrees, [opts.cwd]: updateLeaf(cwdTrees[opts.cwd], targetLeaf.id, updatedLeaf) };

  return {
    cwdTrees,
    activeCwd: opts.cwd,
    activeLeafId: updatedLeaf.id,
    cwdActiveLeafId: { ...state.cwdActiveLeafId, [opts.cwd]: updatedLeaf.id },
    cwdTabHistory: pushTabHistory(state.cwdTabHistory, opts.cwd, opts.id),
    cwdOrder: ensureCwdOrder(state.cwdOrder, opts.cwd),
  };
}

/**
 * 关闭 leaf 内最后一个 tab 的公共收尾：摘除该 leaf；若树因此为空则回退为空 leaf。
 * keepCwdActiveTab=true 时（closeTab 语义）只清理指向已删 tab 的记忆，否则清空该 cwd 的映射（remove* 语义）。
 */
function closeEmptyLeaf(
  state: SplitStore,
  cwd: string,
  leafId: string,
  keepCwdActiveTab: boolean,
): Partial<SplitStore> {
  const newTree = removeLeafFromTree(state.cwdTrees[cwd], leafId);
  if (!newTree) {
    const emptyLeaf = createLeaf();
    return {
      cwdTrees: { ...state.cwdTrees, [cwd]: emptyLeaf },
      activeTabId: null,
      activeLeafId: emptyLeaf.id,
      cwdActiveTab: keepCwdActiveTab ? updateCwdActiveTab(state.cwdActiveTab, [], cwd, null) : {},
      cwdTabHistory: {},
    };
  }
  const nextLeaf = firstLeaf(newTree);
  const nextActiveTabId = nextLeaf?.activeTabId ?? null;
  return {
    cwdTrees: { ...state.cwdTrees, [cwd]: newTree },
    activeTabId: nextActiveTabId,
    activeLeafId: nextLeaf?.id ?? null,
    cwdActiveTab: keepCwdActiveTab ? updateCwdActiveTab(state.cwdActiveTab, [], cwd, nextActiveTabId) : {},
    cwdTabHistory: cleanTabHistory(state.cwdTabHistory, nextLeaf?.tabs ?? []),
  };
}

/** 移除 leaf 中部分 tab 后的公共收尾：选定下一个激活 tab 并用更新后的 leaf 替换进树。 */
function removeTabsFromLeaf(
  state: SplitStore,
  cwd: string,
  leaf: SplitLeaf,
  remaining: Tab[],
  removedId: string,
  removedCwd: string,
): Partial<SplitStore> {
  const next = selectNextTabOnClose(
    remaining, removedId, removedCwd,
    leaf.activeTabId, state.activeCwd,
    state.cwdActiveTab, state.cwdTabHistory,
  );
  const updatedLeaf: SplitLeaf = {
    ...leaf,
    tabs: remaining,
    ...(next ? { activeTabId: next.activeTabId } : {}),
  };
  const cwdTrees = { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, updatedLeaf) };
  if (!next) return { cwdTrees };
  return { cwdTrees, activeTabId: next.activeTabId, cwdActiveTab: next.cwdActiveTab, cwdTabHistory: next.cwdTabHistory };
}

export const useSplitStore = create<SplitStore>((set, get) => ({

  // 初始化状态
  cwdTrees: {},
  activeCwd: null,
  activeLeafId: null,
  activeTabId: null,
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
        activeLeafId = firstLeaf(cwdTrees[cwd])?.id ?? null;
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
        activeTabId: activeTabId, // 由 active leaf 派生，供旧版读取
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
      const name = req.name || key;
      return upsertTab(state, {
        cwd: cwdVal,
        id: key,
        existing: findTabByKey(state.cwdTrees, key),
        scrollCompareCwd: cwdVal,
        preferredLeafId: resolveLeafId(state, leafId),
        createTab: (leaf) => ({
          id: key,
          kind: 'session',
          location: 'editor',
          title: name,
          hidden: false,
          order: nextOrder(leaf.tabs),
          key,
          cwd: cwdVal,
          name,
        }),
      });
    }),
  openPreview: (root, path, fileName, leafId) =>
    set((state) => {
      const id = `preview:${root}//${path}`;
      return upsertTab(state, {
        cwd: root,
        id,
        existing: findTabById(state.cwdTrees, id),
        scrollCompareCwd: root,
        preferredLeafId: resolveLeafId(state, leafId),
        createTab: (leaf) => ({
          id,
          kind: 'preview',
          location: 'editor',
          title: fileName || path.split('/').pop() || path,
          hidden: false,
          order: nextOrder(leaf.tabs),
          root,
          path,
        }),
      });
    }),

  openDiff: (cwd, commitHash, leafId, filePath, singleColumn) =>
    set((state) => {
      const fp = filePath ?? '';
      const id = `diff:${cwd}//${commitHash ?? 'work'}` + (fp ? `/${fp}` : '');
      return upsertTab(state, {
        cwd,
        id,
        existing: findTabById(state.cwdTrees, id),
        scrollCompareCwd: cwd,
        preferredLeafId: resolveLeafId(state, leafId),
        createTab: (leaf) => ({
          id,
          kind: 'diff',
          location: 'editor',
          title: diffTabTitle(filePath, commitHash),
          hidden: false,
          order: nextOrder(leaf.tabs),
          cwd,
          commitHash,
          filePath,
          singleColumn,
        }),
      });
    }),

  openSessionContent: (sessionKey, sessionName, cwd, leafId) =>
    set((state) => {
      const id = `session-content:${sessionKey}`;
      return upsertTab(state, {
        cwd,
        id,
        existing: findTabById(state.cwdTrees, id),
        scrollCompareCwd: cwd,
        preferredLeafId: resolveLeafId(state, leafId),
        createTab: (leaf) => ({
          id,
          kind: 'session-content',
          location: 'editor',
          title: sessionName,
          hidden: false,
          order: nextOrder(leaf.tabs),
          sessionKey,
          sessionName,
          cwd,
        }),
      });
    }),

  openTerminal: (id, cwd, title, leafId) =>
    set((state) =>
      upsertTab(state, {
        cwd,
        id,
        existing: findTabById(state.cwdTrees, id),
        // 终端 tab 由主进程 create/destroy 事件驱动，不需要在切换 cwd 时保存旧 cwd 的滚动位置
        scrollCompareCwd: null,
        preferredLeafId: resolveLeafId(state, leafId),
        createTab: (leaf) => ({
          id,
          kind: 'integrated-terminal',
          location: 'editor',
          title,
          hidden: false,
          order: nextOrder(leaf.tabs),
          cwd,
        }),
      }),
    ),

  selectTab: (id) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;

      if (cwd !== state.activeCwd) captureOldCwdScrollStates(collectAllTabs(state.cwdTrees), state.activeCwd);

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, { ...leaf, activeTabId: id }) },
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
      const remaining = leaf.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        // 最后一个 tab → 关闭 leaf（cwdActiveTab 只清理指向已删 tab 的记忆）
        return closeEmptyLeaf(state, cwd, leaf.id, true);
      }
      return removeTabsFromLeaf(state, cwd, leaf, remaining, id, getTabCwd(found.tab));
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
        const next = selectNextTabOnClose(
          tabs, id, getTabCwd(found.tab),
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

      patch.cwdTrees = { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, updatedLeaf) };
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
        // 取消隐藏且当前无激活 → 激活它
        updatedLeaf.activeTabId = id;
        patch.activeTabId = id;
        if (state.activeCwd) {
          patch.cwdActiveTab = updateCwdActiveTab(state.cwdActiveTab, tabs, state.activeCwd, id);
          patch.cwdTabHistory = pushTabHistory(state.cwdTabHistory, state.activeCwd, id);
        }
      } else if (hidden && leaf.activeTabId === id) {
        const next = selectNextTabOnClose(
          tabs, id, getTabCwd(found.tab),
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

      patch.cwdTrees = { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, updatedLeaf) };
      return patch;
    }),

  reorderTabsInLeaf: (leafId, orderedIds) =>
    set((state) => {
      const found = findLeaf(state.cwdTrees, leafId);
      if (!found) return {};
      const { cwd, leaf } = found;

      const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
      const tabs = leaf.tabs.map((t) => {
        const order = orderMap.get(t.id);
        return order !== undefined ? { ...t, order } : t;
      });

      const updatedLeaf: SplitLeaf = { ...leaf, tabs };
      return { cwdTrees: { ...state.cwdTrees, [cwd]: updateLeaf(state.cwdTrees[cwd], leaf.id, updatedLeaf) } };
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
      if (remaining.length === 0) return closeEmptyLeaf(state, cwd, leaf.id, false);
      return removeTabsFromLeaf(state, cwd, leaf, remaining, found.tab.id, getTabCwd(found.tab));
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
      if (remaining.length === 0) return closeEmptyLeaf(state, cwd, leaf.id, false);
      return removeTabsFromLeaf(state, cwd, leaf, remaining, id, getTabCwd(found.tab));
    }),

  closeCenterTab: (id) =>
    set((state) => {
      const found = findTabById(state.cwdTrees, id);
      if (!found) return {};
      const { cwd, leaf } = found;
      // session/terminal 与 preview/diff 均为真移除（非 keep-alive），走同一套收尾逻辑
      const remaining = leaf.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) return closeEmptyLeaf(state, cwd, leaf.id, false);
      return removeTabsFromLeaf(state, cwd, leaf, remaining, id, getTabCwd(found.tab));
    }),

  promoteTabNames: (diskList) =>
    set((state) => {
      const { cwdTrees, changed } = mapCwdTrees(state.cwdTrees, (node) => {
        if (node.type !== 'leaf') return node;
        const tabs = node.tabs.map((tab) => {
          if (tab.kind !== 'session') return tab;
          const d = diskList.find((x) => x.key === (tab as SessionTab).key);
          return d && d.name && d.name !== tab.name ? { ...tab, name: d.name, title: d.name } : tab;
        });
        return tabs.every((t, i) => t === node.tabs[i]) ? node : { ...node, tabs };
      });
      return changed ? { cwdTrees } : {};
    }),

  renameSessionTab: (key, name) =>
    set((state) => {
      const { cwdTrees, changed } = mapCwdTrees(state.cwdTrees, (node) => {
        if (node.type !== 'leaf') return node;
        const tabs = node.tabs.map((tab) =>
          tab.kind === 'session' && (tab as SessionTab).key === key ? { ...tab, name, title: name } : tab,
        );
        return tabs.every((t, i) => t === node.tabs[i]) ? node : { ...node, tabs };
      });
      return changed ? { cwdTrees } : {};
    }),

  updateTabTitle: (id, title) =>
    set((state) => {
      const { cwdTrees, changed } = mapCwdTrees(state.cwdTrees, (node) => {
        if (node.type !== 'leaf') return node;
        const tabs = node.tabs.map((tab) => (tab.id === id && tab.title !== title ? { ...tab, title } : tab));
        return tabs.every((t, i) => t === node.tabs[i]) ? node : { ...node, tabs };
      });
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
      const newTree = updateLeaf(state.cwdTrees[cwd], leafId, splitNode);

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
      const newTree = updateLeaf(state.cwdTrees[cwd], leafId, splitNode);

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

      // 树中只剩这一个 leaf → 清空它
      if (firstLeaf(tree)?.id === leaf.id) {
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
      const nextLeaf = firstLeaf(newTree);

      return {
        cwdTrees: { ...state.cwdTrees, [cwd]: newTree },
        activeLeafId: nextLeaf?.id ?? null,
        activeTabId: nextLeaf?.activeTabId ?? null,
      };
    }),

  setRatios: (nodeId, ratios) =>
    set((state) => ({
      cwdTrees: mapCwdTrees(state.cwdTrees, (node) =>
        node.type !== 'leaf' && node.id === nodeId ? { ...node, ratios } : node,
      ).cwdTrees,
    })),

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
          const next = selectNextTabOnClose(
            sourceRemaining, tabId, getTabCwd(tab),
            sourceLeaf.activeTabId, state.activeCwd,
            state.cwdActiveTab, state.cwdTabHistory,
          );
          updatedSourceLeaf = { ...updatedSourceLeaf, activeTabId: next?.activeTabId ?? null };
        }

        cwdTrees = { ...cwdTrees, [sourceCwd]: updateLeaf(cwdTrees[sourceCwd], sourceLeafId, updatedSourceLeaf) };
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

      cwdTrees = { ...cwdTrees, [targetCwd]: updateLeaf(cwdTrees[targetCwd], targetLeafId, updatedTargetLeaf) };

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
