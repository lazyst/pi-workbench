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
      const messages: SessionMessage[] = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          // 只处理 message 类型行
          if (obj?.type !== 'message') continue;
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
        } catch { /* skip non-JSON / malformed lines */ }
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
