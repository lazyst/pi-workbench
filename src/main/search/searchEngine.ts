// ─────────────────────────────────────────────────────────────────────────────
// 全局搜索引擎：基于 ripgrep（@vscode/ripgrep，VS Code 同款）。
//
// 设计要点：
// • rg --json 流式输出（每行一个 JSON：begin / match / end / summary）。
// • rg 默认尊重 .gitignore、跳过 .git 与隐藏文件、自动跳过二进制——天然满足需求。
// • submatches 的 start/end 是 **字节偏移**（UTF-8），需转字符列才能给 Monaco 用。
// • 按文件聚合推送（rg 同一文件的 match 连续输出）：begin 建缓冲，end 时一次性推
//   onFileResult(path, matches[])，减少 IPC 次数。
// • cancel = child.kill()；rg 收 SIGTERM 即退出。
// • 退出码：0=有匹配，1=无匹配（正常），2=错误（正则非法等，读 stderr）。
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rgPath } from '@vscode/ripgrep';

/** 每文件匹配上限（防单文件海量匹配刷屏）。对齐 VS Code search.maxResults 的单文件语义。 */
const PER_FILE_LIMIT = 1000;
/** 跳过大于此大小的文件（与 readFile MAX_TEXT_BYTES 一致量级）。 */
const MAX_FILESIZE = '2M';
/** 全局结果上限：达到后主动 cancel，避免超大仓库无限跑。 */
const GLOBAL_RESULT_LIMIT = 20000;

export interface SearchOptions {
  /** true=正则；false=固定字符串（-F）。 */
  isRegex: boolean;
  /** true=区分大小写；false=-i。 */
  matchCase: boolean;
  /** true=全字匹配（-w）。 */
  wholeWord: boolean;
  /** 包含 glob，逗号/换行分隔多个（如 *.ts, *.tsx）。空=不限。 */
  include?: string;
  /** 排除 glob，逗号/换行分隔。 */
  exclude?: string;
}

export interface SearchSubmatch {
  /** 1-based 起始列（UTF-16 code unit，供 Monaco selection column）。 */
  startCol: number;
  /** 1-based 结束列（exclusive）。 */
  endCol: number;
  /** 匹配文本。 */
  text: string;
}

