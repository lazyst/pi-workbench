// 向后兼容重导出
// tabStore 已被 splitStore 替代。此文件保留所有导出，
// 指向 splitStore 的实现，使现有 import 无需修改。

import { useSplitStore, selectNextTabOnClose, getTabCwd, cwdVisibleTabs } from './splitStore';
import type { Tab as SplitTab, TabKind, TabLocation, BaseTab, SessionTab, PreviewTab, DiffTab, IntegratedTerminalTab, SessionContentTab } from './splitStore';
import type { PreviewSelection } from '../types';

// 重新导出所有类型
export type { TabKind, TabLocation };
export type { BaseTab, SessionTab, PreviewTab, DiffTab, IntegratedTerminalTab, SessionContentTab };
export type { PreviewSelection } from '../types';
export type Tab = SplitTab;
export { getTabCwd, cwdVisibleTabs };
export { selectNextTabOnClose };

// 向后兼容：TabStore 接口用于 type reference
export interface TabStore {
  tabs: SplitTab[];
  activeTabId: string | null;
  activeCwd: string | null;
  cwdOrder: string[];
  cwdActiveTab: Record<string, string | null>;
  cwdTabHistory: Record<string, string[]>;
  terminals: import('../types').IntegratedTerminalInfo[];
  setActiveCwd: (cwd: string) => void;
  openSession: (req: { key?: string; cwd?: string; name?: string }) => void;
  openPreview: (root: string, path: string, fileName?: string, selection?: PreviewSelection | null) => void;
  openDiff: (cwd: string, commitHash: string | null, leafId?: string, filePath?: string | null, singleColumn?: boolean) => void;
  openSessionContent: (sessionKey: string, sessionName: string, cwd: string) => void;
  openTerminal: (id: string, cwd: string, title: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  hideTab: (id: string) => void;
  reorderTabs: (orderedIds: string[]) => void;
  setHidden: (id: string, hidden: boolean) => void;
  setTerminals: (list: import('../types').IntegratedTerminalInfo[]) => void;
  removeSessionTab: (key: string) => void;
  removeTerminalTab: (id: string) => void;
  closeCenterTab: (id: string) => void;
  promoteTabNames: (diskList: { key: string; name: string }[]) => void;
  renameSessionTab: (key: string, name: string) => void;
  // 终端 OSC 0 标题变化时更新 tab 标题（pi 扩展 spinner 标题帧 / shell 自设标题）。
  updateTabTitle: (id: string, title: string) => void;
}

// useTabStore 指向 useSplitStore（向后兼容）
export const useTabStore = useSplitStore;