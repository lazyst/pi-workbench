// ─────────────────────────────────────────────────────────────────────────────
// 文件树虚拟列表组件
// 使用 @tanstack/react-virtual 实现虚拟滚动，仅渲染可见行。
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** 滚动到底部时，最后一项下方预留的空位高度（对齐一行文件高度）。 */
const BOTTOM_PAD = 28;
import { FileTreeRow } from './FileTreeRow';
import type { VisibleRow, FileNode, GitFileStatusEntry } from './file-tree-types';

interface FileTreeVirtualRowsProps {
  rows: VisibleRow[];
  expandedPaths: Set<string>;
  selection: Set<string>;
  cutRelPaths: Set<string>;
  dropTarget: string | null;
  editing: { relPath: string; isNew: boolean; draftName: string } | null;
  draggable: boolean;
  gitStatusMap: Record<string, GitFileStatusEntry>;
  gitBubbleMap: Record<string, string>;
  isIgnored: (fullPath: string) => boolean;
  dirLoading: Set<string>;
  onRowClick: (node: FileNode, e: React.MouseEvent) => void;
  onRowContextMenu: (node: FileNode, e: React.MouseEvent) => void;
  onRowDragStart: (node: FileNode, e: React.DragEvent) => void;
  onRowDragOverDir: (node: FileNode, e: React.DragEvent) => void;
  onRowDragLeaveDir: (node: FileNode) => void;
  onRowDropOnDir: (node: FileNode, e: React.DragEvent) => void;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
}

export function FileTreeVirtualRows({
  rows,
  expandedPaths,
  selection,
  cutRelPaths,
  dropTarget,
  editing,
  draggable,
  gitStatusMap,
  gitBubbleMap,
  isIgnored,
  dirLoading,
  onRowClick,
  onRowContextMenu,
  onRowDragStart,
  onRowDragOverDir,
  onRowDragLeaveDir,
  onRowDropOnDir,
  onCommitEdit,
  onCancelEdit,
}: FileTreeVirtualRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  const handleClick = useCallback((node: FileNode, e: React.MouseEvent) => {
    onRowClick(node, e);
  }, [onRowClick]);

  const handleContextMenu = useCallback((node: FileNode, e: React.MouseEvent) => {
    onRowContextMenu(node, e);
  }, [onRowContextMenu]);

  const handleDragStart = useCallback((node: FileNode, e: React.DragEvent) => {
    onRowDragStart(node, e);
  }, [onRowDragStart]);

  const handleDragOverDir = useCallback((node: FileNode, e: React.DragEvent) => {
    onRowDragOverDir(node, e);
  }, [onRowDragOverDir]);

  const handleDragLeaveDir = useCallback((node: FileNode) => {
    onRowDragLeaveDir(node);
  }, [onRowDragLeaveDir]);

  const handleDropOnDir = useCallback((node: FileNode, e: React.DragEvent) => {
    onRowDropOnDir(node, e);
  }, [onRowDropOnDir]);

  if (rows.length === 0) {
    return null;
  }

  const virtualItems = virtualizer.getVirtualItems();

  // jsdom / 测试环境兜底：当 scroll 容器无可测高度时 virtualizer 返回 0 项，
  // 回退为非虚拟化渲染（逐行渲染所有 rows）。生产环境不受影响。
  if (virtualItems.length === 0) {
    return (
      <div
        ref={scrollRef}
        className="file-tree-virtual-scroll"
        style={{ overflowY: 'auto', height: '100%', minHeight: 0 }}
      >
        {rows.map((row, index) => {
          const node = row.node;
          const isEditing = editing != null &&
            ((editing.isNew && row.isDraft) || (!editing.isNew && editing.relPath === node.fullPath));
          const gitEntry = gitStatusMap[node.fullPath];
          const gitBubble = gitBubbleMap[node.fullPath];
          const gitCategory = gitEntry?.category ?? gitBubble ?? '';
          const showIgnored = !gitEntry && isIgnored(node.fullPath);

          return (
            <FileTreeRow
              key={node.fullPath}
              node={node}
              depth={row.depth}
              isExpanded={row.isExpanded}
              isLoading={dirLoading.has(node.fullPath)}
              isSelected={selection.has(node.fullPath)}
              isCut={cutRelPaths.has(node.fullPath)}
              isDropTarget={dropTarget === node.fullPath}
              isEditing={isEditing}
              editingValue={row.isDraft ? editing?.draftName ?? '' : node.name}
              draggable={draggable && !isEditing}
              gitCategory={gitCategory}
              gitBadge={gitEntry?.badge ?? ''}
              isStaged={gitEntry?.staged ?? false}
              isUnstaged={gitEntry?.unstaged ?? false}
              isSymlink={gitEntry?.isSymlink ?? false}
              isSubmodule={gitEntry?.isSubmodule ?? false}
              showIgnored={showIgnored}
              onClick={(e) => handleClick(node, e)}
              onContextMenu={(e) => handleContextMenu(node, e)}
              onDragStart={(e) => handleDragStart(node, e)}
              onDragOverDir={(e) => handleDragOverDir(node, e)}
              onDragLeaveDir={() => handleDragLeaveDir(node)}
              onDropOnDir={(e) => handleDropOnDir(node, e)}
              onCommitEdit={onCommitEdit}
              onCancelEdit={onCancelEdit}
            />
          );
        })}
        {/* 底部留白：滚动到底时最后一项下方预留空位 */}
        <div style={{ height: BOTTOM_PAD }} />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="file-tree-virtual-scroll"
      style={{ overflowY: 'auto', height: '100%', minHeight: 0 }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize() + BOTTOM_PAD,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          const node = row.node;
          const isEditing = editing != null &&
            ((editing.isNew && row.isDraft) || (!editing.isNew && editing.relPath === node.fullPath));
          const gitEntry = gitStatusMap[node.fullPath];
          const gitBubble = gitBubbleMap[node.fullPath];
          const gitCategory = gitEntry?.category ?? gitBubble ?? '';
          const showIgnored = !gitEntry && isIgnored(node.fullPath);

          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <FileTreeRow
                node={node}
                depth={row.depth}
                isExpanded={row.isExpanded}
                isLoading={dirLoading.has(node.fullPath)}
                isSelected={selection.has(node.fullPath)}
                isCut={cutRelPaths.has(node.fullPath)}
                isDropTarget={dropTarget === node.fullPath}
                isEditing={isEditing}
                editingValue={row.isDraft ? editing?.draftName ?? '' : node.name}
                draggable={draggable && !isEditing}
                gitCategory={gitCategory}
                gitBadge={gitEntry?.badge ?? ''}
                isStaged={gitEntry?.staged ?? false}
                isUnstaged={gitEntry?.unstaged ?? false}
                isSymlink={gitEntry?.isSymlink ?? false}
                isSubmodule={gitEntry?.isSubmodule ?? false}
                showIgnored={showIgnored}
                onClick={(e) => handleClick(node, e)}
                onContextMenu={(e) => handleContextMenu(node, e)}
                onDragStart={(e) => handleDragStart(node, e)}
                onDragOverDir={(e) => handleDragOverDir(node, e)}
                onDragLeaveDir={() => handleDragLeaveDir(node)}
                onDropOnDir={(e) => handleDropOnDir(node, e)}
                onCommitEdit={onCommitEdit}
                onCancelEdit={onCancelEdit}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}