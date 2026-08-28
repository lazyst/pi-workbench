// 拖拽创建分屏的边缘条带 droppable（ADR-0003：拖到边缘创建分屏）
//
// 拖拽激活时（SplitPaneDragProvider 的 isDragging=true）由 SplitPaneLeaf 在内容区渲染
// 4 条 EdgeSplitZone（上/下/左/右）——命中即创建对应方向的分屏。
// 内容区中央不设落点（简化）：移入窗格只能拖到目标窗格的 Tab 条（leaf-{leafId}）。
//
// id 规则：split-edge:{leafId}:{side} → SplitPaneDragProvider 据此区分分屏方向。
//
// 纯渲染组件，无内部状态机，逻辑全部由父层 onDragOver/onDragEnd 处理（对齐 SplitDivider 风格）。

import { useDroppable } from '@dnd-kit/core';

export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';

interface EdgeSplitZoneProps {
  leafId: string;
  side: EdgeSide;
}

export function EdgeSplitZone({ leafId, side }: EdgeSplitZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `split-edge:${leafId}:${side}` });
  return (
    <div
      ref={setNodeRef}
      className={`split-edge-zone split-edge-zone--${side}${isOver ? ' split-edge-zone--hover' : ''}`}
    />
  );
}