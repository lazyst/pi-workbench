import { useEffect, useState, useCallback, useRef } from 'react';
import { pi } from '../../ipc';

// ─── 类型定义 ──────────────────────────────────────────────────────────

interface McpFile {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  config: {
    mcpServers?: Record<string, McpServer>;
    settings?: Record<string, unknown>;
    imports?: string[];
  } | null;
}

interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  socket?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: string;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: string;
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: boolean | string[];
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources?: boolean;
  debug?: boolean;
  trace?: boolean;
  disabled?: boolean;
  oauth?: {
    grantType?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    redirectUri?: string;
    clientName?: string;
    clientUri?: string;
  };
}

type TransportType = 'stdio' | 'http' | 'socket';

// ─── 常量 ──────────────────────────────────────────────────────────────

const LIFECYCLE_OPTIONS = [
  { value: 'lazy', label: '惰性 (lazy)', desc: '默认。首次调用工具时连接，空闲超时后断开' },
  { value: 'eager', label: '即时 (eager)', desc: '启动时连接，断开后不自动重连' },
  { value: 'keep-alive', label: '长连接 (keep-alive)', desc: '启动时连接，健康检查自动重连，无空闲超时' },
  { value: 'lazy-keep-alive', label: '惰性长连接 (lazy-keep-alive)', desc: '首次调用时连接，之后保持长连接' },
];

const TOOL_PREFIX_OPTIONS = [
  { value: 'server', label: 'server（默认）', desc: '以服务器名称为前缀' },
  { value: 'short', label: 'short', desc: '去除 -mcp 后缀' },
  { value: 'none', label: 'none', desc: '无前缀' },
  { value: 'mcp', label: 'mcp', desc: '以 mcp__ 为前缀' },
];

const HOST_CONFIG_OPTIONS = [
  { value: 'off', label: '关闭（默认）', desc: '不发现主机配置' },
  { value: 'prompt', label: '仅提示', desc: '检测并报告，但不加载' },
  { value: 'on', label: '开启', desc: '加载检测到的主机配置作为最低优先级回退' },
];

const AUTH_OPTIONS = [
  { value: '', label: '无' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'oauth', label: 'OAuth' },
];

const OAUTH_GRANT_OPTIONS = [
  { value: 'authorization_code', label: '授权码 (authorization_code)' },
  { value: 'client_credentials', label: '客户端凭证 (client_credentials)' },
];

const IMPORT_OPTIONS = [
  'cursor', 'claude-code', 'claude-desktop', 'opencode', 'vscode', 'windsurf', 'codex',
];

// ─── 工具函数 ──────────────────────────────────────────────────────────

// 传输类型由字段「存在性」推断（而非 truthy）：切到 http/socket 时
// 初值字段是空字符串 ''，若按 truthy 判断会回落 stdio，导致下拉框看似无反应。
function detectTransport(server: McpServer): TransportType {
  if (server.socket !== undefined) return 'socket';
  if (server.url !== undefined) return 'http';
  return 'stdio';
}

function getTransportDefaults(transport: TransportType): Partial<McpServer> {
  switch (transport) {
    case 'stdio':
      return { command: '', args: [], url: undefined, socket: undefined, headers: undefined, auth: undefined, bearerToken: undefined, bearerTokenEnv: undefined, oauth: undefined };
    case 'http':
      return { url: '', command: undefined, args: undefined, socket: undefined, cwd: undefined };
    case 'socket':
      return { socket: '', command: undefined, args: undefined, url: undefined, cwd: undefined, headers: undefined, auth: undefined, bearerToken: undefined, bearerTokenEnv: undefined, oauth: undefined };
  }
}

// 把 directTools 字段值映射为下拉选项值（true/false/list）。
function directToolsValue(dt: unknown): string {
  if (dt === true) return 'true';
  if (Array.isArray(dt)) return 'list';
  return 'false';
}

// ─── 主组件 ────────────────────────────────────────────────────────────

