import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  gitStatus, gitLog, gitDiff, gitFileStatusMap, gitIgnoredPaths,
  gitStage, gitUnstage, gitCommit, gitRevert, gitClean,
  gitCurrentBranch, gitBranches, gitCreateBranch, gitCheckout, gitDeleteBranch, gitRenameBranch,
  gitRemotes, gitAddRemote, gitRemoveRemote,
  gitFetch, gitPull, gitPush, gitSync,
  gitLogAdvanced,
  gitIsClean,
} from '../gitBridge';

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function gitInit(cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['-C', cwd, 'init'], { encoding: 'utf-8' });
  execFileSync('git', ['-C', cwd, 'config', 'user.email', 'test@test.com'], { encoding: 'utf-8' });
  execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Test User'], { encoding: 'utf-8' });
}

function writeFile(cwd: string, rel: string, content: string): void {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

function readFile(cwd: string, rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), 'utf-8');
}

function fileExists(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

function gitAdd(cwd: string, ...paths: string[]): void {
  gitRaw(cwd, 'add', ...paths);
}

function gitCommitRaw(cwd: string, msg: string): void {
  gitRaw(cwd, 'commit', '-m', msg);
}

describe('gitBridge — stage / unstage', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'a.txt', 'hello');
    writeFile(dir, 'b.txt', 'world');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stages a single file', async () => {
    const r = await gitStage(dir, ['a.txt']);
    expect(r.success).toBe(true);
    const status = gitRaw(dir, 'status', '--porcelain');
    expect(status).toContain('A  a.txt'); // staged
    expect(status).toContain('?? b.txt'); // unstaged
  });

  it('stages all files', async () => {
    const r = await gitStage(dir, undefined, true);
    expect(r.success).toBe(true);
    const status = gitRaw(dir, 'status', '--porcelain');
    expect(status).toContain('A  a.txt');
    expect(status).toContain('A  b.txt');
  });

  it('unstages a file', async () => {
    gitAdd(dir, 'a.txt');
    const r = await gitUnstage(dir, ['a.txt']);
    expect(r.success).toBe(true);
    const status = gitRaw(dir, 'status', '--porcelain');
    expect(status).toContain('?? a.txt');
  });

  it('unstages all files', async () => {
    gitAdd(dir, 'a.txt', 'b.txt');
    const r = await gitUnstage(dir);
    expect(r.success).toBe(true);
    const status = gitRaw(dir, 'status', '--porcelain');
    expect(status).toMatch(/^\?\? a\.txt[\s\S]*\?\? b\.txt/m);
  });

  it('returns error for non-git directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
    try {
      const r = await gitStage(tmp, ['a.txt']);
      expect(r.success).toBe(false);
      expect(r.error).toContain('repository');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('gitBridge — commit', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'a.txt', 'hello');
    gitAdd(dir, 'a.txt');
    gitCommitRaw(dir, 'initial');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('commits staged changes', async () => {
    writeFile(dir, 'a.txt', 'modified');
    gitAdd(dir, 'a.txt');
    const r = await gitCommit(dir, 'second commit');
    expect(r.success).toBe(true);
    const log = gitRaw(dir, 'log', '--oneline');
    expect(log).toContain('second commit');
  });

  it('commits all changes (git commit -a)', async () => {
    writeFile(dir, 'a.txt', 'modified again');
    writeFile(dir, 'b.txt', 'new file');
    gitAdd(dir, 'b.txt');
    const r = await gitCommit(dir, 'commit all', { all: true });
    expect(r.success).toBe(true);
    const log = gitRaw(dir, 'log', '--oneline');
    expect(log).toContain('commit all');
  });

  it('rejects empty message', async () => {
    writeFile(dir, 'a.txt', 'data');
    gitAdd(dir, 'a.txt');
    const r = await gitCommit(dir, '');
    expect(r.success).toBe(false);
    expect(r.error).toContain('empty');
  });

  it('allows empty tree commit with allowEmpty flag', async () => {
    // allowEmpty means commit with no staged changes (empty tree), not empty message.
    // Must still provide a message.
    const r = await gitCommit(dir, 'empty tree commit', { allowEmpty: true });
    expect(r.success).toBe(true);
    const log = gitRaw(dir, 'log', '--oneline', '-1');
    expect(log).toContain('empty tree commit');
  });

  it('supports amend', async () => {
    writeFile(dir, 'a.txt', 'v2');
    gitAdd(dir, 'a.txt');
    await gitCommit(dir, 'amended message', { amend: false });
    // Now amend the last commit message
    writeFile(dir, 'a.txt', 'v3');
    gitAdd(dir, 'a.txt');
    const r = await gitCommit(dir, 'amended message v2', { amend: true });
    expect(r.success).toBe(true);
    const log = gitRaw(dir, 'log', '--oneline');
    // Should only have one commit (initial + this amended)
    expect(log).toContain('amended');
  });

  it('supports sign-off', async () => {
    writeFile(dir, 'a.txt', 'signed');
    gitAdd(dir, 'a.txt');
    const r = await gitCommit(dir, 'signed commit', { signOff: true });
    expect(r.success).toBe(true);
    const body = gitRaw(dir, 'log', '--format=%B', '-1');
    expect(body).toContain('Signed-off-by');
  });
});