export interface SearchMatch {
  /** 相对 root 的 posix 路径（已规范为正斜杠）。 */
  path: string;
  /** 1-based 行号。 */
  line: number;
  /** 整行内容（去末尾换行）。 */
  lineText: string;
  submatches: SearchSubmatch[];
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchSummary {
  matchedLines: number;
  matches: number;
  filesWithMatch: number;
  bytesSearched: number;
}

export interface SearchCallbacks {
  onFileResult: (file: SearchFileResult) => void;
  onProgress: (stats: { matches: number; files: number }) => void;
  onDone: (summary?: SearchSummary) => void;
  onError: (message: string) => void;
}

export interface RunSearchArgs {
  root: string;
  query: string;
  options: SearchOptions;
}

/**
 * 把 rg 给的字节偏移转为 1-based 字符列（UTF-16 code unit，Monaco 友好）。
 * rg --json 的 submatches.start/end 是 lines.text 内的 UTF-8 字节偏移。
 */
function byteOffsetToCol(text: string, byteOffset: number): number {
  // 取前 byteOffset 字节的合法 UTF-8 子串，其 UTF-16 长度 +1 即列号。
  const sub = Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8');
  return sub.length + 1;
}

/** 拆分用户输入的 glob 列表（逗号 / 换行 / 空白分隔），去空。 */
function splitGlobs(input?: string): string[] {
  if (!input) return [];
  return input
    .split(/[\s,]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/** 把 rg 输出的 path（rg 对绝对路径参数会输出绝对路径）转为相对 root 的 posix 路径。
 *  Windows 盘符大小写不敏感比较；非 root 前缀则原样返回（仅转斜杠）。 */
function relativizePath(root: string, absOrRel: string): string {
  const p = absOrRel.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!r) return p;
  if (p.toLowerCase().startsWith(r.toLowerCase())) {
    let rel = p.slice(r.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    return rel;
  }
  return p;
}

/** 取 path JSON 值（text 优先；bytes 降级为 UTF-8 解码；无法解析返回 null）。 */
function pathText(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const obj = p as { text?: string; bytes?: number[] };
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.bytes)) {
    try {
      return Buffer.from(obj.bytes).toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 启动一次 ripgrep 搜索。返回 cancel 句柄。
 * 空 query 直接 onDone（不启动进程）。
 */
export function runSearch(args: RunSearchArgs, cb: SearchCallbacks): { cancel: () => void } {
  const { root, query, options } = args;

  if (!query.trim()) {
    cb.onDone();
    return { cancel: () => {} };
  }

  const argv: string[] = ['--json'];
  // 每文件 / 全局限流
  argv.push('--max-count', String(PER_FILE_LIMIT));
  argv.push('--max-filesize', MAX_FILESIZE);
  // 大小写：默认（matchCase=true）不传 → rg 区分大小写；false → -i
  if (!options.matchCase) argv.push('-i');
  // 全字
  if (options.wholeWord) argv.push('-w');
  // 正则 vs 固定字符串
  if (!options.isRegex) argv.push('-F');
  // include / exclude glob（rg -g 组合：include 间 OR，exclude(!) 优先剔除，恰好对应 VS Code 语义）
  for (const g of splitGlobs(options.include)) argv.push('-g', g);
  for (const g of splitGlobs(options.exclude)) argv.push('-g', `!${g}`);
  // pattern 用 -e 防止以 - 开头被当选项
  argv.push('-e', query);
  // 搜索路径
  argv.push(root);

  let child: ChildProcess;
  try {
    child = spawn(rgPath, argv, { cwd: root, windowsHide: true });
  } catch (e) {
    cb.onError(`无法启动 ripgrep：${e instanceof Error ? e.message : String(e)}`);
    return { cancel: () => {} };
  }

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    cb.onError('ripgrep stdio 不可用');
    return { cancel: () => {} };
  }

  // 运行态
  let currentFile: SearchFileResult | null = null;
  let totalMatches = 0;
  let totalFiles = 0;
  let lastProgressAt = 0;
  let cancelled = false;
  let stderrText = '';

  const flushProgress = (force = false) => {
    // 每 50 个匹配或强制时推送一次进度，避免高频 IPC
    if (force || totalMatches - lastProgressAt >= 50) {
      lastProgressAt = totalMatches;
      cb.onProgress({ matches: totalMatches, files: totalFiles });
    }
  };

  const finishFile = () => {
    if (currentFile) {
      cb.onFileResult(currentFile);
      totalFiles += 1;
      currentFile = null;
    }
  };

  const rl = createInterface({ input: stdout, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    if (cancelled) return;
    if (!raw) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 非 JSON 行（理论不应出现），忽略
    }
    const type: string = msg?.type;
    const data = msg?.data;
    if (type === 'begin') {
      const p = pathText(data?.path);
      if (p == null) return;
      finishFile(); // 保险：上一文件若未收到 end 也先结算
      currentFile = { path: relativizePath(root, p), matches: [] };
    } else if (type === 'match') {
      const p = pathText(data?.path);
      const lineNo: number | undefined = data?.line_number;
      const lineRaw: string | undefined =
        typeof data?.lines?.text === 'string' ? data.lines.text : undefined;
      const subs: any[] | undefined = data?.submatches;
      if (p == null || lineNo == null || lineRaw == null || !Array.isArray(subs)) return;

      // 若 begin 丢失（极少见），补一个当前文件
      if (!currentFile || currentFile.path !== relativizePath(root, p)) {
        finishFile();
        currentFile = { path: relativizePath(root, p), matches: [] };
      }

      const lineText = lineRaw.replace(/\r?\n$/, '');
      const submatches: SearchSubmatch[] = subs.map((s) => {
        const start: number = s.start ?? 0;
        const end: number = s.end ?? start;
        const text: string =
          typeof s.match?.text === 'string' ? s.match.text : lineText.slice(start, end);
        return {
          startCol: byteOffsetToCol(lineRaw, start),
          endCol: byteOffsetToCol(lineRaw, end),
          text,
        };
      });

      currentFile.matches.push({ path: relativizePath(root, p), line: lineNo, lineText, submatches });
      totalMatches += 1;
      flushProgress();

      // 全局上限：结算并取消
      if (totalMatches >= GLOBAL_RESULT_LIMIT) {
        finishFile();
        flushProgress(true);
        cancelled = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        cb.onDone();
      }
    } else if (type === 'end') {
      finishFile();
    } else if (type === 'summary') {
      const s = data?.stats;
      if (s) {
        cb.onDone({
          matchedLines: s.matched_lines ?? totalMatches,
          matches: s.matches ?? totalMatches,
          filesWithMatch: s.searches_with_match ?? totalFiles,
          bytesSearched: s.bytes_searched ?? 0,
        });
      } else {
        cb.onDone();
      }
    }
  });

  stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    if (cancelled) return;
    cb.onError(`ripgrep 执行失败：${err.message}`);
  });

  child.on('exit', (code, signal) => {
    rl.close();
    if (cancelled) return;
    // exit 2 = 错误（如非法正则）
    if (code === 2) {
      const msg = stderrText.trim() || 'ripgrep 报错（exit 2）';
      cb.onError(msg);
      return;
    }
    // stdout 可能未触发 summary 就结束（被信号杀 / 边界情况）：补一个 onDone
    finishFile();
    flushProgress(true);
    // 若 summary 已在 line 事件中推送过 onDone，这里再调一次也无害（渲染层幂等收尾）
    cb.onDone();
  });

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      finishFile();
      flushProgress(true);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      cb.onDone();
    },
  };
}