export function PiMcpManager() {
  const [files, setFiles] = useState<McpFile[]>([]);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [mcpVersion, setMcpVersion] = useState<string | undefined>();
  const [status, setStatus] = useState('检测中...');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [importInputs, setImportInputs] = useState<Record<string, string>>({});
  // 服务器重命名：正在重命名的目标 + 草稿 + 错误提示
  const [renaming, setRenaming] = useState<{ fIdx: number; sKey: string; draft: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const initialLoadDone = useRef(false);
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    setStatus('检测中...');
    try {
      const statusData = await pi.piMcpStatus();
      setInstalled(statusData.installed);
      setMcpVersion(statusData.version);
      if (statusData.installed) {
        const configs = await pi.piMcpConfigs();
        // Pi agent 目录的配置文件排到最前面
        const sorted = (configs as McpFile[]).sort((a, b) => {
          const aIsPi = a.id.includes('agent') || a.label.includes('Pi');
          const bIsPi = b.id.includes('agent') || b.label.includes('Pi');
          if (aIsPi && !bIsPi) return -1;
          if (!aIsPi && bIsPi) return 1;
          return 0;
        });
        setFiles(sorted);
        setStatus('已加载');
      } else {
        setFiles([]);
        setStatus('未安装');
      }
    } catch (err) {
      setStatus('检测失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 初始加载完成后标记，之后 files 变更触发自动保存（防抖 800ms）
  useEffect(() => {
    if (!initialLoadDone.current) {
      if (status === '已加载' || status === '检测失败') {
        initialLoadDone.current = true;
      }
      return;
    }
    // 清除所有已存在的定时器（防抖）
    const timers = saveTimers.current;
    Object.values(timers).forEach(t => clearTimeout(t));

    files.forEach((file, fIdx) => {
      if (!file.exists || !file.config) return;
      timers[fIdx] = setTimeout(async () => {
        try {
          await pi.piMcpConfigsSave({ id: file.id, config: file.config });
        } catch { /* 静默失败 */ }
      }, 800);
    });

    return () => {
      Object.values(timers).forEach(t => clearTimeout(t));
    };
  }, [files, status]);

  const toggleFile = (fIdx: number) => {
    toggleSection(`file-${fIdx}`);
  };

  const toggleSection = (section: string) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const startRename = (fIdx: number, sKey: string) => {
    setRenaming({ fIdx, sKey, draft: sKey });
    setRenameError(null);
  };

  const commitRename = () => {
    if (!renaming) return;
    const { fIdx, sKey: oldKey, draft } = renaming;
    const trimmed = draft.trim();
    if (!trimmed) { setRenameError('名称不能为空'); return; }
    if (trimmed === oldKey) { setRenaming(null); setRenameError(null); return; }
    const servers = files[fIdx]?.config?.mcpServers;
    if (servers && Object.prototype.hasOwnProperty.call(servers, trimmed)) {
      setRenameError('已存在同名服务器');
      return;
    }
    renameServer(fIdx, oldKey, trimmed);
    setRenaming(null);
    setRenameError(null);
  };

  const updateFile = (fIdx: number, updater: (f: McpFile) => McpFile) => {
    setFiles(prev => {
      const next = [...prev];
      next[fIdx] = updater(next[fIdx]);
      return next;
    });
  };

  const addServer = (fIdx: number) => {
    updateFile(fIdx, (f) => ({
      ...f,
      exists: true,
      config: { ...f.config, mcpServers: { ...(f.config?.mcpServers || {}), [`new-server-${Date.now()}`]: { command: '', args: [] } } },
    }));
  };

  const removeServer = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      delete servers[sKey];
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  // value 为 undefined 时删除字段，避免配置残留 command: undefined 等脏数据
  //（JSON 序列化后会变成 "command": null），也保证 detectTransport 的
  //「存在性判断」语义干净——切换传输方式时旧字段会被真正移除。
  const updateServer = (fIdx: number, sKey: string, field: string, value: unknown) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      if (value === undefined) {
        delete server[field as keyof McpServer];
      } else {
        server[field as keyof McpServer] = value as never;
      }
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  // 重命名服务器：重建 mcpServers 对象的 key（名字即 key）。
  // 校验在调用方（commitRename）基于当前 files 完成。
  const renameServer = (fIdx: number, oldKey: string, newKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const reordered: Record<string, McpServer> = {};
      for (const [k, v] of Object.entries(servers)) {
        if (k === oldKey) reordered[newKey] = v;
        else reordered[k] = v;
      }
      return { ...f, config: { ...f.config, mcpServers: reordered } };
    });
  };

  const updateNestedOauth = (fIdx: number, sKey: string, field: string, value: unknown) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.oauth = { ...(server.oauth || {}), [field]: value };
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateSettings = (fIdx: number, field: string, value: unknown) => {
    updateFile(fIdx, (f) => ({
      ...f,
      config: { ...f.config, settings: { ...(f.config?.settings || {}), [field]: value } },
    }));
  };

  const addServerArg = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.args = [...(server.args || []), ''];
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateServerArg = (fIdx: number, sKey: string, idx: number, value: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const args = [...(server.args || [])];
      args[idx] = value;
      server.args = args;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeServerArg = (fIdx: number, sKey: string, idx: number) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.args = (server.args || []).filter((_, i) => i !== idx);
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const addEnv = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.env = { ...(server.env || {}), [`KEY_${Date.now()}`]: '' };
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateEnv = (fIdx: number, sKey: string, oldKey: string, newKey: string, value: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const env = { ...(server.env || {}) };
      if (oldKey !== newKey) {
        delete env[oldKey];
        env[newKey] = value;
      } else {
        env[oldKey] = value;
      }
      server.env = env;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeEnv = (fIdx: number, sKey: string, key: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const env = { ...(server.env || {}) };
      delete env[key];
      server.env = env;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const addHeader = (fIdx: number, sKey: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      server.headers = { ...(server.headers || {}), [`Header-${Date.now()}`]: '' };
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const updateHeader = (fIdx: number, sKey: string, oldKey: string, newKey: string, value: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const headers = { ...(server.headers || {}) };
      if (oldKey !== newKey) {
        delete headers[oldKey];
        headers[newKey] = value;
      } else {
        headers[oldKey] = value;
      }
      server.headers = headers;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeHeader = (fIdx: number, sKey: string, key: string) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const headers = { ...(server.headers || {}) };
      delete headers[key];
      server.headers = headers;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const addImport = (fIdx: number, value: string) => {
    if (!value) return;
    updateFile(fIdx, (f) => {
      const imports = [...(f.config?.imports || [])];
      if (!imports.includes(value)) {
        imports.push(value);
      }
      return { ...f, config: { ...f.config, imports } };
    });
  };

  const removeImport = (fIdx: number, value: string) => {
    updateFile(fIdx, (f) => {
      const imports = (f.config?.imports || []).filter(i => i !== value);
      return { ...f, config: { ...f.config, imports } };
    });
  };

  const addTagToStringArray = (fIdx: number, sKey: string, field: string, value: string) => {
    if (!value) return;
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const arr = [...(server[field as keyof McpServer] as string[] || []), value];
      server[field as keyof McpServer] = arr as any;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  const removeFromStringArray = (fIdx: number, sKey: string, field: string, idx: number) => {
    updateFile(fIdx, (f) => {
      const servers = { ...(f.config?.mcpServers || {}) };
      const server = { ...(servers[sKey] || {}) };
      const arr = (server[field as keyof McpServer] as string[] || []).filter((_, i) => i !== idx);
      server[field as keyof McpServer] = arr as any;
      servers[sKey] = server;
      return { ...f, config: { ...f.config, mcpServers: servers } };
    });
  };

  // ─── 渲染辅助 ─────────────────────────────────────────────────────────

  const renderTagList = (
    fIdx: number,
    sKey: string,
    field: string,
    items: string[] | undefined,
    placeholder: string,
  ) => (
    <div className="pi-tag-list" style={{ flex: 1 }}>
      {(items || []).map((item, i) => (
        <span className="pi-tag-item" key={i}>
          <span className="pi-tag-value">{item}</span>
          <button className="pi-btn-danger-sm" onClick={() => removeFromStringArray(fIdx, sKey, field, i)}>×</button>
        </span>
      ))}
      <input
        className="pi-input pi-tag-input"
        placeholder={placeholder}
        onKeyDown={e => {
          if (e.key === 'Enter' && e.currentTarget.value.trim()) {
            addTagToStringArray(fIdx, sKey, field, e.currentTarget.value.trim());
            e.currentTarget.value = '';
          }
        }}
        onBlur={e => {
          if (e.currentTarget.value.trim()) {
            addTagToStringArray(fIdx, sKey, field, e.currentTarget.value.trim());
            e.currentTarget.value = '';
          }
        }}
      />
    </div>
  );

  const renderKvList = (
    kv: Record<string, string> | undefined,
    keyPlaceholder: string,
    valPlaceholder: string,
    onUpdate: (oldKey: string, newKey: string, value: string) => void,
    onRemove: (key: string) => void,
    onAdd: () => void,
  ) => (
    <div className="pi-section">
      <div className="pi-section-title">{keyPlaceholder} ({Object.keys(kv || {}).length})</div>
      {kv && Object.keys(kv).length > 0 && (
        <div className="pi-kv-list">
          {Object.entries(kv).map(([k, v]) => (
            <div className="pi-kv-row" key={k}>
              <input className="pi-input" value={k} onChange={e => onUpdate(k, e.target.value, v)} placeholder={keyPlaceholder} />
              <input className="pi-input" value={v} onChange={e => onUpdate(k, k, e.target.value)} placeholder={valPlaceholder} />
              <button className="pi-btn-danger-sm" onClick={() => onRemove(k)}>删除</button>
            </div>
          ))}
        </div>
      )}
      <button className="btn btn-sm" onClick={onAdd}>＋ 添加</button>
    </div>
  );

  // ─── 渲染：服务器卡片 ──────────────────────────────────────────────────

  const renderServerCard = (fIdx: number, sKey: string, server: McpServer) => {
    const transport = detectTransport(server);
    const isStdio = transport === 'stdio';
    const isHttp = transport === 'http';
    const isSocket = transport === 'socket';
    const otherSection = `other-${fIdx}-${sKey}`;
    const serverKey = `svr-${fIdx}-${sKey}`;
    const isServerOpen = expanded[serverKey] === true;
    const isRenaming = renaming?.fIdx === fIdx && renaming?.sKey === sKey;

    return (
      <div className="pi-mcp-server" key={sKey}>
        <div className="pi-mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => toggleSection(serverKey)}>
          <span className="pi-collapse-icon">{isServerOpen ? '▼' : '▶'}</span>
          {isRenaming ? (
            <input
              className="pi-input pi-mcp-server-name"
              style={renameError ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
              autoFocus
              value={renaming!.draft}
              onChange={e => { setRenaming({ ...renaming!, draft: e.target.value }); setRenameError(null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                else if (e.key === 'Escape') { setRenaming(null); setRenameError(null); }
              }}
              onBlur={() => commitRename()}
              onClick={e => e.stopPropagation()}
              title={renameError ?? '回车确认，Esc 取消'}
              placeholder="服务器名称"
            />
          ) : (
            <>
              <span className="pi-mcp-server-name" title={renameError ?? undefined}>{sKey}</span>
              <button className="btn btn-sm" title="重命名" style={{ padding: '0 6px', flex: 'none' }}
                onClick={e => { e.stopPropagation(); startRename(fIdx, sKey); }}>✎</button>
            </>
          )}
          <label className="pi-toggle" style={{ marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={!server.disabled}
              onChange={e => updateServer(fIdx, sKey, 'disabled', !e.target.checked)} />
            <span className="pi-toggle-slider" />
            <span className="pi-toggle-text">启用</span>
          </label>
          <button className="pi-btn-danger" onClick={e => { e.stopPropagation(); removeServer(fIdx, sKey); }}>删除</button>
        </div>
        {isServerOpen && (
        <div className="pi-mcp-server-body">
          {/* ── 传输方式 ── */}
          <div className="pi-field-row">
            <label>传输方式</label>
            <select className="pi-select" value={transport}
              onChange={e => {
                const t = e.target.value as TransportType;
                const defaults = getTransportDefaults(t);
                Object.entries(defaults).forEach(([k, v]) => updateServer(fIdx, sKey, k, v));
              }}>
              <option value="stdio">标准输入输出 (stdio)</option>
              <option value="http">HTTP</option>
              <option value="socket">Unix Socket</option>
            </select>
          </div>

          {/* ── Stdio 字段 ── */}
          {isStdio && (
            <>
              <div className="pi-field-row">
                <label>命令</label>
                <input className="pi-input" value={server.command || ''} onChange={e => updateServer(fIdx, sKey, 'command', e.target.value)} placeholder="npx" />
              </div>
              <div className="pi-field-row">
                <label>参数</label>
                <div className="pi-tag-list" style={{ flex: 1 }}>
                  {(server.args || []).map((arg, i) => (
                    <span className="pi-tag-item" key={i}>
                      <input className="pi-input pi-tag-input" value={arg} onChange={e => updateServerArg(fIdx, sKey, i, e.target.value)} />
                      <button className="pi-btn-danger-sm" onClick={() => removeServerArg(fIdx, sKey, i)}>×</button>
                    </span>
                  ))}
                  <button className="btn btn-sm" onClick={() => addServerArg(fIdx, sKey)}>＋</button>
                </div>
              </div>
              <div className="pi-field-row">
                <label>工作目录</label>
                <input className="pi-input" value={server.cwd || ''} onChange={e => updateServer(fIdx, sKey, 'cwd', e.target.value)} placeholder="~/project" />
              </div>
            </>
          )}

          {/* ── HTTP 字段 ── */}
          {isHttp && (
            <>
              <div className="pi-field-row">
                <label>URL</label>
                <input className="pi-input" value={server.url || ''} onChange={e => updateServer(fIdx, sKey, 'url', e.target.value)} placeholder="https://mcp.example.com/mcp" />
              </div>
              <div className="pi-field-row">
                <label>认证方式</label>
                <select className="pi-select" value={server.auth || ''}
                  onChange={e => {
                    const v = e.target.value;
                    updateServer(fIdx, sKey, 'auth', v || undefined);
                    if (!v) {
                      updateServer(fIdx, sKey, 'bearerToken', undefined);
                      updateServer(fIdx, sKey, 'bearerTokenEnv', undefined);
                      updateServer(fIdx, sKey, 'oauth', undefined);
                    }
                  }}>
                  {AUTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {server.auth === 'bearer' && (
                <>
                  <div className="pi-field-row">
                    <label>Token</label>
                    <input className="pi-input" value={server.bearerToken || ''}
                      onChange={e => updateServer(fIdx, sKey, 'bearerToken', e.target.value)}
                      placeholder="输入 token 或 !command 动态获取" />
                  </div>
                  <div className="pi-field-row">
                    <label>Token 环境变量</label>
                    <input className="pi-input" value={server.bearerTokenEnv || ''}
                      onChange={e => updateServer(fIdx, sKey, 'bearerTokenEnv', e.target.value)}
                      placeholder="MY_API_TOKEN" />
                  </div>
                </>
              )}
              {server.auth === 'oauth' && (
                <div className="pi-field-row">
                  <label>授权类型</label>
                  <select className="pi-select" value={server.oauth?.grantType || 'authorization_code'}
                    onChange={e => updateNestedOauth(fIdx, sKey, 'grantType', e.target.value)}>
                    {OAUTH_GRANT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              )}
              {renderKvList(
                server.headers,
                'Header-Name',
                'Header-Value',
                (oldKey, newKey, value) => updateHeader(fIdx, sKey, oldKey, newKey, value),
                (key) => removeHeader(fIdx, sKey, key),
                () => addHeader(fIdx, sKey),
              )}
            </>
          )}

          {/* ── Socket 字段 ── */}
          {isSocket && (
            <div className="pi-field-row">
              <label>Socket 路径</label>
              <input className="pi-input" value={server.socket || ''}
                onChange={e => updateServer(fIdx, sKey, 'socket', e.target.value)}
                placeholder="~/.rmcp-servers/memory.sock" />
            </div>
          )}

          {/* ── 环境变量 ── */}
          {renderKvList(
            server.env,
            'KEY',
            'VALUE',
            (oldKey, newKey, value) => updateEnv(fIdx, sKey, oldKey, newKey, value),
            (key) => removeEnv(fIdx, sKey, key),
            () => addEnv(fIdx, sKey),
          )}

          {/* ── 分隔线 ── */}
          <div className="pi-section-divider" />

          {/* ── 生命周期 ── */}
          <div className="pi-field-row">
            <label>生命周期</label>
            <select className="pi-select" value={server.lifecycle || 'lazy'}
              onChange={e => updateServer(fIdx, sKey, 'lifecycle', e.target.value)}>
              {LIFECYCLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span className="pi-hint-text">{LIFECYCLE_OPTIONS.find(o => o.value === (server.lifecycle || 'lazy'))?.desc}</span>
          </div>

          {/* ── 超时设置 ── */}
          <div className="pi-field-row">
            <label>空闲超时</label>
            <div className="input-unit-group">
              <input type="number" className="num-input" min={0} max={999} value={server.idleTimeout ?? ''}
                onChange={e => updateServer(fIdx, sKey, 'idleTimeout', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="默认" />
              <span className="settings-unit">分钟</span>
            </div>
            <span className="pi-hint-text">0=禁用，留空使用全局默认（10分钟）</span>
          </div>

          <div className="pi-field-row">
            <label>请求超时</label>
            <div className="input-unit-group">
              <input type="number" className="num-input" min={0} step={1000} value={server.requestTimeoutMs ?? ''}
                onChange={e => updateServer(fIdx, sKey, 'requestTimeoutMs', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="默认" />
              <span className="settings-unit">ms</span>
            </div>
            <span className="pi-hint-text">留空使用 MCP SDK 默认超时</span>
          </div>

          {/* ── 直接工具 ── */}
          <div className="pi-field-row">
            <label>直接工具</label>
            <select className="pi-select" value={directToolsValue(server.directTools)}
              onChange={e => {
                const v = e.target.value;
                if (v === 'true') updateServer(fIdx, sKey, 'directTools', true);
                else if (v === 'list') updateServer(fIdx, sKey, 'directTools', []);
                else updateServer(fIdx, sKey, 'directTools', false);
              }}>
              <option value="false">代理（默认）</option>
              <option value="true">全部注册为直接工具</option>
              <option value="list">选择部分工具</option>
            </select>
            <span className="pi-hint-text">直接工具以独立工具形式注册，每个约 150-300 token</span>
          </div>
          {Array.isArray(server.directTools) && (
            <div className="pi-field-row">
              <label>工具列表</label>
              {renderTagList(fIdx, sKey, 'directTools', server.directTools, '工具名称')}
            </div>
          )}

          {/* ── 暴露资源 ── */}
          <div className="pi-field-row">
            <label>暴露资源</label>
            <label className="toggle-label">
              <input type="checkbox" className="toggle-input"
                checked={server.exposeResources !== false}
                onChange={e => updateServer(fIdx, sKey, 'exposeResources', e.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
            <span className="pi-hint-text">将 MCP 资源作为工具暴露</span>
          </div>

          {/* ── 调试输出 ── */}
          <div className="pi-field-row">
            <label>调试输出</label>
            <label className="toggle-label">
              <input type="checkbox" className="toggle-input"
                checked={!!server.debug}
                onChange={e => updateServer(fIdx, sKey, 'debug', e.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
            <span className="pi-hint-text">显示服务器 stderr 输出</span>
          </div>



          {/* ── 其他配置（可折叠，默认展开） ── */}
          <div className="pi-collapsible">
            <div className="pi-collapsible-header" onClick={() => toggleSection(otherSection)}>
              <span className="pi-collapse-icon">{expanded[otherSection] === true ? '▼' : '▶'}</span>
              <span className="pi-section-title">其他配置</span>
              <span className="pi-hint-text" style={{ flex: 'none', fontSize: 'var(--fs-xs)', color: 'var(--text-faint)', marginLeft: 'auto' }}>
                {[
                  ...(server.includeTools?.length ? ['包含工具'] : []),
                  ...(server.excludeTools?.length ? ['排除工具'] : []),
                  ...(server.trace ? ['追踪'] : []),
                  ...(server.auth === 'oauth' ? ['OAuth'] : []),
                ].join('、')}
              </span>
            </div>
            {(expanded[otherSection] === true) && (
              <div className="pi-collapsible-body">
                {/* 包含工具 */}
                <div className="pi-field-row">
                  <label>包含工具</label>
                  {renderTagList(fIdx, sKey, 'includeTools', server.includeTools, '名称或 glob 模式')}
                </div>
                <p className="pi-hint-text" style={{ margin: '0 0 var(--sp-2) 35px' }}>只暴露匹配的工具，支持 glob 模式（如 get_*）</p>

                {/* 排除工具 */}
                <div className="pi-field-row">
                  <label>排除工具</label>
                  {renderTagList(fIdx, sKey, 'excludeTools', server.excludeTools, '名称或 glob 模式')}
                </div>
                <p className="pi-hint-text" style={{ margin: '0 0 var(--sp-2) 35px' }}>隐藏匹配的工具，在包含工具之后应用</p>

                {/* 协议追踪 */}
                <div className="pi-field-row">
                  <label>协议追踪</label>
                  <label className="toggle-label">
                    <input type="checkbox" className="toggle-input"
                      checked={!!server.trace}
                      onChange={e => updateServer(fIdx, sKey, 'trace', e.target.checked)} />
                    <span className="toggle-track"><span className="toggle-thumb" /></span>
                  </label>
                  <span className="pi-hint-text">启用元数据 JSONL 追踪（不含 payload 和凭证）</span>
                </div>

                {/* OAuth 高级配置 */}
                {server.auth === 'oauth' && (
                  <div className="pi-section" style={{ borderTop: '1px solid var(--border)', marginTop: 'var(--sp-2)', paddingTop: 'var(--sp-2)' }}>
                    <div className="pi-section-title">OAuth 高级配置</div>
                    <div className="pi-field-row">
                      <label>Client ID</label>
                      <input className="pi-input" value={server.oauth?.clientId || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'clientId', e.target.value)}
                        placeholder="预注册的客户端 ID" />
                    </div>
                    <div className="pi-field-row">
                      <label>Client Secret</label>
                      <input className="pi-input" type="password" value={server.oauth?.clientSecret || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'clientSecret', e.target.value)}
                        placeholder="机密客户端密钥" />
                    </div>
                    <div className="pi-field-row">
                      <label>Scope</label>
                      <input className="pi-input" value={server.oauth?.scope || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'scope', e.target.value)}
                        placeholder="请求的权限范围" />
                    </div>
                    <div className="pi-field-row">
                      <label>Redirect URI</label>
                      <input className="pi-input" value={server.oauth?.redirectUri || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'redirectUri', e.target.value)}
                        placeholder="http://localhost:3118/callback" />
                    </div>
                    <div className="pi-field-row">
                      <label>Client Name</label>
                      <input className="pi-input" value={server.oauth?.clientName || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'clientName', e.target.value)}
                        placeholder="动态注册时显示的名称" />
                    </div>
                    <div className="pi-field-row">
                      <label>Client URI</label>
                      <input className="pi-input" value={server.oauth?.clientUri || ''}
                        onChange={e => updateNestedOauth(fIdx, sKey, 'clientUri', e.target.value)}
                        placeholder="动态注册时显示的主页 URI" />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    );
  };

  // ─── 渲染：全局设置 ────────────────────────────────────────────────────

  const renderSettingsSection = (fIdx: number, file: McpFile) => {
    const settingsKey = `settings-${fIdx}`;
    const settings = file.config?.settings || {};
    const get = (key: string) => settings[key];
    const set = (key: string, value: unknown) => updateSettings(fIdx, key, value);

    return (
      <div className="pi-collapsible" style={{ marginTop: 'var(--sp-3)' }}>
        <div className="pi-collapsible-header" onClick={() => toggleSection(settingsKey)}>
          <span className="pi-collapse-icon">{expanded[settingsKey] === true ? '▼' : '▶'}</span>
          <span className="pi-section-title">全局设置</span>
        </div>
        {(expanded[settingsKey] === true) && (
          <div className="pi-collapsible-body">
            <p className="pi-hint-text" style={{ marginBottom: 'var(--sp-2)' }}>这些设置作用于所有服务器，服务器级别的设置会覆盖全局设置。</p>

            <div className="pi-field-row">
              <label>工具前缀</label>
              <select className="pi-select" value={get('toolPrefix') as string || 'server'}
                onChange={e => set('toolPrefix', e.target.value)}>
                {TOOL_PREFIX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <p className="pi-hint-text">{TOOL_PREFIX_OPTIONS.find(o => o.value === (get('toolPrefix') as string || 'server'))?.desc}</p>

            <div className="pi-field-row">
              <label>空闲超时</label>
              <div className="input-unit-group">
                <input type="number" className="num-input" min={0} max={999} value={get('idleTimeout') as number ?? ''}
                  onChange={e => set('idleTimeout', e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="10" />
                <span className="settings-unit">分钟</span>
              </div>
              <span className="pi-hint-text">全局空闲断开时间，0=禁用</span>
            </div>

            <div className="pi-field-row">
              <label>请求超时</label>
              <div className="input-unit-group">
                <input type="number" className="num-input" min={0} step={1000} value={get('requestTimeoutMs') as number ?? ''}
                  onChange={e => set('requestTimeoutMs', e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="SDK 默认" />
                <span className="settings-unit">ms</span>
              </div>
              <span className="pi-hint-text">全局 MCP 调用超时</span>
            </div>

            <div className="pi-field-row">
              <label>状态图标</label>
              <label className="toggle-label">
                <input type="checkbox" className="toggle-input"
                  checked={get('showStatusIcon') !== false}
                  onChange={e => set('showStatusIcon', e.target.checked)} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
              <span className="pi-hint-text">在 MCP 状态文本中显示插头图标</span>
            </div>

            <div className="pi-field-row">
              <label>主机配置发现</label>
              <select className="pi-select" value={get('hostConfigDiscovery') as string || 'off'}
                onChange={e => set('hostConfigDiscovery', e.target.value)}>
                {HOST_CONFIG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <p className="pi-hint-text">{HOST_CONFIG_OPTIONS.find(o => o.value === (get('hostConfigDiscovery') as string || 'off'))?.desc}</p>

            <div className="pi-field-row">
              <label>直接工具（全局）</label>
              <label className="toggle-label">
                <input type="checkbox" className="toggle-input"
                  checked={!!get('directTools')}
                  onChange={e => set('directTools', e.target.checked)} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
              <span className="pi-hint-text">所有服务器默认注册为直接工具（可被服务器设置覆盖）</span>
            </div>

            <div className="pi-field-row">
              <label>自动认证</label>
              <label className="toggle-label">
                <input type="checkbox" className="toggle-input"
                  checked={!!get('autoAuth')}
                  onChange={e => set('autoAuth', e.target.checked)} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
              <span className="pi-hint-text">连接/调用时自动运行 OAuth 并重试一次</span>
            </div>

            <div className="pi-collapsible" style={{ marginTop: 'var(--sp-2)' }}>
              <div className="pi-collapsible-header" onClick={(e) => { e.stopPropagation(); toggleSection(`settings-adv-${fIdx}`); }}>
                <span className="pi-collapse-icon">{expanded[`settings-adv-${fIdx}`] === true ? '▼' : '▶'}</span>
                <span className="pi-section-title">高级设置</span>
              </div>
              {(expanded[`settings-adv-${fIdx}`] === true) && (
                <div className="pi-collapsible-body" style={{ paddingLeft: 0 }}>
                  <div className="pi-field-row">
                    <label>禁用代理工具</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={!!get('disableProxyTool')}
                        onChange={e => set('disableProxyTool', e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">直接工具就绪后隐藏 mcp 代理工具</span>
                  </div>

                  <div className="pi-field-row">
                    <label>Sampling</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={get('sampling') !== false}
                        onChange={e => set('sampling', e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">允许 MCP 服务器通过 Pi 模型采样</span>
                  </div>

                  <div className="pi-field-row">
                    <label>Sampling 自动批准</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={!!get('samplingAutoApprove')}
                        onChange={e => set('samplingAutoApprove', e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">跳过 Sampling 确认提示</span>
                  </div>

                  <div className="pi-field-row">
                    <label>Elicitation</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={get('elicitation') !== false}
                        onChange={e => set('elicitation', e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">允许 MCP 服务器通过对话框请求用户输入</span>
                  </div>

                  <div className="pi-field-row">
                    <label>输出保护</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={get('outputGuard') !== false}
                        onChange={e => set('outputGuard', e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">防止大输出撑爆上下文（50KB/2000行上限）</span>
                  </div>

                  <div className="pi-field-row">
                    <label>协议追踪</label>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-input"
                        checked={!!get('trace')}
                        onChange={e => set('trace', e.target.checked ? { enabled: true } : undefined)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                    <span className="pi-hint-text">启用元数据 JSONL 协议追踪</span>
                  </div>

                  <div className="pi-field-row">
                    <label>OAuth 目录</label>
                    <input className="pi-input" value={get('oauthDir') as string || ''}
                      onChange={e => set('oauthDir', e.target.value || undefined)}
                      placeholder=".pi/mcp-oauth" />
                    <span className="pi-hint-text">旧版 tokens.json 导入目录</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─── 渲染：兼容性导入 ────────────────────────────────────────────────

  const renderImportsSection = (fIdx: number, file: McpFile) => {
    const importsKey = `imports-${fIdx}`;
    const imports = file.config?.imports || [];
    const newImport = importInputs[importsKey] || '';
    const setNewImport = (v: string) => setImportInputs(prev => ({ ...prev, [importsKey]: v }));

    return (
      <div className="pi-collapsible" style={{ marginTop: 'var(--sp-2)' }}>
        <div className="pi-collapsible-header" onClick={() => toggleSection(importsKey)}>
          <span className="pi-collapse-icon">{expanded[importsKey] === true ? '▼' : '▶'}</span>
          <span className="pi-section-title">兼容性导入 ({imports.length})</span>
        </div>
        {(expanded[importsKey] === true) && (
          <div className="pi-collapsible-body">
            <p className="pi-hint-text" style={{ marginBottom: 'var(--sp-2)' }}>
              导入其他主机的 MCP 配置格式。共享 MCP 文件已自动加载，此处仅需添加非标准格式。
            </p>
            <div className="pi-tag-list">
              {imports.map((im, i) => (
                <span className="pi-tag-item" key={i}>
                  <span className="pi-tag-value">{im}</span>
                  <button className="pi-btn-danger-sm" onClick={() => removeImport(fIdx, im)}>×</button>
                </span>
              ))}
            </div>
            <div className="pi-field-row" style={{ marginTop: 'var(--sp-2)' }}>
              <label>添加导入</label>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flex: 1 }}>
                <select className="pi-select" value={newImport}
                  onChange={e => setNewImport(e.target.value)}>
                  <option value="">选择主机...</option>
                  {IMPORT_OPTIONS.filter(opt => !imports.includes(opt)).map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                <button className="btn btn-sm" onClick={() => { addImport(fIdx, newImport); setNewImport(''); }}
                  disabled={!newImport}>＋ 添加</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ─── 渲染：主面板 ──────────────────────────────────────────────────────

  if (installed === false) {
    return (
      <div className="pi-mcp-manager">
        <div className="pi-mcp-toolbar">
          <span className="pi-settings-badge">{status}</span>
          <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
        </div>
        <div className="pi-mcp-install-card">
          <h3>需要安装 pi-mcp-adapter 扩展</h3>
          <p>MCP (Model Context Protocol) 适配器扩展，提供 MCP 服务器管理能力。</p>
          <p className="pi-mcp-install-tip">请在终端运行: <code>pi install npm:pi-mcp-adapter</code></p>
          <p className="pi-mcp-install-tip">安装完成后重启页面即可使用 MCP 管理功能</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pi-mcp-manager">
      <div className="pi-mcp-toolbar">
        <span className="pi-settings-badge">{status}{mcpVersion ? ` v${mcpVersion}` : ''}</span>
        <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
      </div>

      <div className="pi-mcp-files">
        {files.map((file, fIdx) => {
          const key = `file-${fIdx}`;
          const isExpanded = expanded[key] === true;
          const serverKeys = file.config?.mcpServers ? Object.keys(file.config.mcpServers) : [];
          return (
            <div className="pi-mcp-file-card" key={file.id}>
              <div className="pi-mcp-file-header" onClick={() => toggleFile(fIdx)}>
                <span className="pi-collapse-icon">{isExpanded ? '▼' : '▶'}</span>
                <span className="pi-mcp-file-label">{file.label}</span>
                <span className="pi-mcp-file-badge">{file.exists ? `${serverKeys.length} 个服务器` : '空文件'}</span>
              </div>
              {isExpanded && (
                <div className="pi-mcp-file-body">
                  <code className="pi-mcp-file-path">{file.path}</code>
                  {!file.exists ? (
                    <div className="pi-mcp-file-empty">
                      <p>此配置文件尚不存在</p>
                      <button className="btn btn-sm" onClick={() => addServer(fIdx)}>＋ 创建并添加服务器</button>
                    </div>
                  ) : (
                    <>
                      <div className="pi-mcp-server-list">
                        <div className="pi-mcp-server-list-header">
                          <span>服务器列表</span>
                          <button className="btn btn-sm" onClick={() => addServer(fIdx)}>＋ 添加服务器</button>
                        </div>
                        {serverKeys.map(sKey => renderServerCard(fIdx, sKey, file.config!.mcpServers![sKey]))}
                      </div>

                      {renderSettingsSection(fIdx, file)}

                      {renderImportsSection(fIdx, file)}

                      <div className="pi-mcp-file-actions">
                        <span className="pi-hint-text" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-faint)' }}>自动保存</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}