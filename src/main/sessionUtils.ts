import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 解码 pi 编码的目录名。
 * pi 的目录名编码：反斜杠 → "--"，盘符冒号被直接丢弃（D: → D）。
 * 还原 Windows 盘符的绝对路径："X\\" → "X:\\"。
 */
export function decodeCwd(enc: string): string {
  let s = enc;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  s = s.replace(/--/g, '\\');
  return s.replace(/^([A-Za-z])\\/, '$1:\\');
}

/**
 * 从文件名中提取可读时间戳。
 * 文件名格式如 "2026-07-03T19-07-11-857Z_abc.jsonl" → "2026-07-03 19:07"。
 * 不匹配时原样返回。
 */
export function formatTimestamp(filename: string): string {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return filename;
  return `${m[1]} ${m[2]}:${m[3]}`;
}

/**
 * 读取 session 文件的第一行 JSON，提取 cwd 字段。
 */
export function readSessionCwd(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' ? obj.cwd : undefined;
  } catch { return undefined; }
}

/**
 * 读取 session 文件中可读名称，优先级：
 * 1. 最新的 session_info 条目的 name 字段（由 /name 命令设置）
 * 2. 第一条 user 消息（截断到 80 字符）
 * 3. undefined（无匹配时）
 *
 * pi 的 jsonl 是 append-only：/name 会把 session_info 记录追加到文件末尾附近，
 * 因此长会话的 session_info 可能远在前 64KB 之外。这里从文件尾部反向分块扫描，
 * 取「最新」（文件中最后一条）有 name 的 session_info——与 pi 自身
 * session-manager 的 getSessionName() 反向遍历语义一致。找不到再回退到
 * 文件头部的首条 user 消息。
 */
export function readSessionName(file: string): string | undefined {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
  try {
    const size = fs.fstatSync(fd).size;
    const sessionInfoName = scanLatestSessionInfoName(fd, size);
    if (sessionInfoName) return sessionInfoName;

    // 回退：从头读首条 user 消息（截断到 80 字符）
    return readFirstUserMessage(fd);
  } catch { /* ignore read errors (e.g. file being written) */
  } finally {
    try { fs.closeSync(fd); } catch { /* noop */ }
  }
  return undefined;
}

/**
 * 从文件末尾反向分块扫描，返回最新一条 session_info 的 name（trim 后非空）。
 * 由于 pi 追加写入，最新的 session_info 总在文件末尾附近，通常 1~2 个块即命中。
 * 块边界可能把一行 JSON 切成两段：把当前块的「块首残行」拼到下一（更早）块的
 * 末尾再解析，保证跨块行完整。
 */
function scanLatestSessionInfoName(fd: number, size: number): string | undefined {
  const CHUNK = 65536;
  let tail = '';
  let pos = size;
  while (pos > 0) {
    const readLen = Math.min(CHUNK, pos);
    const chunkStart = pos - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, chunkStart);
    const text = buf.toString('utf8') + tail;
    const lines = text.split('\n');
    // 块首可能是不完整行，留给下一（更早的）块末尾拼接后再解析
    tail = lines[0];
    // 从块尾往块首解析（最新在前），跳过残行 lines[0]
    for (let i = lines.length - 1; i >= 1; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj?.type === 'session_info' && typeof obj.name === 'string' && obj.name.trim()) {
          return obj.name.trim();
        }
      } catch { /* skip non-JSON / malformed lines */ }
    }
    pos = chunkStart;
  }
  return undefined;
}

/** 从文件头部读首条 user 消息（截断到 80 字符）。回退用：文件无 session_info 时。 */
function readFirstUserMessage(fd: number): string | undefined {
  const buf = Buffer.alloc(65536);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  const text = buf.toString('utf8', 0, n);
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj?.type === 'message' && obj?.message?.role === 'user') {
        const c = obj.message.content;
        const str = Array.isArray(c)
          ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
          : String(c ?? '');
        const clean = str.replace(/\s+/g, ' ').trim();
        if (clean) return clean.length > 80 ? clean.slice(0, 80) : clean;
      }
    } catch { /* skip non-JSON / malformed lines */ }
  }
  return undefined;
}

/**
 * 读取目录下第一个 .jsonl 文件的 cwd 作为该目录的 cwd。
 */
export function readGroupCwd(dir: string): string | undefined {
  const first = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return first ? readSessionCwd(path.join(dir, first)) : undefined;
}