import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TerminalDebugSnapshot } from './unifiedTerminalPool';
import { decodeCwd, formatTimestamp, readSessionCwd, readSessionName, readGroupCwd } from './sessionUtils';

export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  /** 助理消息的思考过程（与 content 最终回复分开）。 */
  thinking?: string;
}

export class SessionFileManager {
  constructor(private sessionsDir: string) {}

  listFiles(): SessionGroup[] {
    const root = this.sessionsDir;
    if (!fs.existsSync(root)) return [];
    const groups: SessionGroup[] = [];
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cwd = readGroupCwd(dir) ?? decodeCwd(enc);
      const sessions = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const file = path.join(dir, f);
          const stamp = formatTimestamp(f);
          const name = readSessionName(file) ?? stamp;
          return { key: file, name, time: stamp };
        });
      groups.push({ cwd, sessions });
    }
    return groups;
  }

  dirForCwd(cwd: string): string | undefined {
    const root = this.sessionsDir;
    if (!fs.existsSync(root)) return undefined;
    for (const enc of fs.readdirSync(root)) {
      const dir = path.join(root, enc);
      if (!fs.statSync(dir).isDirectory()) continue;
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(enc);
      if (groupCwd === cwd) return dir;
    }
    return undefined;
  }

  deleteSession(key: string): void {
    if (!key.endsWith('.jsonl')) return;
    const dir = path.resolve(this.sessionsDir);
    const target = path.resolve(key);
    const inside = target === dir || target.startsWith(dir + path.sep);
    if (!inside) return;
    try { fs.rmSync(target, { force: true }); } catch { /* 忽略占用 / 竞态 */ }
  }

  deleteMany(keys: string[]): void {
    for (const k of keys) this.deleteSession(k);
  }

  clearDirectory(cwd: string): void {
    const dir = this.dirForCwd(cwd);
    if (!dir) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 忽略占用 / 竞态 */ }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 非空或被占用 */ }
  }

  readContent(key: string): SessionMessage[] {
    if (!key.endsWith('.jsonl')) return [];
    const dir = path.resolve(this.sessionsDir);
    const target = path.resolve(key);
    if (!target.startsWith(dir + path.sep) && target !== dir) return [];
    try {
      const text = fs.readFileSync(key, 'utf8');

      // 先解析所有非空行（保留文件顺序）。
      const records: any[] = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { /* skip non-JSON / malformed lines */ }
      }

      // pi 的会话文件是一棵树：每条带 id 的记录通过 parentId 指向父节点。
      // 用户用 /tree 回溯后再发消息会形成分叉。当前活动分支的末端 =
      // 文件中最后一条「带 parentId 字段」的记录；从末端沿 parentId 回溯
      // 得到当前分支的 id 集合，只显示该分支上的消息。
      const byId = new Map<string, any>();
      let tipId: string | undefined;
      for (const obj of records) {
        if (!obj || typeof obj !== 'object') continue;
        if (typeof obj.id !== 'string' || !obj.id) continue;
        byId.set(obj.id, obj);
        // 末尾覆盖，最终得到最后一条带 parentId 的记录
        if (Object.hasOwn(obj, 'parentId')) tipId = obj.id;
      }

      // 从末端沿 parentId 链回溯当前分支（含 cycle 防护）
      const keepIds = new Set<string>();
      let cur: string | null | undefined = tipId;
      let guard = 0;
      while (cur && byId.has(cur) && guard++ < 100000) {
        keepIds.add(cur);
        const parent = byId.get(cur)!.parentId;
        cur = typeof parent === 'string' && parent ? parent : null;
      }

      const messages: SessionMessage[] = [];
      for (const obj of records) {
        if (obj?.type !== 'message') continue;
        // 有 parentId 链时只保留当前分支上的消息；无 id 的旧格式消息回退为全量显示
        if (tipId && typeof obj.id === 'string' && obj.id && !keepIds.has(obj.id)) continue;
        const msg = obj.message;
        if (!msg?.role) continue;

        if (msg.role === 'user') {
          // 用户消息：content 是 [{type: "text", text: "..."}]
          const content = extractContentParts(msg.content);
          if (content) messages.push({ role: 'user', content });
        } else if (msg.role === 'assistant') {
          // 助理消息：content 可能包含 text / thinking / toolCall
          const parts = Array.isArray(msg.content) ? msg.content : [];
          // 提取 thinking 部分（type === 'thinking'）
          const thinking =
            parts
              .filter((p: any) => p?.type === 'thinking' && typeof p.thinking === 'string')
              .map((p: any) => p.thinking)
              .join('\n')
              .trim() || undefined;
          // 提取 text 部分（最终回复）
          const finalText = extractContentParts(msg.content);
          if (finalText || thinking) {
            messages.push({ role: 'assistant', content: finalText || '', thinking });
          }
          // 检查是否有 toolCall 内嵌在 content 数组中
          for (const part of parts) {
            if (part?.type === 'toolCall' && part?.name) {
              const args = typeof part.arguments === 'object'
                ? JSON.stringify(part.arguments, null, 2)
                : String(part.arguments ?? '');
              messages.push({
                role: 'tool',
                content: args.slice(0, 2000),
                toolName: part.name,
              });
            }
          }
        } else if (msg.role === 'toolResult' || msg.role === 'tool') {
          // 工具结果
          const result = extractContentParts(msg.content);
          messages.push({
            role: 'tool',
            content: result || '(空结果)',
            toolName: msg.toolName ?? 'unknown',
          });
        } else if (msg.role === 'system') {
          const content = extractContentParts(msg.content);
          if (content) messages.push({ role: 'system', content });
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  /** 汇总调试快照：统计运行中终端的数量与 pid 列表。
   * 接收 UnifiedTerminalPool.debugSnapshot() 的只读快照，不直接依赖池内部结构。 */
  debugInfo(snapshot: TerminalDebugSnapshot[]): { count: number; pids: number[] } {
    const running = snapshot.filter((e) => e.status === 'running');
    return { count: running.length, pids: running.map((e) => e.pid).filter((p: number) => p > 0) };
  }
}

function extractContentParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('')
      .trim();
  }
  return String(content ?? '');
}

// 重新导出工具函数：保持向后兼容

export { decodeCwd, formatTimestamp, readSessionCwd, readSessionName, readGroupCwd } from './sessionUtils';
