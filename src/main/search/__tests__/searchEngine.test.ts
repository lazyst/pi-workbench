// searchEngine 集成测试：用真实 ripgrep + 临时目录，端到端验证匹配/选项/取消。
// vitest 默认 node 环境（setup.ts 已 guard DOM polyfill，node 下安全）。

import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSearch, type RunSearchArgs, type SearchCallbacks, type SearchFileResult, type SearchSummary } from '../searchEngine';

interface CollectResult {
  files: SearchFileResult[];
  summary: SearchSummary | null;
  error: string | null;
}

/** 跑一次搜索并收集全部结果。onDone 或 onError 任一到达即结束（resolve 幂等）。 */
function collect(args: RunSearchArgs): { result: Promise<CollectResult>; cancel: () => void } {
  const files: SearchFileResult[] = [];
  let summary: SearchSummary | null = null;
  let error: string | null = null;
  let resolved = false;
  let resolveFn!: (r: CollectResult) => void;
  const result = new Promise<CollectResult>((resolve) => { resolveFn = resolve; });
  const finish = () => {
    if (resolved) return;
    resolved = true;
    resolveFn({ files: [...files], summary, error });
  };
  const { cancel } = runSearch(args, {
    onFileResult: (f) => files.push(f),
    onProgress: () => {},
    onDone: (s) => { if (s) summary = s; finish(); },
    onError: (m) => { error = m; finish(); },
  });
  return { result, cancel };
}

async function mkTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'search-test-'));
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, ...rel.split('/'));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
}

// Windows 上 rg 退出后目录句柄可能短暂未释放（EBUSY），重试几次。
async function rmDir(dir: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    try { await fsp.rm(dir, { recursive: true, force: true }); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM') {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      throw e;
    }
  }
}

describe('searchEngine (ripgrep)', () => {
  it('基本匹配：返回文件/行号/选区列（1-based）', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'a.ts', 'const x = 1;\nconst searchRun = 2;\n');
      const { result } = collect({
        root: dir,
        query: 'searchRun',
        options: { isRegex: false, matchCase: true, wholeWord: false },
      });
      const { files, error, summary } = await result;
      expect(error).toBeNull();
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('a.ts');
      expect(files[0].matches).toHaveLength(1);
      const m = files[0].matches[0];
      expect(m.line).toBe(2);
      expect(m.lineText).toBe('const searchRun = 2;');
      const sub = m.submatches[0];
      expect(sub.text).toBe('searchRun');
      // "const " = 6 字符 → searchRun 起始 1-based 列 7，结束 16
      expect(sub.startCol).toBe(7);
      expect(sub.endCol).toBe(16);
      expect(summary).not.toBeNull();
      expect(summary!.matches).toBe(1);
    } finally {
      await rmDir(dir);
    }
  });

  it('大小写：matchCase=false 跨大小写匹配；true 则不匹配', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'b.ts', 'Hello World\nhello world\n');
      const insensitive = await collect({
        root: dir,
        query: 'HELLO',
        options: { isRegex: false, matchCase: false, wholeWord: false },
      }).result;
      expect(insensitive.files[0].matches).toHaveLength(2);

      const sensitive = await collect({
        root: dir,
        query: 'Hello',
        options: { isRegex: false, matchCase: true, wholeWord: false },
      }).result;
      expect(sensitive.files[0].matches).toHaveLength(1);
      expect(sensitive.files[0].matches[0].line).toBe(1);
    } finally {
      await rmDir(dir);
    }
  });

  it('全字匹配：wholeWord=true 仅匹配独立词', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'c.ts', 'const foo = 1;\nconst foobar = 2;\nfoo;\n');
      const { result } = collect({
        root: dir,
        query: 'foo',
        options: { isRegex: false, matchCase: true, wholeWord: true },
      });
      const { files } = await result;
      const lines = files[0]?.matches.map((m) => m.line) ?? [];
      // "foo" 独立出现在第 1 行（const foo）和第 3 行（foo;），foobar 不算
      expect(lines).toEqual([1, 3]);
    } finally {
      await rmDir(dir);
    }
  });

  it('正则：isRegex=true 按 pattern 匹配', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'd.ts', 'a1b\na2b\naXb\n');
      const { result } = collect({
        root: dir,
        query: 'a\\d+b',
        options: { isRegex: true, matchCase: true, wholeWord: false },
      });
      const { files } = await result;
      expect(files[0].matches).toHaveLength(2);
    } finally {
      await rmDir(dir);
    }
  });

  it('glob：include 只搜指定后缀；exclude 跳过指定', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'keep.ts', 'target;\n');
      await writeFile(dir, 'skip.js', 'target;\n');
      await writeFile(dir, 'ignore.txt', 'target;\n');
      const inc = await collect({
        root: dir,
        query: 'target',
        options: { isRegex: false, matchCase: true, wholeWord: false, include: '*.ts' },
      }).result;
      expect(inc.files.map((f) => f.path)).toEqual(['keep.ts']);

      const exc = await collect({
        root: dir,
        query: 'target',
        options: { isRegex: false, matchCase: true, wholeWord: false, exclude: '*.js, *.txt' },
      }).result;
      const paths = exc.files.map((f) => f.path).sort();
      expect(paths).toEqual(['keep.ts']);
    } finally {
      await rmDir(dir);
    }
  });

  it('空 query：不启动 rg，直接 onDone 无结果', async () => {
    const dir = await mkTmpDir();
    try {
      const { result } = collect({
        root: dir,
        query: '   ',
        options: { isRegex: false, matchCase: true, wholeWord: false },
      });
      const { files, error } = await result;
      expect(files).toHaveLength(0);
      expect(error).toBeNull();
    } finally {
      await rmDir(dir);
    }
  });

  it('取消：立即 cancel 后正常结束（无未捕获错误）', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'e.ts', 'x'.repeat(100) + '\n' + 'y'.repeat(100) + '\n');
      const { result, cancel } = collect({
        root: dir,
        query: 'x',
        options: { isRegex: false, matchCase: true, wholeWord: false },
      });
      cancel();
      const res = await result;
      // 取消后应正常结束，无 error
      expect(res.error).toBeNull();
    } finally {
      await rmDir(dir);
    }
  });

  it('非法正则：报 error 而非崩溃', async () => {
    const dir = await mkTmpDir();
    try {
      await writeFile(dir, 'f.ts', 'hello\n');
      const { result } = collect({
        root: dir,
        query: '(unclosed',
        options: { isRegex: true, matchCase: true, wholeWord: false },
      });
      const { error } = await result;
      expect(error).not.toBeNull();
    } finally {
      await rmDir(dir);
    }
  });
});