describe('gitBridge — revert / clean', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'tracked.txt', 'original');
    gitAdd(dir, 'tracked.txt');
    gitCommitRaw(dir, 'initial');
    // modify tracked file
    writeFile(dir, 'tracked.txt', 'modified');
    // add untracked file
    writeFile(dir, 'untracked.txt', 'new');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reverts tracked file changes', async () => {
    const r = await gitRevert(dir, ['tracked.txt']);
    expect(r.success).toBe(true);
    expect(readFile(dir, 'tracked.txt')).toBe('original');
  });

  it('returns error for empty revert path list', async () => {
    const r = await gitRevert(dir, []);
    expect(r.success).toBe(false);
  });

  it('reverts a staged file in a repo with no commits (fallback to unstage)', async () => {
    // 无提交（无 HEAD）仓库：git checkout HEAD -- <path> 会报 invalid reference: HEAD
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-nocommit-'));
    try {
      gitInit(emptyDir);
      writeFile(emptyDir, 'new.txt', 'hello');
      gitAdd(emptyDir, 'new.txt');
      // 确认已暂存
      expect(gitRaw(emptyDir, 'status', '--porcelain')).toContain('A  new.txt');
      // revert 不应报错，应回退为取消暂存
      const r = await gitRevert(emptyDir, ['new.txt']);
      expect(r.success).toBe(true);
      // 文件回到未跟踪状态，工作区文件仍保留
      expect(gitRaw(emptyDir, 'status', '--porcelain')).toContain('?? new.txt');
      expect(fileExists(emptyDir, 'new.txt')).toBe(true);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('cleans untracked files', async () => {
    const r = await gitClean(dir, ['untracked.txt']);
    expect(r.success).toBe(true);
    expect(fileExists(dir, 'untracked.txt')).toBe(false);
  });

  it('cleans all untracked files', async () => {
    writeFile(dir, 'another.txt', 'also untracked');
    const r = await gitClean(dir, undefined, true);
    expect(r.success).toBe(true);
    expect(fileExists(dir, 'untracked.txt')).toBe(false);
    expect(fileExists(dir, 'another.txt')).toBe(false);
    // tracked file still exists
    expect(fileExists(dir, 'tracked.txt')).toBe(true);
  });
});

describe('gitBridge — branch operations', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'f.txt', 'content');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('gets current branch', async () => {
    const branch = await gitCurrentBranch(dir);
    expect(branch).toBe('master');
  });

  it('lists branches', async () => {
    const branches = await gitBranches(dir);
    expect(branches.length).toBeGreaterThanOrEqual(1);
    expect(branches.some((b) => b.current)).toBe(true);
    expect(branches.some((b) => b.name === 'master')).toBe(true);
  });

  it('creates a new branch', async () => {
    const r = await gitCreateBranch(dir, 'feature');
    expect(r.success).toBe(true);
    const branches = await gitBranches(dir);
    expect(branches.some((b) => b.name === 'feature')).toBe(true);
  });

  it('creates a branch from a specific ref', async () => {
    writeFile(dir, 'f.txt', 'v2');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'second');
    const hash = gitRaw(dir, 'rev-parse', 'HEAD~1');
    const r = await gitCreateBranch(dir, 'from-old', hash);
    expect(r.success).toBe(true);
  });

  it('switches to an existing branch', async () => {
    gitRaw(dir, 'branch', 'feature');
    const r = await gitCheckout(dir, 'feature');
    expect(r.success).toBe(true);
    const branch = await gitCurrentBranch(dir);
    expect(branch).toBe('feature');
  });

  it('deletes a merged branch', async () => {
    gitRaw(dir, 'branch', 'feature');
    const r = await gitDeleteBranch(dir, 'feature');
    expect(r.success).toBe(true);
    const branches = await gitBranches(dir);
    expect(branches.some((b) => b.name === 'feature')).toBe(false);
  });

  it('renames current branch', async () => {
    const r = await gitRenameBranch(dir, 'main');
    expect(r.success).toBe(true);
    const branch = await gitCurrentBranch(dir);
    expect(branch).toBe('main');
  });
});

