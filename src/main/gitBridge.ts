import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);

// ============================================================================
// Git bridge — read + write operations
//
// Thin wrapper around `git -C <cwd>` for the desktop app's Git viewer.
// All commands pin LC_ALL=C so error-text / porcelain parsing is locale-stable.
// Non-git directories degrade gracefully (never throw) — callers get
// `{ isGit: false }` and render a "not a git repository" notice.
// ============================================================================

const GIT_TIMEOUT = 15_000;
const PATH_TRAVERSAL_RE = /(?:^|[\/\\])\.\.(?:[\/\\]|$)/;

/**
 * 解码 Git 的 C 风格引用路径（如 `"\346\265\213\350\257\225\346\226\207\344\273\266.txt"`）。
 * 若未用引号包裹则原样返回（兼容 `-c core.quotepath=false` 的原始 UTF-8 输出）。
 * 用于 porcelain / name-status 输出中可能出现的转义路径，防止把带引号的字符串误当文件名。
 */
function decodeGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '\\' && /^[0-7]/.test(inner[i + 1] ?? '')) {
      let val = 0;
      let j = 0;
      while (j < 3 && /^[0-7]/.test(inner[i + 1 + j] ?? '')) {
        val = val * 8 + Number(inner[i + 1 + j]);
        j++;
      }
      bytes.push(val);
      i += 1 + j;
    } else if (c === '\\') {
      const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "'": 39, '\\': 92 };
      const next = inner[i + 1];
      bytes.push(map[next] ?? c.charCodeAt(0));
      i += 2;
    } else {
      if (c.charCodeAt(0) < 0x80) {
        bytes.push(c.charCodeAt(0));
      } else {
        for (const b of new TextEncoder().encode(c)) {
          bytes.push(b);
        }
      }
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Common error-text cleaner: strip ANSI escapes, trim, fallback. */
function cleanGitError(err: any): string {
  const raw = err.stderr?.toString()?.trim() || err.message || 'Unknown git error';
  return raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
}

/** Validate that all paths are within the repo root (no path traversal). */
function validatePaths(cwd: string, paths: string[]): string | undefined {
  for (const p of paths) {
    if (p.includes('..') || PATH_TRAVERSAL_RE.test(p) || p.startsWith('/')) {
      return `Invalid path: ${p}`;
    }
    const resolved = path.resolve(cwd, p);
    if (!resolved.startsWith(path.resolve(cwd) + path.sep) && resolved !== path.resolve(cwd)) {
      return `Path outside repository: ${p}`;
    }
  }
  return undefined;
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}

/**
 * Run a git command that may fail. Returns `{ success, error }`.
 * Used for write operations.
 */
async function gitTry(cwd: string, args: string[], timeout = GIT_TIMEOUT): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: cleanGitError(err) };
  }
}

