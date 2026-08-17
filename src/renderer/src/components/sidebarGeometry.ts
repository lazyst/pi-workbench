// Pure helpers for the draggable sidebar width (ticket: draggable-sidebar).
// Kept framework-free so the clamp logic can be unit-tested without a DOM.

// 绝对地板：侧边栏再窄也不能窄于 200px。
export const SIDEBAR_MIN_WIDTH = 200;
// 上限系数：侧边栏宽度不能超过窗口宽度的 60%（见 docs/adr/0001 决策④）。
export const SIDEBAR_MAX_RATIO = 0.6;

// 把期望宽度夹进 [200px, 60% 窗口宽] 区间。
// 60% 上限以「向下取整」计算；若窗口极窄导致 60% < 200，则绝对地板 200 胜出
// （窗口最小尺寸为 480px，故实践中 60% ≥ 288 ≥ 200，不会真出现地板 > 上限）。
export function clampSidebarWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth * SIDEBAR_MAX_RATIO));
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(Math.round(width), max));
}

// 右栏（文件树 / Git）拖拽宽度约束，与文件面板同思路。
export const RIGHT_PANEL_MIN_WIDTH = 200;
export const RIGHT_PANEL_MAX_RATIO = 0.5;

export function clampRightPanelWidth(width: number, windowWidth: number): number {
  const max = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.floor(windowWidth * RIGHT_PANEL_MAX_RATIO));
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(Math.round(width), max));
}
