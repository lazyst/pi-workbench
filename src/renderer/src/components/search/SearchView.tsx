// ─────────────────────────────────────────────────────────────────────────────
// 全局搜索面板（右栏第三个 Tab）。
//
// • ripgrep 后端：经 pi.searchRun 启动，结果增量推送。
// • 结果树：文件（可折叠）→ 匹配行（行号 + 高亮匹配片段 + 上下文）。
// • 点击匹配行 → onOpenFile(relPath, fileName, root, selection) 跳转并定位。
// • 选项：正则 / 区分大小写 / 全字；include / exclude glob。
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Search as SearchIcon,
  X,
  Loader2,
  Regex,
  CaseSensitive,
  WholeWord,
  ChevronRight,
  SlidersHorizontal,
} from 'lucide-react';
import { pi } from '../../ipc';
import { getFileIcon } from '../FileIcons';
import type {
  SearchFileResult,
  SearchMatch,
  SearchSubmatch,
  SearchOptions,
  SearchProgress,
  SearchSummary,
} from '../../types';

interface Props {
  /** 当前工作目录（搜索根）。null = 无会话，显示空态。 */
  cwd: string | null;
  onOpenFile: (
    relPath: string,
    fileName: string,
    root: string,
    selection?: { startLine: number; startColumn?: number; endLine?: number; endColumn?: number } | null,
  ) => void;
}

/** 扁平行：文件头或匹配行。 */
interface FlatRow {
  type: 'file' | 'match';
  path?: string;
  match?: SearchMatch;
}

const ROW_HEIGHT = 26;

/** 把匹配行渲染为「前文 + 高亮匹配 + 后文」片段。 */
function renderHighlighted(text: string, submatches: SearchSubmatch[]): React.ReactNode {
  if (!submatches.length) return <span className="search-line-text">{text}</span>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  submatches.forEach((s, i) => {
    const start = Math.max(0, s.startCol - 1); // 1-based → 0-based char
    const end = Math.max(start, s.endCol - 1);
    if (start > pos) parts.push(<span key={`t${i}`} className="search-line-text">{text.slice(pos, start)}</span>);
    parts.push(<mark key={`m${i}`} className="search-hit-mark">{text.slice(start, end)}</mark>);
    pos = end;
  });
  if (pos < text.length) parts.push(<span key="tail" className="search-line-text">{text.slice(pos)}</span>);
  return <>{parts}</>;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : '';
}