/**
 * 快速检查 cwd 是否在 git 仓库内。
 * 使用 `git rev-parse --git-dir`（极轻量，不扫描工作树），
 * 非 git 目录或超时（3s）时静默返回 false。
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--git-dir'], 3_000);
    return true;
  } catch {
    return false;
  }
}

export interface GitStatus {
  isGit: boolean;
  branch: string | null;
  /** Total added lines across working tree (unstaged + staged). */
  additions: number;
  /** Total deleted lines across working tree (unstaged + staged). */
  deletions: number;
  ahead: number;
  behind: number;
  porcelain: string;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Status for a working tree. Returns `{ isGit: false }` for non-repos.
 * `porcelain` is the raw `git status --porcelain=v1` output (used to render the
 * working-tree / staged diffs in the UI).
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  // 先用快速检测判断是否为 git 仓库，避免在非 git 目录下执行完整的
  // git status（可能卡住或等待超时），导致用户看到无限加载中。
  if (!(await isGitRepo(cwd))) {
    return { isGit: false, branch: null, additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '' };
  }
  try {
    // 使用 --untracked-files=all 列出未跟踪目录内的每个文件，使目录在 Git 面板中可展开。
    const porcelain = await git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b', '--untracked-files=all']);
    const lines = porcelain.split('\n');
    const branchLine = lines[0] ?? '';
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    // ## branch...origin/branch [ahead 1, behind 2]
    const m = branchLine.match(/^##\s+(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
    if (m) {
      const ref = m[1];
      branch = ref === 'HEAD (no branch)' ? '(detached)' : ref;
      const meta = m[3] ?? '';
      const a = meta.match(/ahead (\d+)/);
      const b = meta.match(/behind (\d+)/);
      ahead = a ? Number(a[1]) : 0;
      behind = b ? Number(b[1]) : 0;
    }
    // Skip the first line (the `## branch` header); only real file-change
    // lines (tracked modifications, untracked files, etc.) indicate dirtiness.
    const dirty = lines.slice(1).some((l) => l.trim().length > 0);
    // Count added / deleted lines via `git diff --numstat` (unstaged + staged).
    // numstat prints `<additions>\t<deletions>\t<path>` per file; binary or
    // renamed files may show `-` for a count, which we treat as 0.
    const unstagedStat = await git(cwd, ['diff', '--numstat']);
    const stagedStat = await git(cwd, ['diff', '--cached', '--numstat']);
    const sumStat = (out: string): { additions: number; deletions: number } => {
      let additions = 0;
      let deletions = 0;
      for (const line of out.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 2) continue;
        const a = Number(cols[0]);
        const d = Number(cols[1]);
        additions += Number.isFinite(a) ? a : 0;
        deletions += Number.isFinite(d) ? d : 0;
      }
      return { additions, deletions };
    };
    const u = sumStat(unstagedStat);
    const s = sumStat(stagedStat);
    const additions = u.additions + s.additions;
    const deletions = u.deletions + s.deletions;
    return { isGit: true, branch, additions, deletions, ahead, behind, porcelain };
  } catch {
    return { isGit: false, branch: null, additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '' };
  }
}

/** Recent commit log (default 100 entries). */
export async function gitLog(cwd: string, limit = 100): Promise<GitLogEntry[]> {
  try {
    const out = await git(cwd, [
      'log',
      `-n${limit}`,
      '--pretty=format:%H%x1f%an%x1f%ad%x1f%s',
      '--date=iso',
    ]);
    return out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => {
        const [hash, author, date, ...rest] = l.split('\x1f');
        return { hash, author, date, message: rest.join('\x1f') };
      });
  } catch {
    return [];
  }
}

/**
 * 文件树用 git 状态条目：每个文件/目录的详细 git 状态。
 */
export interface GitFileStatusEntry {
  /** 简化类别，用于 CSS 颜色 */
  category: 'modified' | 'added' | 'deleted' | 'ignored' | 'conflict' | 'submodule';
  /** 是否已暂存（staged） */
  staged: boolean;
  /** 是否工作区有未暂存改动 */
  unstaged: boolean;
  /** 短徽章字母：M/A/D/?/U/R/C/! */
  badge: string;
  /** 是否为符号链接 */
  isSymlink: boolean;
  /** 是否为子模块 */
  isSubmodule: boolean;
  /** 子模块是否有未提交的改动（仅 isSubmodule=true 时有效） */
  submoduleDirty?: boolean;
}

/**
 * 获取被 .gitignore 忽略的顶层路径集合（目录和文件）。
 * 使用 `git status --ignored --short`，输出格式为 `!! <path>`，
 * 目录只列出自身（不含内部文件），输出极简。
 *
 * 在文件树中使用：父目录被忽略则子项全部继承，无需逐文件检查。
 */