describe('gitBridge — remote operations', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'f.txt', 'content');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists remotes (empty)', async () => {
    const remotes = await gitRemotes(dir);
    expect(remotes).toEqual([]);
  });

  it('adds a remote', async () => {
    const r = await gitAddRemote(dir, 'origin', 'https://example.com/repo.git');
    expect(r.success).toBe(true);
    const remotes = await gitRemotes(dir);
    expect(remotes.length).toBe(1);
    expect(remotes[0].name).toBe('origin');
  });

  it('removes a remote', async () => {
    gitRaw(dir, 'remote', 'add', 'origin', 'https://example.com/repo.git');
    const r = await gitRemoveRemote(dir, 'origin');
    expect(r.success).toBe(true);
    const remotes = await gitRemotes(dir);
    expect(remotes).toEqual([]);
  });

  it('remote operations on no remote (not crash)', async () => {
    // git fetch --all with no remotes may succeed (exit 0) on newer git
    // Just verify it doesn't throw
    const fetchR = await gitFetch(dir);
    expect(typeof fetchR.success).toBe('boolean');

    const pullR = await gitPull(dir);
    // No upstream configured — should fail
    expect(pullR.success).toBe(false);

    const pushR = await gitPush(dir);
    expect(pushR.success).toBe(false);
  });
});

describe('gitBridge — advanced log', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
    gitInit(dir);
    writeFile(dir, 'f.txt', 'v1');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial commit');
    writeFile(dir, 'f.txt', 'v2');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'second commit');
    writeFile(dir, 'g.txt', 'new');
    gitAdd(dir, 'g.txt');
    gitCommitRaw(dir, 'add g.txt');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns log entries', async () => {
    const log = await gitLogAdvanced(dir, { limit: 10 });
    expect(log.length).toBe(3);
    expect(log[0].message).toBe('add g.txt');
    expect(log[2].message).toBe('initial commit');
  });

  it('supports pagination (skip)', async () => {
    const log = await gitLogAdvanced(dir, { limit: 1, skip: 1 });
    expect(log.length).toBe(1);
    expect(log[0].message).toBe('second commit');
  });

  it('supports grep search', async () => {
    const log = await gitLogAdvanced(dir, { query: 'second' });
    expect(log.length).toBe(1);
    expect(log[0].message).toContain('second');
  });

  it('supports author search', async () => {
    const log = await gitLogAdvanced(dir, { author: 'Test' });
    expect(log.length).toBe(3);
  });
});

describe('gitBridge — helper functions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbridge-'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('gitIsClean returns true for clean repo', async () => {
    gitInit(dir);
    writeFile(dir, 'f.txt', 'content');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial');
    expect(await gitIsClean(dir)).toBe(true);
  });

  it('gitIsClean returns false for dirty tracked file', async () => {
    gitInit(dir);
    writeFile(dir, 'f.txt', 'content');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial');
    writeFile(dir, 'f.txt', 'modified');
    expect(await gitIsClean(dir)).toBe(false);
  });

  it('gitStatus returns isGit:false for non-repo', async () => {
    const s = await gitStatus(dir);
    expect(s.isGit).toBe(false);
  });

  it('gitStatus returns branch info for repo', async () => {
    gitInit(dir);
    writeFile(dir, 'f.txt', 'content');
    gitAdd(dir, 'f.txt');
    gitCommitRaw(dir, 'initial');
    const s = await gitStatus(dir);
    expect(s.isGit).toBe(true);
    expect(s.branch).toBeTruthy();
  });
});