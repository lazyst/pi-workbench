// 自定义左右分栏 diff 视图（side-by-side），对齐 VS Code Diff Editor 的阅读体验。
// 输入：git 的 unified diff 文本（由 gitDiff 生成）。
// 解析复用 parseUnifiedPatch：每个 row 同时含 left/right 两个 cell。
// 渲染：一行两格——左侧旧代码（removed），右侧新代码（added），中间一竖分隔；
// 仅变更行着色，上下文行淡显。相比单栏 unified，可同时看到删改前后。
import { useCallback, useState } from 'react';
import { parseUnifiedPatch } from '../lib/patch';
import type { SplitDiffFile, SplitDiffRow, SplitDiffCell } from '../lib/patch';

interface Props {
  diff: string;
}

type ExpandState = Record<string, boolean>;

function countChanges(rows: SplitDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'line') {
      if (row.left.type === 'removed') removed++;
      if (row.right.type === 'added') added++;
    }
  }
  return { added, removed };
}

function displayName(file: SplitDiffFile): string {
  const raw = file.newPath || file.oldPath || '';
  return raw.replace(/^[ab]\//, '') || '（未命名文件）';
}

function dirName(file: SplitDiffFile): string {
  const raw = displayName(file);
  const idx = raw.lastIndexOf('/');
  return idx > 0 ? raw.slice(0, idx + 1) : '';
}

function baseName(file: SplitDiffFile): string {
  const raw = displayName(file);
  const idx = raw.lastIndexOf('/');
  return idx > 0 ? raw.slice(idx + 1) : raw;
}

/** 单格内容：空行时显示占位空格，保持列高一致。 */
function Cell({ cell }: { cell: SplitDiffCell }) {
  const type = cell.type;
  return (
    <div
      className={`sdv-cell ${type === 'removed' ? 'sdv-cell-r' : type === 'added' ? 'sdv-cell-a' : 'sdv-cell-c'}`}
    >
      <span className="sdv-cell-no">{cell.lineNo ?? ''}</span>
      <span className="sdv-cell-text">{cell.text || '\u00a0'}</span>
    </div>
  );
}

export function SideBySideDiffView({ diff }: Props) {
  const files = parseUnifiedPatch(diff);

  const [expanded, setExpanded] = useState<ExpandState>(() => {
    if (!files || files.length === 0) return {};
    return { [displayName(files[0])]: true };
  });

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  if (!files || files.length === 0) {
    return <div className="git-empty">无改动</div>;
  }

  return (
    <div className="sdx">
      {files.map((file) => {
        const name = displayName(file);
        const { added, removed } = countChanges(file.rows);
        const isExpanded = expanded[name] ?? false;

        return (
          <div key={name} className="sdx-file">
            {/* 可点击的文件名横条 */}
            <div
              className="sdx-file-header"
              role="button"
              tabIndex={0}
              onClick={() => toggle(name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(name); } }}
            >
              <span className="sdx-file-header-icon">{isExpanded ? '▼' : '▶'}</span>
              <span className="sdx-file-header-dir">{dirName(file)}</span>
              <span className="sdx-file-header-name">{baseName(file)}</span>
              <span className="sdx-file-header-stats">
                {added > 0 && <span className="sdx-stat-added">+{added}</span>}
                {removed > 0 && <span className="sdx-stat-removed">-{removed}</span>}
              </span>
            </div>

            {isExpanded && (
              <div className="sdx-body">
                {/* 列头提示栏 */}
                <div className="sdx-col-headers">
                  <span className="sdx-col-header sdx-col-header-old">旧版本</span>
                  <span className="sdx-col-header sdx-col-header-new">新版本</span>
                </div>
                {file.rows.map((row, ri) => {
                  if (row.type === 'hunk') {
                    return (
                      <div key={ri} className="sdx-hunk">
                        {row.text}
                      </div>
                    );
                  }
                  const { left, right } = row;
                  return (
                    <div key={ri} className="sdx-row">
                      <Cell cell={left} />
                      <Cell cell={right} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}