export async function gitIgnoredPaths(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['-c', 'core.quotepath=false', 'status', '--ignored', '--short', '--untracked-files=normal']);
    const paths: string[] = [];
    for (const line of out.split('\n')) {
      if (line.startsWith('!! ')) {
        const p = line.slice(3).trim();
        if (p) paths.push(p.endsWith('/') ? p.slice(0, -1) : p);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * 文件树用 git 状态映射：返回 { relPath → GitFileStatusEntry }。
 *
 * 包含：
 *   - 工作区状态（modified/added/deleted/conflict）
 *   - staged/unstaged 区分
 *   - 短徽章字母
 *
 * 非 git 目录优雅降级返回空对象。
 */
export async function gitFileStatusMap(cwd: string): Promise<Record<string, GitFileStatusEntry>> {
  try {
    // 只运行 git status（不运行 git ls-files --stage 等额外命令，
    // 避免大仓库中列出所有文件造成 CPU 和内存压力）
    // 使用 --untracked-files=all 列出未跟踪目录内的每个文件，使文件树状态映射完整。
    const porcelain = await git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all']);

    const map: Record<string, GitFileStatusEntry> = {};
    for (const line of porcelain.split('\n')) {
      if (!line.trim()) continue;
      const xy = line.substring(0, 2);
      const pathPart = line.substring(3).trim();
      const actualPath = decodeGitPath(pathPart.includes(' -> ') ? pathPart.split(' -> ')[1].trim() : pathPart);

      const x = xy[0];
      const y = xy[1];
      const staged = x !== ' ' && x !== '?';
      const unstaged = y !== ' ' && y !== '?';

      let category: GitFileStatusEntry['category'];
      let badge: string;

      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        category = 'conflict';
        badge = 'U';
      } else if (xy === '??') {
        category = 'added';
        badge = '?';
      } else if (x === 'R' || x === 'C') {
        category = 'modified';
        badge = x;
      } else if (x === 'M' || y === 'M') {
        category = 'modified';
        badge = 'M';
      } else if (x === 'A' || y === 'A') {
        category = 'added';
        badge = 'A';
      } else if (x === 'D' || y === 'D') {
        category = 'deleted';
        badge = 'D';
      } else {
        category = 'modified';
        badge = 'M';
      }

      map[actualPath] = {
        category,
        staged,
        unstaged,
        badge,
        isSymlink: false,
        isSubmodule: false,
      };
    }

    return map;
  } catch {
    return {};
  }
}

/**
 * Unified diff text. No `ref` → working tree diff (`git diff` + `--cached`).
 * With `ref` → that commit's diff (`git show <ref>`).
 */
export async function gitDiff(cwd: string, ref?: string): Promise<string> {
  try {
    if (ref) {
      return await git(cwd, ['-c', 'core.quotepath=false', 'show', '--no-color', ref]);
    }
    const unstaged = await git(cwd, ['-c', 'core.quotepath=false', 'diff', '--no-color']);
    const staged = await git(cwd, ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-color']);
    return (unstaged + '\n' + staged).trim() + '\n';
  } catch {
    return '';
  }
}

/**
 * 获取单个文件的 diff（unified 格式），用于编辑器行号标记。
 * 合并 staged + unstaged 变更。
 */
export async function gitFileDiff(cwd: string, path: string): Promise<string> {
  try {
    const unstaged = await git(cwd, ['diff', '--no-color', '--', path]);
    const staged = await git(cwd, ['diff', '--cached', '--no-color', '--', path]);
    return (unstaged + '\n' + staged).trim() + '\n';
  } catch {
    return '';
  }
}

export interface GitCommitFile {
  status: string;
  path: string;
  oldPath?: string;
}

export async function gitCommitFiles(cwd: string, hash: string): Promise<GitCommitFile[]> {
  try {
    const output = await git(cwd, ['-c', 'core.quotepath=false', 'show', '--name-status', '--no-color', '--format=', hash]);
    const files: GitCommitFile[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      const status = parts[0];
      if (!status || status.startsWith('diff') || status.startsWith('---') || status.startsWith('+++') || status.startsWith('index')) continue;
      if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
        files.push({ status: status[0], path: decodeGitPath(parts[2]), oldPath: decodeGitPath(parts[1]) });
      } else if (parts.length >= 2) {
        files.push({ status, path: decodeGitPath(parts[1]) });
      }
    }
    return files;
  } catch {
    return [];
  }
}

export interface GitFileContent {
  original: string;
  modified: string;
}

export async function gitShowFile(cwd: string, path: string, ref: string): Promise<string> {
  try {
    return await git(cwd, ['show', ref + ':' + path]);
  } catch {
    return '';
  }
}

export async function gitCommitFileDiff(cwd: string, hash: string, path: string): Promise<GitFileContent> {
  try {
    let original = '';
    try {
      original = await git(cwd, ['show', hash + '^:' + path]);
    } catch {
      original = '';
    }
    const modified = await gitShowFile(cwd, path, hash);
    return { original, modified };
  } catch {
    return { original: '', modified: '' };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Write operations
// ════════════════════════════════════════════════════════════════════════════

export interface GitWriteResult {
  success: boolean;
  /** Cleaned error message (ANSI escapes stripped) on failure. */
  error?: string;
}

/** Stage files. With no paths, stages all (tracked + untracked). */
export async function gitStage(cwd: string, paths?: string[], all = false): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (all) {
    return gitTry(cwd, ['add', '-A']);
  }
  if (!paths || paths.length === 0) return { success: false, error: 'No files to stage' };
  const err = validatePaths(cwd, paths); if (err) return { success: false, error: err };
  return gitTry(cwd, ['add', '--', ...paths]);
}

/** Unstage files. With no paths, unstages everything. */
export async function gitUnstage(cwd: string, paths?: string[]): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!paths || paths.length === 0) {
    return gitTry(cwd, ['reset', 'HEAD', '--']);
  }
  const err = validatePaths(cwd, paths); if (err) return { success: false, error: err };
  return gitTry(cwd, ['reset', 'HEAD', '--', ...paths]);
}

