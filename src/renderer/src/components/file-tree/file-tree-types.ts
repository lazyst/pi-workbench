// ─────────────────────────────────────────────────────────────────────────────
// 文件树类型定义（提取自 FileTree.tsx，供子模块共享）
// ─────────────────────────────────────────────────────────────────────────────

/** 文件树节点（目录或文件）。 */
export interface FileNode {
  name: string;
  fullPath: string; // path relative to the tree root
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

/** 内联编辑态（新建伪节点或重命名）。 */
export interface EditingState {
  relPath: string;     // 对新建：父目录相对路径(''为根)；对重命名：节点自身相对路径
  isDir: boolean;
  isNew: boolean;
  draftName: string;
}

/** 右键菜单状态。 */
export interface MenuState {
  x: number;
  y: number;
  target: { relPath: string; isDir: boolean } | null;
}

/** 扁平行投影中的一行。 */
export interface VisibleRow {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  /** 此行是否为新建伪节点行（仅用于定位 inline input）。 */
  isDraft?: boolean;
}

/** Git 文件状态条目。 */
export interface GitFileStatusEntry {
  category: string;
  staged: boolean;
  unstaged: boolean;
  badge: string;
  isSymlink?: boolean;
  isSubmodule?: boolean;
  submoduleDirty?: boolean;
}