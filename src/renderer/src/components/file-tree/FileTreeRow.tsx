// ─────────────────────────────────────────────────────────────────────────────
// 文件树单行组件
// 使用 lucide-react 图标，集成 git 状态、inline 编辑、拖拽等交互。
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { FolderIcon, getFileIcon } from '../FileIcons';
import type { FileNode, GitFileStatusEntry } from './file-tree-types';

interface FileTreeRowProps {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isCut: boolean;
  isDropTarget: boolean;
  isEditing: boolean;
  editingValue: string;
  draggable: boolean;
  isRoot?: boolean;
  gitCategory: string;
  gitBadge: string;
  isStaged: boolean;
  isUnstaged: boolean;
  isSymlink: boolean;
  isSubmodule: boolean;
  showIgnored: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOverDir: (e: React.DragEvent) => void;
  onDragLeaveDir: () => void;
  onDropOnDir: (e: React.DragEvent) => void;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
}

export function FileTreeRow({
  node,
  depth,
  isExpanded,
  isLoading,
  isSelected,
  isFocused,
  isCut,
  isDropTarget,
  isEditing,
  editingValue,
  draggable,
  isRoot,
  gitCategory,
  gitBadge,
  isStaged,
  isUnstaged,
  isSymlink,
  isSubmodule,
  showIgnored,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOverDir,
  onDragLeaveDir,
  onDropOnDir,
  onCommitEdit,
  onCancelEdit,
}: FileTreeRowProps) {
  // ── CSS 类名 ──
  // git-${gitCategory} 已在上方为所有类别添加一次，下方仅需为 modified 的
  // staged/unstaged 组合补充额外标记。
  const className = [
    'file-row',
    isSelected ? 'selected' : '',
    isFocused ? 'focused' : '',
    isCut ? 'cut-pending' : '',
    isDropTarget ? 'drop-target' : '',
    isEditing ? 'editing' : '',
    isRoot ? 'is-root' : '',
    gitCategory ? `git-${gitCategory}` : '',
    showIgnored ? 'git-ignored' : '',
    gitCategory === 'modified' && isStaged && !isUnstaged ? 'git-staged' : '',
    gitCategory === 'modified' && isUnstaged && !isStaged ? 'git-unstaged' : '',
    gitCategory === 'modified' && isStaged && isUnstaged ? 'git-staged-unstaged' : '',
  ].filter(Boolean).join(' ');

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (node.isDir) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      onDragOverDir(e);
    }
  }, [node.isDir, onDragOverDir]);

  const handleDragLeave = useCallback(() => {
    if (node.isDir) onDragLeaveDir();
  }, [node.isDir, onDragLeaveDir]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (node.isDir) {
      e.preventDefault();
      onDragLeaveDir();
      onDropOnDir(e);
    }
  }, [node.isDir, onDragLeaveDir, onDropOnDir]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onCommitEdit((e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      onCancelEdit();
    }
  }, [onCommitEdit, onCancelEdit]);

  const handleInputBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    onCommitEdit(e.target.value);
  }, [onCommitEdit]);

  return (
    <div
      className={className}
      draggable={draggable && !isEditing && !isRoot}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {/* 展开/折叠箭头 */}
      {node.isDir ? (
        <ChevronRight
          size={10}
          strokeWidth={1.8}
          className="file-row-chevron"
          style={{
            flexShrink: 0,
            transform: isExpanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.1s',
          }}
        />
      ) : (
        <span className="file-row-spacer" />
      )}

      {/* 图标 */}
      <span className="file-row-icon">
        {node.isDir ? (
          <FolderIcon size={14} open={isExpanded} />
        ) : (
          getFileIcon(node.name, 14)
        )}
      </span>

      {/* 文件名或编辑输入框 */}
      {isEditing ? (
        <input
          className="file-rename-input"
          autoFocus
          defaultValue={editingValue}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
        />
      ) : (
        <span className="file-name" title={node.fullPath}>
          {node.name}
          {isSymlink && <span className="git-symlink-arrow"> →</span>}
        </span>
      )}

      {/* 子模块徽章 */}
      {isSubmodule && (
        <span className="git-badge-submodule" title={gitBadge === 'submodule-dirty' ? '子模块有未推送改动' : '子模块'}>
          S
        </span>
      )}

      {/* Git 状态徽章 */}
      {gitBadge && !isEditing && (
        <span className={`git-badge git-badge-${gitCategory}`} title={gitBadge}>
          {gitBadge}
        </span>
      )}

      {/* 加载指示器 */}
      {isLoading && (
        <Loader2 size={10} className="file-row-loading" />
      )}
    </div>
  );
}