export interface GitCommitOptions {
  /** Stage all changes before committing. */
  all?: boolean;
  /** Amend the last commit. */
  amend?: boolean;
  /** Append a Signed-off-by trailer. */
  signOff?: boolean;
  /** Skip pre-commit / commit-msg hooks. */
  noVerify?: boolean;
  /** Allow committing with no staged changes (empty tree). */
  allowEmpty?: boolean;
  /** Suppress the empty-message guard (for programmatic callers). */
  allowEmptyMessage?: boolean;
}

/**
 * Commit with a message read from stdin (safe for multi-line messages).
 * Returns `{ success, error }`.
 */
function gitCommitViaStdin(cwd: string, args: string[], message: string): Promise<GitWriteResult> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ success: true });
        return;
      }
      resolve({ success: false, error: cleanGitError({ stderr, message: err.message }) });
    });
    child.stdin?.end(message);
  });
}

export async function gitCommit(cwd: string, message: string, opts: GitCommitOptions = {}): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  const trimmed = message.trim();
  if (!trimmed && !opts.allowEmptyMessage) return { success: false, error: 'Commit message is empty' };
  const args: string[] = ['commit'];
  if (opts.all) args.push('-a');
  if (opts.amend) args.push('--amend');
  if (opts.signOff) args.push('--signoff');
  if (opts.noVerify) args.push('--no-verify');
  if (opts.allowEmpty) args.push('--allow-empty');
  return gitCommitViaStdin(cwd, [...args, '-F', '-'], message);
}

/**
 * Revert working-tree changes for tracked files back to HEAD.
 * Untracked files cannot be reverted this way — use gitClean instead.
 */
