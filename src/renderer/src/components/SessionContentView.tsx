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

interface Props {
  sessionKey: string;
  sessionName: string;
}

/** 一个对话轮次：用户消息 + 其后的 assistant/tool 步骤序列 + 最终回复。 */
interface TurnGroup {
  userMsg: SessionMessage;
  /** 按原始顺序排列的 assistant 中间步骤（thinking / tool 调用）。 */
  steps: Array<
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; toolName?: string; content: string }
  >;
  /** 最后一个 assistant 的最终回复文本。 */
  finalText: string;
}

/** 尝试解析 JSON 对象/数组；非候选或解析失败（可能被截断）时返回 null。 */
function tryParseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 格式化 tool 内容：若是 JSON 则美化缩进，否则原样返回。 */
function formatToolContent(raw: string): string {
  const obj = tryParseJson(raw);
  return obj !== null ? JSON.stringify(obj, null, 2) : raw;
}

/** 取内容的单行预览（首行非空内容，超长截断）。 */
function preview(text: string, max = 120): string {
  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return firstLine.length > max ? firstLine.slice(0, max) + '…' : firstLine;
}

/** tool 预览：JSON 紧凑单行，否则首行。 */
function toolPreview(raw: string): string {
  const obj = tryParseJson(raw);
  if (obj !== null) {
    const compact = JSON.stringify(obj);
    return compact.length > 120 ? compact.slice(0, 120) + '…' : compact;
  }
  return preview(raw);
}

/** 折叠/展开行的键盘事件：Enter / Space 触发回调，供 role=button 元素复用。 */
const toggleOnKey =
  (fn: () => void) => (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

export function SessionContentView({ sessionKey, sessionName }: Props) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 每个 step 的展开状态，key = `${gi}:${si}`。 */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 每个轮次 Process 折叠块的展开状态，key = gi。默认收起。 */
  const [processExpanded, setProcessExpanded] = useState<Record<number, boolean>>({});
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
    setProcessExpanded({});
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
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!loading) scrollToBottom();
  }, [loading]);

  const toggle = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleProcess = (gi: number) => {
    setProcessExpanded((prev) => ({ ...prev, [gi]: !prev[gi] }));
  };

  /**
   * 将扁平消息列表按「用户消息」分组。
   * 每组：用户消息 → 其后的所有 assistant / tool 消息，直到下一条用户消息或结尾。
   * thinking 与 tool 按原始出现顺序保留为 steps，避免丢失交替顺序。
   */
  const turnGroups = useMemo(() => {
    const groups: TurnGroup[] = [];
    let current: TurnGroup | null = null;

    for (const msg of messages) {
      if (msg.role === 'user') {
        current = { userMsg: msg, steps: [], finalText: '' };
        groups.push(current);
      } else if (msg.role === 'assistant' && current) {
        if (msg.thinking) current.steps.push({ kind: 'thinking', text: msg.thinking });
        if (msg.content) current.finalText = msg.content;
      } else if (msg.role === 'tool' && current) {
        current.steps.push({ kind: 'tool', toolName: msg.toolName, content: msg.content });
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
      {turnGroups.map((group, gi) => (
        <div key={gi} className="turn-group">
          {/* ── 用户消息气泡（无图标，保持原有气泡样式） ── */}
          <div className="session-msg session-msg-user">
            <div className="session-msg-content">{group.userMsg.content}</div>
          </div>

          {/* ── Process 折叠块：包襄所有 thinking / tool_call，默认收起 ── */}
          {group.steps.length > 0 && (() => {
            const procOpen = !!processExpanded[gi];
            const thinkCount = group.steps.filter((s) => s.kind === 'thinking').length;
            const toolCount = group.steps.filter((s) => s.kind === 'tool').length;
            const summary = [
              thinkCount ? `${thinkCount} 条思考` : '',
              toolCount ? `${toolCount} 次工具调用` : '',
            ].filter(Boolean).join(' · ');
            return (
              <div className={`pi-process${procOpen ? ' expanded' : ''}`}>
                <div
                  className="pi-process-header"
                  role="button"
                  tabIndex={0}
                  aria-expanded={procOpen}
                  onClick={() => toggleProcess(gi)}
                  onKeyDown={toggleOnKey(() => toggleProcess(gi))}
                >
                  <span className="pi-row-arrow">▶</span>
                  <span className="pi-process-label">Process</span>
                  <span className="pi-row-sep">›</span>
                  <span className="pi-process-summary">{summary}</span>
                </div>
                {procOpen && (
                  <div className="pi-process-body">
                    {group.steps.map((step, si) => {
                      const key = `${gi}:${si}`;
                      const isOpen = !!expanded[key];

                      if (step.kind === 'thinking') {
                        return (
                          <div key={key} className={`pi-row${isOpen ? ' expanded' : ''}`}>
                            <div
                              className="pi-row-header"
                              role="button"
                              tabIndex={0}
                              aria-expanded={isOpen}
                              onClick={() => toggle(key)}
                              onKeyDown={toggleOnKey(() => toggle(key))}
                            >
                              <span className="pi-row-arrow">▶</span>
                              <span className="pi-row-label pi-row-label-thinking">Thinking</span>
                              <span className="pi-row-sep">›</span>
                              <span className="pi-row-preview">{preview(step.text)}</span>
                            </div>
                            {isOpen && <div className="pi-row-body pi-row-body-text">{step.text}</div>}
                          </div>
                        );
                      }

                      // tool
                      const formatted = formatToolContent(step.content);
                      return (
                        <div key={key} className={`pi-row${isOpen ? ' expanded' : ''}`}>
                          <div
                            className="pi-row-header"
                            role="button"
                            tabIndex={0}
                            aria-expanded={isOpen}
                            onClick={() => toggle(key)}
                            onKeyDown={toggleOnKey(() => toggle(key))}
                          >
                            <span className="pi-row-arrow">▶</span>
                            <span className="pi-row-label pi-row-label-tool">Tool_Call</span>
                            <span className="pi-row-sep">›</span>
                            <span className="pi-row-toolname">{step.toolName ?? '?'}</span>
                            <span className="pi-row-sep">·</span>
                            <span className="pi-row-preview">{toolPreview(step.content)}</span>
                          </div>
                          {isOpen && (
                            <div className="pi-row-body">
                              <pre>
                                <code>{formatted}</code>
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Pi 最终回复：无气泡，markdown 渲染 ── */}
          {group.finalText && (
            <div className="pi-reply">
              <SessionMarkdownRenderer content={group.finalText} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
