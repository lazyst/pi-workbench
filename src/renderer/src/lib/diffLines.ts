// 从 unified diff 文本解析出「变更行号区间」，用于 Monaco 编辑器行号旁标记。
// 输入：gitFileDiff / gitDiff 产出的 unified diff。
// 输出：按行号升序的变更块数组，每个块含该文件新旧版本的行号区间。
//
// 变更分类：
//   • added   —— 新版本新增行（旧版本无对应行）
//   • removed —— 新版本删除行（旧版本有、新版本无）
//   • context —— 上下文行（未变更，仅用于定位）
// 为 Monaco 标记，我们按「新版本行号」给出 added/removed 区间：
//   标记 added 行 → 新版本该行号（绿色）
//   标记 removed 行 → 新版本中该行被删除，用旧版本行号附近的新版本位置（红色）
// Monaco 的 gutter 装饰没有「删除行」概念，只能画在存在的一行上，
// 故 removed 区间映射到紧邻的上下文/新增行（VS Code 也是在删除行下方画短线）。

export interface DiffLineRange {
  /** 新版本起始行号（1-based）。 */
  startLine: number;
  /** 行数。 */
  count: number;
  type: 'added' | 'removed' | 'context';
  /** 该 hunk 的上下文行数（用于弹窗时展示）。 */
  context?: number;
}

export interface DiffHunk {
  /** 旧版本起始行号。 */
  oldStart: number;
  /** 旧版本行数。 */
  oldCount: number;
  /** 新版本起始行号。 */
  newStart: number;
  /** 新版本行数。 */
  newCount: number;
  /** 该 hunk 内的变更块（按出现顺序）。 */
  ranges: DiffLineRange[];
}

/** 解析所有 hunk 头。 */
function parseHunkHeaders(diff: string): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> {
  const headers: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    headers.push({
      oldStart: Number(m[1]),
      oldCount: m[2] ? Number(m[2]) : 1,
      newStart: Number(m[3]),
      newCount: m[4] ? Number(m[4]) : 1,
    });
  }
  return headers;
}

/** 解析每个 hunk 内部的变更行分组：返回分组后的变更块。 */
export function parseDiffLineChanges(diff: string): DiffHunk[] {
  const headers = parseHunkHeaders(diff);
  if (headers.length === 0) return [];

  const result: DiffHunk[] = [];
  const lines = diff.split(/\r?\n/);
  let headerIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('@@')) continue;

    const h = headers[headerIdx];
    headerIdx++;
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    const ranges: DiffLineRange[] = [];
    let pendingRemoved: DiffLineRange | null = null;

    // 从 hunk 头下一行开始读取变更行
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      // 遇到下一个 hunk 头或文件头，结束当前 hunk
      if (l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('+++ ')) break;

      const c = l.charAt(0);
      if (c === ' ') {
        // 上下文行：先 flush 挂起的 removed
        if (pendingRemoved) {
          ranges.push(pendingRemoved);
          pendingRemoved = null;
        }
        oldLine++;
        newLine++;
      } else if (c === '-') {
        // 删除行：累积到 pendingRemoved
        if (!pendingRemoved) {
          pendingRemoved = { startLine: newLine, count: 0, type: 'removed' };
        }
        pendingRemoved.count++;
        oldLine++;
      } else if (c === '+') {
        // 新增行：先 flush 挂起的 removed（确保删除行在新增行之前）
        if (pendingRemoved) {
          ranges.push(pendingRemoved);
          pendingRemoved = null;
        }
        ranges.push({ startLine: newLine, count: 1, type: 'added' });
        newLine++;
      } else if (c === '\\') {
        // "\ No newline at end of file" 忽略
        continue;
      } else {
        // 其他（如文件头）——结束当前 hunk
        break;
      }
    }

    if (pendingRemoved) ranges.push(pendingRemoved);
    result.push({
      oldStart: h.oldStart,
      oldCount: h.oldCount,
      newStart: h.newStart,
      newCount: h.newCount,
      ranges,
    });
  }

  return result;
}

/** 提取每个 hunk 的原始文本（用于 popup 展示），按新旧版本拆行。 */
export function extractHunkCompressed(diff: string): Array<{ newStart: number; lines: Array<{ type: 'add' | 'del' | 'ctx'; text: string; newLine: number | null }> }> {
  const result: Array<{ newStart: number; lines: Array<{ type: 'add' | 'del' | 'ctx'; text: string; newLine: number | null }> }> = [];
  const lines = diff.split(/\r?\n/);
  let inHunk = false;
  let newLine = 0;
  let current: { newStart: number; lines: [] } | null = null;

  for (const line of lines) {
    if (line.startsWith('@@ -')) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      inHunk = true;
      newLine = m ? Number(m[1]) : 0;
      current = { newStart: newLine, lines: [] as any };
      result.push(current as any);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@ -')) continue;
    const c = line.charAt(0);
    if (c === ' ') {
      (current! as any).lines.push({ type: 'ctx', text: line.slice(1), newLine });
      newLine++;
    } else if (c === '+') {
      (current! as any).lines.push({ type: 'add', text: line.slice(1), newLine });
      newLine++;
    } else if (c === '-') {
      (current! as any).lines.push({ type: 'del', text: line.slice(1), newLine: null });
    } else if (c === '\\') {
      (current! as any).lines.push({ type: 'ctx', text: line, newLine: null });
    }
  }
  return result;
}