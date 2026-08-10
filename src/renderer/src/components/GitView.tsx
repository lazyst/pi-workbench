// Git panel — read-only viewer + write operations (stage / unstage / commit / revert / branch / sync)
// Ported interaction model from VS Code Source Control view.
// Three groups: Staged Changes, Changes, Untracked Changes.
// Top: commit message input + branch/sync row.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pi } from '../ipc';

// ── Types ──

interface LogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface GitResource {
  path: string;
  /** 'staged' (index only), 'unstaged' (working tree only), 'both' (both have changes), 'untracked' */
  group: 'staged' | 'unstaged' | 'untracked';
  /** Badge letter: M / A / D / R / C / U / T / ? */
  badge: string;
  /** Rename target path (only for R status) */
  renameTarget?: string;
}

interface Props {
  cwd: string;
  onOpenWorkDiff: (cwd: string) => void;
  onOpenCommit: (cwd: string, hash: string) => void;
}

// ── Porcelain parser ──

export function parseResources(porcelain: string): GitResource[] {
  const resources: GitResource[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    // Skip the ## branch header line (e.g. "## main...origin/main [ahead 3]")
    if (line.startsWith('## ')) continue;
    const xy = line.substring(0, 2);
    const pathPart = line.substring(3).trim();
    const [fromPath, toPath] = pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart, undefined];
    const actualPath = toPath?.trim() ?? fromPath.trim();

    const x = xy[0];
    const y = xy[1];

    if (xy === '??') {
      resources.push({ path: actualPath, group: 'untracked', badge: '?' });
      continue;
    }

    // Conflict detection: U in either XY position indicates a merge conflict
    const isConflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (isConflict) {
      // Show conflict files only in the unstaged group with '!' badge
      resources.push({ path: actualPath, group: 'unstaged', badge: '!' });
      continue;
    }

    // Index (staged) changes
    let stagedBadge = '';
    const xMap: Record<string, string> = { ' ': '', M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', '?': '' };
    if (x !== ' ' && x !== '?') {
      stagedBadge = xMap[x] ?? 'M';
    }

    // Working tree (unstaged) changes
    let unstagedBadge = '';
    const yMap: Record<string, string> = { ' ': '', M: 'M', D: 'D', A: 'A', '?': '' };
    if (y !== ' ' && y !== '?' && y !== '!') {
      unstagedBadge = yMap[y] ?? 'M';
    }

    if (stagedBadge) {
      resources.push({
        path: actualPath,
        group: 'staged',
        badge: stagedBadge,
        renameTarget: toPath?.trim(),
      });
    }
    if (unstagedBadge) {
      resources.push({
        path: actualPath,
        group: 'unstaged',
        badge: unstagedBadge,
      });
    }
  }
  return resources;
}

// ── UI helpers ──

function FileIcon({ badge }: { badge: string }) {
  const icon = badge === 'M' ? '✏️' : badge === 'A' || badge === '?' ? '📄' : badge === 'D' ? '🗑️' : badge === 'R' ? '📎' : badge === '!' ? '⚠️' : '📄';
  return <span className="git-file-icon">{icon}</span>;
}

function Badge({ badge, group }: { badge: string; group: string }) {
  const cls = badge === 'M' ? 'git-badge-modified' :
    badge === 'A' || badge === '?' ? 'git-badge-added' :
    badge === 'D' ? 'git-badge-deleted' :
    badge === '!' ? 'git-badge-conflict' : '';
  return <span className={`git-badge ${cls}`} data-group={group}>{badge}</span>;
}

function Spinner() {
  return <span className="git-spinner" title="Operation in progress">⟳</span>;
}

// ── Main component ──

