// Pure helpers for the draggable sidebar width (ticket: draggable-sidebar).
// Kept framework-free so the clamp logic can be unit-tested without a DOM.

// 绝对地板：侧边栏再窄也不能窄于 200px。
export const SIDEBAR_MIN_WIDTH = 200;
// 上限系数：侧边栏宽度不能超过窗口宽度的 60%（见 docs/adr/0001 决策④）。
export const SIDEBAR_MAX_RATIO = 0.6;

// 右栏（文件树 / Git）拖拽宽度约束，与侧边栏同思路。
export const RIGHT_PANEL_MIN_WIDTH = 200;
// 上限系数：右栏宽度不能超过窗口宽度的 60%。
export const RIGHT_PANEL_MAX_RATIO = 0.6;

/**
 * 构造一个把期望宽度夹进 [min, floor(windowWidth * maxRatio)] 区间的函数。
 * maxRatio 上限以「向下取整」计算；若窗口极窄导致 max < min，则绝对地板 min 胜出
 * （窗口最小尺寸为 480px，故实践中 60% ≥ 288 ≥ 200，不会真出现地板 > 上限）。
 */
function makeWidthClamp(min: number, maxRatio: number) {
  return (width: number, windowWidth: number): number => {
    const max = Math.max(min, Math.floor(windowWidth * maxRatio));
    return Math.max(min, Math.min(Math.round(width), max));
  };
}

export const clampSidebarWidth = makeWidthClamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_RATIO);
export const clampRightPanelWidth = makeWidthClamp(RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_RATIO);