export async function gitRevert(cwd: string, paths: string[]): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!paths || paths.length === 0) return { success: false, error: 'No files to revert' };
  const err = validatePaths(cwd, paths); if (err) return { success: false, error: err };
  // 无提交（无 HEAD 引用）时，git checkout HEAD -- <path> 会报
  // "fatal: invalid reference: HEAD"。此时回退为 git reset（取消暂存），
  // 使已暂存的新文件（A 状态）回到未跟踪状态。
  let hasHead = true;
  try {
    await git(cwd, ['rev-parse', '--verify', 'HEAD'], 3_000);
  } catch {
    hasHead = false;
  }
  if (hasHead) {
    // 有 HEAD：同时回退暂存区和工作区到 HEAD。
    // 已暂存的新文件（A）会被删除（HEAD 中不存在）；未暂存文件效果同
    // git checkout -- <path>（index == HEAD）。
    return gitTry(cwd, ['checkout', 'HEAD', '--', ...paths]);
  }
  // 无 HEAD：仅取消暂存（文件回到未跟踪状态）。
  return gitTry(cwd, ['reset', 'HEAD', '--', ...paths]);
}

/** Delete untracked files. Confirmation required by caller (irreversible). */
export async function gitClean(cwd: string, paths?: string[], all = false): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (all) return gitTry(cwd, ['clean', '-fd']);
  if (!paths || paths.length === 0) return { success: false, error: 'No files to clean' };
  const err = validatePaths(cwd, paths); if (err) return { success: false, error: err };
  const args: string[] = ['clean', '-fd', '--'];
  for (const p of paths) args.push(p);
  return gitTry(cwd, args);
}

// ════════════════════════════════════════════════════════════════════════════
// Branch operations
// ════════════════════════════════════════════════════════════════════════════

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
}

export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = out.trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** List local and remote branches. */
export async function gitBranches(cwd: string): Promise<GitBranch[]> {
  try {
    const current = await gitCurrentBranch(cwd);
    const out = await git(cwd, ['branch', '-a', '--no-color', '--format=%(refname:short)|%(HEAD)|%(upstream:short)']);
    return out.split('\n').filter((l) => l.trim()).map((line) => {
      const [name, head, upstream] = line.split('|');
      const isCurrent = head === '*' || name === current;
      const remote = name.startsWith('remotes/');
      return {
        name: remote ? name.replace(/^remotes\//, '') : name,
        current: isCurrent,
        remote,
        tracking: upstream || undefined,
      };
    });
  } catch {
    return [];
  }
}

/** Create a new branch. If from is given, branch off that ref. Does not switch. */
export async function gitCreateBranch(cwd: string, name: string, from?: string): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!name.trim()) return { success: false, error: 'Branch name is empty' };
  const args: string[] = ['branch', name.trim()]; if (from) args.push(from); return gitTry(cwd, args);
}

/** Checkout a branch or ref (optionally creating with -b). */
export async function gitCheckout(cwd: string, ref: string, create = false): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!ref) return { success: false, error: 'No branch to checkout' };
  const args: string[] = ['checkout']; if (create) args.push('-b'); args.push(ref); return gitTry(cwd, args);
}

/** Delete a branch. force=true uses -D (delete unmerged). */
export async function gitDeleteBranch(cwd: string, name: string, force = false): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!name.trim()) return { success: false, error: 'Branch name is empty' };
  return gitTry(cwd, ['branch', force ? '-D' : '-d', name.trim()]);
}

/** Rename the current branch. */
export async function gitRenameBranch(cwd: string, newName: string): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!newName.trim()) return { success: false, error: 'Branch name is empty' };
  return gitTry(cwd, ['branch', '-m', newName.trim()]);
}

/** 获取 git user.name（用于提交对话框的 Author 字段）。失败返回 null。 */
export async function gitConfigUser(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['config', 'user.name']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** 把路径添加到 .gitignore 中，如果已存在则不重复添加。 */
export async function gitAddToGitignore(cwd: string, relPath: string, isDir = false): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  const pattern = isDir && !relPath.endsWith('/') ? relPath + '/' : relPath;
  const gitignorePath = path.join(cwd, '.gitignore');
  try {
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const lines = content.split(/\r?\n/);
    if (lines.some((l) => l.trim() === pattern.trim())) {
      return { success: true, error: 'Already in .gitignore' };
    }
    const addLine = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + pattern + '\n';
    fs.writeFileSync(gitignorePath, content + addLine, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: cleanGitError(err) };
  }
}