export function GitView({ cwd, onOpenWorkDiff, onOpenCommit }: Props) {
  // ── State ──
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; remote: boolean }>>([]);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState<{
    isGit: boolean; branch: string | null; additions: number; deletions: number;
    ahead: number; behind: number; porcelain: string;
  } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [resources, setResources] = useState<GitResource[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [activeOps, setActiveOps] = useState<Set<string>>(new Set());

  // Expand/collapse groups
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    staged: true, unstaged: true, untracked: true,
  });

  // ── Data fetching ──

  const refresh = useCallback(async () => {
    if (!cwd) { setStatus(null); setLog([]); setResources([]); return; }
    try {
      const s = await pi.gitStatus(cwd);
      setStatus(s);
      if (s.isGit) {
        const [l, br] = await Promise.all([
          pi.gitLog(cwd, 50),
          pi.gitBranches(cwd).catch(() => []),
        ]);
        setLog(l);
        setBranches(br);
        setResources(parseResources(s.porcelain ?? ''));
      } else {
        setLog([]);
        setResources([]);
      }
    } catch {
      setStatus(null); setLog([]); setResources([]);
    }
  }, [cwd]);

  // Debounced refresh (800ms + throttle)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshQueued = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (refreshQueued.current) return;
    refreshQueued.current = true;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshQueued.current = false;
      refreshTimer.current = null;
      void refresh();
    }, 800);
  }, [refresh]);

  useEffect(() => {
    if (!cwd) return;
    void refresh();
    const unsubscribe = pi.gitWatch(cwd, scheduleRefresh);
    return () => {
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [cwd, refresh, scheduleRefresh]);

  // Subscribe to operation state changes
  useEffect(() => {
    if (!cwd) return;
    const unsub = pi.onGitOperation?.((payload) => {
      if (payload.cwd !== cwd) return;
      setActiveOps((prev) => {
        const next = new Set(prev);
        if (payload.running) next.add(payload.kind);
        else next.delete(payload.kind);
        return next;
      });
      // When a write operation finishes, refresh
      if (!payload.running) {
        scheduleRefresh();
      }
    });
    return () => unsub?.();
  }, [cwd, scheduleRefresh]);

  // ── Write operations ──

  const handleStage = useCallback(async (path: string) => {
    const r = await pi.gitStage(cwd, [path]);
    if (!r.success) console.error('stage failed:', r.error);
    scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleStageAll = useCallback(async () => {
    const r = await pi.gitStage(cwd, undefined, true);
    if (!r.success) console.error('stage all failed:', r.error);
    scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleUnstage = useCallback(async (path: string) => {
    const r = await pi.gitUnstage(cwd, [path]);
    if (!r.success) console.error('unstage failed:', r.error);
    scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleRevert = useCallback(async (path: string) => {
    const r = await pi.gitRevert(cwd, [path]);
    if (!r.success) console.error('revert failed:', r.error);
    scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleClean = useCallback(async (path: string) => {
    if (!window.confirm(`Delete untracked file "${path}"? This cannot be undone.`)) return;
    const r = await pi.gitClean(cwd, [path]);
    if (!r.success) console.error('clean failed:', r.error);
    scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleCommit = useCallback(async (opts?: { all?: boolean; amend?: boolean; signOff?: boolean }) => {
    const msg = commitMsg.trim();
    if (!msg && !opts?.amend) { setCommitError('Commit message is empty'); return; }
    setCommitError(null);
    setCommitSuccess(false);
    setIsCommitting(true);
    try {
      const r = await pi.gitCommit(cwd, msg, { ...opts, allowEmptyMessage: true, allowEmpty: true });
      if (r.success) {
        setCommitMsg('');
        setCommitSuccess(true);
        setTimeout(() => setCommitSuccess(false), 2000);
      } else {
        setCommitError(r.error ?? 'Commit failed');
      }
    } catch (e: any) {
      setCommitError(e.message ?? 'Commit failed');
    } finally {
      setIsCommitting(false);
    }
  }, [cwd, commitMsg]);

  const handleCheckout = useCallback(async (ref: string) => {
    const r = await pi.gitCheckout(cwd, ref);
    if (!r.success) alert(r.error ?? 'Checkout failed');
    else scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  // ── Derived data ──

  const staged = resources.filter((r) => r.group === 'staged');
  const unstaged = resources.filter((r) => r.group === 'unstaged');
  const untracked = resources.filter((r) => r.group === 'untracked');

  const hasStaged = staged.length > 0;
  const hasChanges = unstaged.length > 0 || untracked.length > 0;
  const canCommit = (commitMsg.trim().length > 0 || hasStaged) && !isCommitting;

  // Branch picker
  const branchPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showBranchPicker) return;
    const handler = (e: MouseEvent) => {
      if (branchPickerRef.current && !branchPickerRef.current.contains(e.target as Node)) {
        setShowBranchPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBranchPicker]);

  const [newBranchName, setNewBranchName] = useState('');

  // Filter log by search query
  const filteredLog = searchQuery.trim()
    ? log.filter((e) =>
        e.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.author.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : log;

  // ── Render ──

  if (!status) {
    return <div className="git-empty">Loading...</div>;
  }
  if (!status.isGit) {
    return <div className="git-empty">Not a git repository: {cwd}</div>;
  }

  // ── Group helpers ──

  function renderGroup(title: string, key: string, items: GitResource[], opts: {
    showStage?: boolean; showUnstage?: boolean; showRevert?: boolean; showClean?: boolean;
    emptyText?: string;
  }) {
    const isExpanded = expanded[key] ?? true;
    const toggle = () => setExpanded((p) => ({ ...p, [key]: !p[key] }));
    const actionIcon = opts.showStage ? '+' : opts.showUnstage ? '−' : '';
    const actionTitle = opts.showStage ? 'Stage All' : opts.showUnstage ? 'Unstage All' : '';

    let onAction: (() => void) | undefined;
    if (opts.showStage && items.length > 0) onAction = () => {
      void pi.gitStage(cwd, items.map((i) => i.path));
      scheduleRefresh();
    };
    if (opts.showUnstage && items.length > 0) onAction = () => {
      void pi.gitUnstage(cwd, items.map((i) => i.path));
      scheduleRefresh();
    };

    return (
      <div className="git-group">
        <div className="git-group-title" onClick={toggle}>
          <span className="git-group-chevron">{isExpanded ? '▼' : '▶'}</span>
          <span className="git-group-label">{title}</span>
          <span className="git-group-count">{items.length}</span>
          {onAction && (
            <button className="git-group-action" onClick={(e) => { e.stopPropagation(); onAction!(); }} title={actionTitle}>
              {actionIcon}
            </button>
          )}
        </div>
        {isExpanded && (
          <div className="git-group-body">
            {items.length === 0 && <div className="git-group-empty">{opts.emptyText ?? 'No changes'}</div>}
            {items.map((r) => (
              <div className="git-resource-row" key={r.path + r.group}>
                <Badge badge={r.badge} group={r.group} />
                <span className="git-resource-path" title={r.path}>{r.path}</span>
                {r.renameTarget && <span className="git-rename-arrow">→ {r.renameTarget}</span>}
                <div className="git-resource-actions">
                  {opts.showStage && (
                    <button className="git-resource-btn" onClick={() => handleStage(r.path)} title="Stage">+</button>
                  )}
                  {opts.showUnstage && (
                    <button className="git-resource-btn" onClick={() => handleUnstage(r.path)} title="Unstage">−</button>
                  )}
                  {opts.showRevert && (
                    <button className="git-resource-btn git-resource-btn-danger" onClick={() => handleRevert(r.path)} title="Revert changes">↩</button>
                  )}
                  {opts.showClean && (
                    <button className="git-resource-btn git-resource-btn-danger" onClick={() => handleClean(r.path)} title="Delete file">✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="git-view">
      {/* Commit input box */}
      <div className="git-commit-box">
        <textarea
          className="git-commit-input"
          placeholder="Message (Ctrl+Enter to commit)"
          value={commitMsg}
          onChange={(e) => { setCommitMsg(e.target.value); setCommitError(null); }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              handleCommit({ all: !hasStaged });
            }
          }}
          rows={2}
        />
        {commitError && <div className="git-commit-error">{commitError}</div>}
        {commitSuccess && <div className="git-commit-success">✓ Committed</div>}
        <div className="git-commit-toolbar">
          <button
            className="git-commit-btn"
            disabled={!canCommit || activeOps.size > 0}
            onClick={() => handleCommit({ all: !hasStaged })}
            title={hasStaged ? 'Commit staged changes' : 'Stage all & commit'}
          >
            {isCommitting ? 'Committing...' : hasStaged ? 'Commit' : 'Commit (Stage All)'}
          </button>
          <div className="git-commit-options">
            <button
              className="git-commit-opt-btn"
              disabled={!canCommit || activeOps.size > 0}
              onClick={() => handleCommit({ all: !hasStaged, amend: true })}
              title="Amend last commit"
            >
              Amend
            </button>
            <button
              className="git-commit-opt-btn"
              disabled={!canCommit || activeOps.size > 0}
              onClick={() => handleCommit({ all: !hasStaged, signOff: true })}
              title="Commit with sign-off"
            >
              Sign-off
            </button>
          </div>
        </div>
      </div>

      {/* Branch + sync row */}
      <div className="git-branch-row">
        <span
          className="git-branch"
          title={status.branch ?? ''}
          style={{ cursor: 'pointer' }}
          onClick={() => setShowBranchPicker((v) => !v)}
          data-testid="git-branch-switch"
        >
          {activeOps.has('checkout') ? <Spinner /> : '🌿'} {status.branch ?? '(detached)'}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </span>
        )}
        <div className="git-sync-btns">
          <button className="git-sync-btn" onClick={() => { void pi.gitSync(cwd); scheduleRefresh(); }} title="Sync (fetch + push + pull)" disabled={activeOps.size > 0}>
            {activeOps.has('sync') ? <Spinner /> : '⟳'}
          </button>
          <button className="git-sync-btn" onClick={() => { void pi.gitPull(cwd); scheduleRefresh(); }} title="Pull" disabled={activeOps.size > 0}>
            {activeOps.has('pull') ? <Spinner /> : '↓'}
          </button>
          <button className="git-sync-btn" onClick={() => { void pi.gitPush(cwd); scheduleRefresh(); }} title="Push" disabled={activeOps.size > 0}>
            {activeOps.has('push') ? <Spinner /> : '↑'}
          </button>
          <button className="git-sync-btn" onClick={() => { void pi.gitFetch(cwd); scheduleRefresh(); }} title="Fetch" disabled={activeOps.size > 0}>
            {activeOps.has('fetch') ? <Spinner /> : '◎'}
          </button>
        </div>
      </div>

      {/* Branch picker popup */}
      {showBranchPicker && (
        <div className="git-branch-picker" ref={branchPickerRef}>
          <div className="git-branch-picker-create">
            <input
              placeholder="New branch name"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newBranchName.trim()) {
                  void pi.gitCreateBranch(cwd, newBranchName.trim()).then((r) => {
                    if (r?.success) void handleCheckout(newBranchName.trim());
                    else alert(r?.error ?? 'Create branch failed');
                    setNewBranchName('');
                    setShowBranchPicker(false);
                  });
                }
              }}
            />
            <button onClick={() => { void pi.gitCreateBranch(cwd, newBranchName.trim()).then((r) => { if (r?.success) void handleCheckout(newBranchName.trim()); else alert(r?.error ?? 'Create branch failed'); setNewBranchName(''); setShowBranchPicker(false); }); }}>+
            </button>
          </div>
          <div className="git-branch-picker-list">
            {branches.map((b) => (
              <div
                key={b.name}
                className={`git-branch-item${b.current ? ' git-branch-item-current' : ''}`}
                onClick={() => { void handleCheckout(b.name); setShowBranchPicker(false); }}
              >
                <span className="git-branch-item-name">{b.remote ? '☁' : '⎇'} {b.name}</span>
                {b.current && <span className="git-branch-item-current-mark">*</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resource groups */}
      <div className="git-resources">
        {renderGroup('Staged Changes', 'staged', staged, {
          showUnstage: true, showRevert: true, emptyText: 'No staged changes',
        })}
        {renderGroup('Changes', 'unstaged', unstaged, {
          showStage: true, showRevert: true, emptyText: 'No changes',
        })}
        {renderGroup('Untracked Changes', 'untracked', untracked, {
          showStage: true, showClean: true, emptyText: 'No untracked files',
        })}
      </div>

      {/* Commit history */}
      <div className="git-section-title">
        <span>Commit History</span>
        <input
          className="git-search-input"
          placeholder="Search commits…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="git-log">
        {filteredLog.length === 0 && <div className="git-empty">{searchQuery ? 'No matching commits' : 'No commits'}</div>}
        {filteredLog.map((e) => (
          <div
            key={e.hash}
            className="git-log-item"
            onClick={() => onOpenCommit(cwd, e.hash)}
            title={`${e.hash}\n${e.author} · ${e.date}\nClick to view changes`}
          >
            <span className="git-log-msg">{e.message}</span>
            <span className="git-log-meta">{e.author}</span>
          </div>
        ))}
      </div>
    </div>
  );
}