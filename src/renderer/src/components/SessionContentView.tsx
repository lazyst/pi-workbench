import { useEffect, useRef, useState, useMemo } from 'react';
import { pi } from '../ipc';
import { SessionMarkdownRenderer } from './SessionMarkdownRenderer';

export interface SessionMessage {
  role: string;
  content: string;
  toolName?: string;
  /** 助理消息的思考过程。 */
  thinking?: string;
}

export const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: 'Pi',
  system: '系统',
  tool: '工具调用',
};

export const ROLE_ICON: Record<string, string> = {
  user: '👤',
  assistant: '🤖',
  system: '⚙',
  tool: '🔧',
};

interface Props {
  sessionKey: string;
  sessionName: string;
}

/** 一个对话轮次：用户消息 + 其后所有 assistant 及 tool 消息。 */
interface TurnGroup {
  userMsg: SessionMessage;
  /** 该轮次中所有 assistant 消息的 thinking 列表。 */
  thinkings: string[];
  /** 该轮次中所有 tool 消息。 */
  tools: Array<{ toolName?: string; content: string }>;
  /** 最后一个 assistant 的最终回复（前面的 assistant 回复归入 process）。 */
  finalText: string;
}

export function SessionContentView({ sessionKey, sessionName }: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const viewRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setExpanded({});
    pi.readSessionContent(sessionKey)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionKey]);

  useEffect(() => {
    if (!loading) scrollToBottom();
  }, [loading]);

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  /**
   * 将扁平消息列表按「用户消息」分组。
   * 每组：用户消息 → 其后的所有 assistant / tool 消息，直到下一条用户消息或结尾。
   */
  const turnGroups = useMemo(() => {
    const groups: TurnGroup[] = [];
    let current: TurnGroup | null = null;

    for (const msg of messages) {
      if (msg.role === 'user') {
        // 遇到用户消息 → 新轮次
        current = { userMsg: msg, thinkings: [], tools: [], finalText: '' };
        groups.push(current);
      } else if (msg.role === 'assistant' && current) {
        // assistant 消息：thinking 归入列表，text 暂存（可能被下一条覆盖）
        if (msg.thinking) current.thinkings.push(msg.thinking);
        if (msg.content) current.finalText = msg.content;
      } else if (msg.role === 'tool' && current) {
        // tool 消息归入当前轮次
        current.tools.push({ toolName: msg.toolName, content: msg.content });
      }
      // system 消息忽略
    }
    return groups;
  }, [messages]);

  return (
    <div className="session-content-view" ref={viewRef}>
      {loading && <div className="empty-state">加载中...</div>}
      {error && <div className="error-state">⚠ {error}</div>}
      {!loading && !error && messages.length === 0 && (
        <div className="empty-state">会话内容为空</div>
      )}
      {turnGroups.map((group, gi) => {
        const hasThinking = group.thinkings.length > 0;
        const hasTools = group.tools.length > 0;
        const showProcess = hasThinking || hasTools;
        const isExpanded = !!expanded[gi];

        return (
          <div key={gi} className="turn-group">
            {/* ── 用户消息 ── */}
            <div className="session-msg session-msg-user">
              <div className="session-msg-role">
                {ROLE_ICON.user} {ROLE_LABEL.user}
              </div>
              <div className="session-msg-content">{group.userMsg.content}</div>
            </div>

            {/* ── Process 折叠块（所有 thinking + 所有 tool 调用） ── */}
            {showProcess && (
              <div className="session-msg session-msg-assistant">
                <div className={`session-process${isExpanded ? ' expanded' : ''}`}>
                  <div
                    className="session-process-header"
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpand(gi)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(gi);
                      }
                    }}
                  >
                    <span className="session-process-arrow">{isExpanded ? '▼' : '▶'}</span>
                    <span className="session-process-label">Process</span>
                    <span className="session-process-summary">
                      {hasThinking && '思考'}
                      {hasThinking && hasTools && ' · '}
                      {hasTools && `${group.tools.length} 个工具调用`}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="session-process-body">
                      {/* 所有思考过程 */}
                      {group.thinkings.map((thinking, ti) => (
                        <div key={ti} className="session-process-thinking">
                          <div className="session-process-sub-label">思考过程</div>
                          <div className="session-process-content">{thinking}</div>
                        </div>
                      ))}
                      {/* 所有工具调用 */}
                      {group.tools.map((tool, ti) => (
                        <div key={ti} className="session-process-tool">
                          <div className="session-process-sub-label">
                            <span className="tool-label">tool</span>
                            <span className="tool-name">[{tool.toolName ?? '?'}]</span>
                          </div>
                          <pre className="session-process-tool-content"><code className="hljs">{tool.content}</code></pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── 最终回复（仅最后一个 assistant 的文本） ── */}
                {group.finalText && (
                  <div className="session-markdown-renderer-wrapper">
                    <SessionMarkdownRenderer content={group.finalText} />
                  </div>
                )}
              </div>
            )}

            {/* ── 无 process 但有最终回复（纯文本回复，无 thinking 无 tool） ── */}
            {!showProcess && group.finalText && (
              <div className="session-msg session-msg-assistant">
                <div className="session-msg-role">
                  {ROLE_ICON.assistant} {ROLE_LABEL.assistant}
                </div>
                <div className="session-markdown-renderer-wrapper">
                  <SessionMarkdownRenderer content={group.finalText} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}