export function SearchView({ cwd, onOpenFile }: Props) {
  const [query, setQuery] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [results, setResults] = useState<SearchFileResult[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<SearchProgress>({ matches: 0, files: 0 });
  const [searching, setSearching] = useState(false);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const queryInputRef = useRef<HTMLInputElement>(null);

  // ── 启动搜索（query / 选项 / cwd 变化，200ms 防抖）──
  useEffect(() => {
    if (!cwd || !query.trim()) {
      setResults([]);
      setProgress({ matches: 0, files: 0 });
      setSearching(false);
      setSummary(null);
      setError(null);
      cancelRef.current?.();
      cancelRef.current = null;
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setResults([]);
      setCollapsed(new Set());
      setProgress({ matches: 0, files: 0 });
      setSummary(null);
      setError(null);
      setSearching(true);
      const opts: SearchOptions = {
        isRegex,
        matchCase,
        wholeWord,
        include: include || undefined,
        exclude: exclude || undefined,
      };
      const cancel = await pi.searchRun(
        cwd,
        query,
        opts,
        (file) => { if (!cancelled) setResults((prev) => [...prev, file]); },
        (p) => { if (!cancelled) setProgress(p); },
        (s) => { if (!cancelled) { setSearching(false); setSummary(s); } },
        (msg) => { if (!cancelled) { setSearching(false); setError(msg); } },
      );
      if (cancelled) {
        cancel();
      } else {
        cancelRef.current = cancel;
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [cwd, query, isRegex, matchCase, wholeWord, include, exclude]);

  // ── 扁平行投影 ──
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const f of results) {
      rows.push({ type: 'file', path: f.path });
      if (!collapsed.has(f.path)) {
        for (const m of f.matches) rows.push({ type: 'match', match: m });
      }
    }
    return rows;
  }, [results, collapsed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const handleMatchClick = useCallback(
    (m: SearchMatch) => {
      if (!cwd) return;
      const sub = m.submatches[0];
      const selection = sub
        ? { startLine: m.line, startColumn: sub.startCol, endColumn: sub.endCol }
        : { startLine: m.line };
      onOpenFile(m.path, basename(m.path), cwd, selection);
    },
    [cwd, onOpenFile],
  );

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  }, []);

  const clearQuery = useCallback(() => {
    setQuery('');
    queryInputRef.current?.focus();
  }, []);

  const hasQuery = query.trim().length > 0;
  const totalMatches = summary?.matches ?? progress.matches;
  const totalFiles = summary?.filesWithMatch ?? progress.files;

  // ── 渲染 ──
  if (!cwd) {
    return <div className="search-empty">先添加工作目录，即可在文件内容中搜索。</div>;
  }

  const renderRow = (row: FlatRow, key?: React.Key) => {
    if (row.type === 'file') {
      const path = row.path!;
      const isCollapsed = collapsed.has(path);
      return (
        <div
          key={key}
          className="search-file-row"
          onClick={() => toggleCollapse(path)}
        >
          <ChevronRight
            size={10}
            className="search-file-chevron"
            style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)' }}
          />
          <span className="search-file-icon">{getFileIcon(basename(path), 14)}</span>
          <span className="search-file-name" title={path}>{basename(path)}</span>
          <span className="search-file-dir" title={dirname(path)}>{dirname(path)}</span>
          <span className="search-file-count">
            {results.find((f) => f.path === path)?.matches.length ?? 0}
          </span>
        </div>
      );
    }
    const m = row.match!;
    return (
      <div
        key={key}
        className="search-match-row"
        onClick={() => handleMatchClick(m)}
        title={`打开 ${m.path}:${m.line}`}
      >
        <span className="search-line-number">{m.line}</span>
        <span className="search-line-content">{renderHighlighted(m.lineText, m.submatches)}</span>
      </div>
    );
  };

  const virtualItems = virtualizer.getVirtualItems();
  const showVirtual = flatRows.length > 0 && virtualItems.length > 0;

  return (
    <div className="search-view">
      {/* 查询区 */}
      <div className="search-input-area">
        <div className="search-input-row">
          <SearchIcon size={13} className="search-input-icon" />
          <input
            ref={queryInputRef}
            className="search-input"
            placeholder="搜索文件内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (hasQuery) clearQuery();
              }
            }}
          />
          {hasQuery && (
            <button className="search-clear-btn" onClick={clearQuery} title="清空">
              <X size={13} />
            </button>
          )}
          <button
            className={`search-toggle-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters((v) => !v)}
            title="包含/排除"
          >
            <SlidersHorizontal size={13} />
          </button>
        </div>
        <div className="search-options">
          <button
            className={`search-toggle-btn ${isRegex ? 'active' : ''}`}
            onClick={() => setIsRegex((v) => !v)}
            title="正则表达式"
          >
            <Regex size={14} />
          </button>
          <button
            className={`search-toggle-btn ${matchCase ? 'active' : ''}`}
            onClick={() => setMatchCase((v) => !v)}
            title="区分大小写"
          >
            <CaseSensitive size={15} />
          </button>
          <button
            className={`search-toggle-btn ${wholeWord ? 'active' : ''}`}
            onClick={() => setWholeWord((v) => !v)}
            title="全字匹配"
          >
            <WholeWord size={14} />
          </button>
          {searching && <Loader2 size={13} className="search-spinner" />}
        </div>
        {showFilters && (
          <div className="search-filters">
            <input
              className="search-glob-input"
              placeholder="包含（如 *.ts, *.tsx）"
              value={include}
              onChange={(e) => setInclude(e.target.value)}
            />
            <input
              className="search-glob-input"
              placeholder="排除（如 node_modules, *.test.*）"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* 状态条 */}
      {hasQuery && (searching || totalMatches > 0 || error) && (
        <div className="search-status">
          {error ? (
            <span className="search-error">{error}</span>
          ) : (
            <span className="search-count">
              {searching && progress.matches === 0 ? '搜索中…' : null}
              {!searching || progress.matches > 0
                ? `${totalMatches} 处结果 · ${totalFiles} 个文件${searching ? '…' : ''}`
                : null}
            </span>
          )}
        </div>
      )}

      {/* 结果树 */}
      <div className="search-results" ref={scrollRef}>
        {error ? null : showVirtual ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualItems.map((vi) => {
              const row = flatRows[vi.index];
              return (
                <div
                  key={vi.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        ) : flatRows.length > 0 ? (
          // jsdom 兜底：virtualizer 无可测高度时逐行渲染
          flatRows.map((row) => renderRow(row, row.type === 'file' ? `f-${row.path}` : `m-${row.match!.path}-${row.match!.line}`))
        ) : hasQuery && !searching ? (
          <div className="search-empty">无结果</div>
        ) : hasQuery && searching ? (
          <div className="search-empty">搜索中…</div>
        ) : (
          <div className="search-empty">输入关键词搜索文件内容。</div>
        )}
      </div>
    </div>
  );
}