/** Confirm worktree is clean (no changes that would block a merge/checkout). */
export async function gitIsClean(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Remote sync operations
// ════════════════════════════════════════════════════════════════════════════

export interface GitRemote {
  name: string;
  url?: string;
}

export async function gitRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const out = await git(cwd, ['remote', '-v']);
    const seen = new Set<string>();
    const remotes: GitRemote[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (m) {
        const [, name, url] = m;
        const key = `${name}\u0000${url}`;
        if (!seen.has(key)) { seen.add(key); remotes.push({ name, url }); }
      }
    }
    return remotes;
  } catch {
    return [];
  }
}

export async function gitAddRemote(cwd: string, name: string, url: string): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  if (!name.trim() || !url.trim()) return { success: false, error: 'Remote name/url required' };
  return gitTry(cwd, ['remote', 'add', name.trim(), url.trim()]);
}

export async function gitRemoveRemote(cwd: string, name: string): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  return gitTry(cwd, ['remote', 'remove', name]);
}

export interface GitSyncOptions {
  /** Pull with rebase instead of merge. */
  rebase?: boolean;
  /** Force push. */
  force?: boolean;
}

export async function gitFetch(cwd: string): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  return gitTry(cwd, ['fetch', '--all'], GIT_TIMEOUT * 2);
}

export async function gitPull(cwd: string, opts: GitSyncOptions = {}): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  const args: string[] = ['pull']; if (opts.rebase) args.push('--rebase'); return gitTry(cwd, args, GIT_TIMEOUT * 2);
}

export async function gitPush(cwd: string, opts: GitSyncOptions = {}): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  const args: string[] = ['push']; if (opts.force) args.push('--force-with-lease'); return gitTry(cwd, args, GIT_TIMEOUT * 2);
}

/** Fetch then push then pull — keep in sync with the remote. */
export async function gitSync(cwd: string, opts: GitSyncOptions = {}): Promise<GitWriteResult> {
  if (!(await isGitRepo(cwd))) return { success: false, error: 'Not a git repository' };
  const fetch = await gitFetch(cwd);
  if (!fetch.success && fetch.error) return fetch;
  const push = await gitPush(cwd, opts);
  if (!push.success && push.error) return push;
  return gitPull(cwd, opts);
}

// ════════════════════════════════════════════════════════════════════════════
// Advanced log: search + pagination
// ════════════════════════════════════════════════════════════════════════════

export interface GitLogQuery {
  limit?: number;
  skip?: number;
  query?: string;        // search message (fuzzy) — matched against subject/body
  author?: string;       // search author
  ref?: string;          // start ref for the log query
  allBranches?: boolean; // add --all to include all branches
}

/** Advanced log with optional search and pagination. */
export async function gitLogAdvanced(cwd: string, q: GitLogQuery = {}): Promise<GitLogEntry[]> {
  try {
    const args: string[] = ['log'];
    args.push(`-n${q.limit ?? 100}`);
    if (q.skip && q.skip > 0) args.push(`--skip=${q.skip}`);
    if (q.author) { args.push(`--author=${q.author}`); }
    if (q.query) { args.push(`--grep=${q.query}`); args.push('-i'); args.push('--regexp-ignore-case'); }
    if (q.ref) args.push(q.ref.toString());
    if (q.allBranches) args.push('--all');
    args.push('--pretty=format:%H%x1f%an%x1f%ad%x1f%s', '--date=iso');
    const out = await git(cwd, args);
    return out.split('\n').filter((l) => l).map((l) => {
      const [hash, author, date, ...rest] = l.split('\x1f');
      return { hash, author, date, message: rest.join('\x1f') };
    });
  } catch {
    return [];
  }
}
