import { useEffect, useState, useCallback } from 'react';
import { pi } from '../../ipc';
import { useDebouncedSave } from '../../hooks/useDebouncedSave';

// ─── 模型配置组件（完整版，对齐 pi-tool 全部高级配置项）───────────────

interface Provider {
  key: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ModelDef[];
  headers?: Record<string, string>;
  compat?: ProviderCompat;
  _collapsed?: boolean;
}

interface ProviderCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: string;
  thinkingFormat?: string;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  supportsStrictMode?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  cacheControlFormat?: string;
}

interface ModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevelMap?: Record<string, string | null>;
  compat?: ModelCompat;
  _collapsed?: boolean;
}

interface ModelCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  thinkingFormat?: string;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  cacheControlFormat?: string;
}

// ─── 兼容性配置字段定义 ────────────────────────────────────────────────

const COMPAT_PROVIDER_FIELDS: Array<{ key: keyof ProviderCompat; label: string; type: 'bool' | 'select'; options?: string[]; optionLabels?: string[] }> = [
  { key: 'supportsStore', label: 'store 字段', type: 'bool' },
  { key: 'supportsDeveloperRole', label: '支持 developer 角色', type: 'bool' },
  { key: 'supportsReasoningEffort', label: '支持 reasoning_effort', type: 'bool' },
  { key: 'supportsUsageInStreaming', label: '流式支持用量信息', type: 'bool' },
  { key: 'maxTokensField', label: 'max_tokens 字段名', type: 'select', options: ['', 'max_completion_tokens', 'max_tokens'], optionLabels: ['默认', 'max_completion_tokens', 'max_tokens'] },
  { key: 'thinkingFormat', label: '推理格式', type: 'select', options: ['', 'reasoning_effort', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template'],
    optionLabels: ['默认', 'reasoning_effort', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template'] },
  { key: 'requiresToolResultName', label: '工具结果需要 name 字段', type: 'bool' },
  { key: 'requiresAssistantAfterToolResult', label: '工具结果后需要 assistant 消息', type: 'bool' },
  { key: 'requiresThinkingAsText', label: '将思考块转为文本', type: 'bool' },
  { key: 'supportsStrictMode', label: '工具定义支持 strict 字段', type: 'bool' },
  { key: 'supportsEagerToolInputStreaming', label: '支持 Eager Tool Input Streaming', type: 'bool' },
  { key: 'supportsLongCacheRetention', label: '支持长期缓存', type: 'bool' },
  { key: 'forceAdaptiveThinking', label: '强制自适应思考', type: 'bool' },
  { key: 'allowEmptySignature', label: '允许空 thinking 签名', type: 'bool' },
  { key: 'cacheControlFormat', label: '缓存控制格式', type: 'select', options: ['', 'anthropic'], optionLabels: ['无', 'anthropic'] },
];

const COMPAT_MODEL_FIELDS: Array<{ key: keyof ModelCompat; label: string; type: 'bool' | 'select'; options?: string[]; optionLabels?: string[] }> = [
  { key: 'supportsStore', label: 'store 字段', type: 'bool' },
  { key: 'supportsDeveloperRole', label: '支持 developer 角色', type: 'bool' },
  { key: 'supportsReasoningEffort', label: '支持 reasoning_effort', type: 'bool' },
  { key: 'thinkingFormat', label: '推理格式', type: 'select', options: ['', 'reasoning_effort', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template'],
    optionLabels: ['默认', 'reasoning_effort', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'qwen-chat-template'] },
  { key: 'requiresThinkingAsText', label: '将思考块转为文本', type: 'bool' },
  { key: 'requiresReasoningContentOnAssistantMessages', label: 'assistant 消息含 reasoning_content', type: 'bool' },
  { key: 'cacheControlFormat', label: '缓存控制格式', type: 'select', options: ['', 'anthropic'], optionLabels: ['无', 'anthropic'] },
];

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// ─── 组件 ──────────────────────────────────────────────────────────────

export function PiModelConfig() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [status, setStatus] = useState('加载中...');
  // 折叠状态：section key → boolean
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) => {
    setCollapsedSections(prev => ({ ...prev, [key]: prev[key] === false }));
  };

  const load = useCallback(async () => {
    setStatus('加载中...');
    try {
      const data = await pi.piModelsGet();
      const list: Provider[] = [];
      if (data.providers) {
        for (const [key, value] of Object.entries(data.providers)) {
          const p = value as Provider;
          list.push({ ...p, key, _collapsed: true, models: (p.models || []).map(m => ({ ...m, _collapsed: true })) });
        }
      }
      setProviders(list);
      setStatus(`${list.length} 个提供者`);
    } catch (err) {
      setStatus('加载失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 防抖自动保存（800ms）：providers 变化时自动持久化
  useDebouncedSave(providers, async (providersList) => {
    const providersObj: Record<string, unknown> = {};
    for (const p of providersList) {
      if (!p.key?.trim()) continue;
      const { _collapsed, ...clean } = p;
      if (clean.models) {
        clean.models = clean.models.map(m => {
          const { _collapsed: mc, ...cleanM } = m;
          // 清理空 thinkingLevelMap
          if (cleanM.thinkingLevelMap) {
            const filtered: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(cleanM.thinkingLevelMap)) {
              if (v !== undefined) filtered[k] = v;
            }
            cleanM.thinkingLevelMap = Object.keys(filtered).length > 0 ? filtered : undefined;
          }
          // 清理空 cost
          if (cleanM.cost) {
            const hasCost = Object.values(cleanM.cost as Record<string, number | undefined>).some(v => v != null);
            if (!hasCost) delete cleanM.cost;
          }
          return cleanM;
        });
      }
      // 清理空 headers
      if (clean.headers && Object.keys(clean.headers).length === 0) delete clean.headers;
      providersObj[p.key.trim()] = clean;
    }
    await pi.piModelsSet({ providers: providersObj });
    setStatus(`${providersList.length} 个提供者`);
  }, { delay: 800, deepCompare: true });

  // ── Provider CRUD ──

  const updateProvider = (idx: number, field: string, value: unknown) => {
    setProviders(prev => { const next = [...prev]; next[idx] = { ...next[idx], [field]: value }; return next; });
  };

  const updateProviderCompat = (pIdx: number, field: keyof ProviderCompat, value: unknown) => {
    setProviders(prev => {
      const next = [...prev];
      next[pIdx] = { ...next[pIdx], compat: { ...(next[pIdx].compat || {}), [field]: value } };
      return next;
    });
  };

  const addProvider = () => {
    setProviders(prev => [...prev, {
      key: '', baseUrl: '', api: 'openai-completions', apiKey: '',
      models: [], _collapsed: false,
    }]);
  };

  const removeProvider = (idx: number) => {
    setProviders(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleProvider = (idx: number) => {
    setProviders(prev => { const next = [...prev]; next[idx] = { ...next[idx], _collapsed: !next[idx]._collapsed }; return next; });
  };

  // ── Model CRUD ──

  const addModel = (pIdx: number) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models.push({ id: '', name: '', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, _collapsed: false });
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const removeModel = (pIdx: number, mIdx: number) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models.splice(mIdx, 1);
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const updateModel = (pIdx: number, mIdx: number, field: string, value: unknown) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models[mIdx] = { ...models[mIdx], [field]: value };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const updateModelCost = (pIdx: number, mIdx: number, field: string, value: number | null) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models[mIdx] = { ...models[mIdx], cost: { ...(models[mIdx].cost || {}), [field]: value } };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const updateModelCompat = (pIdx: number, mIdx: number, field: keyof ModelCompat, value: unknown) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models[mIdx] = { ...models[mIdx], compat: { ...(models[mIdx].compat || {}), [field]: value } };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const updateThinkingLevel = (pIdx: number, mIdx: number, level: string, value: string | null | undefined) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      const tlMap = { ...(models[mIdx].thinkingLevelMap || {}) };
      if (value === undefined) delete tlMap[level];
      else tlMap[level] = value;
      models[mIdx] = { ...models[mIdx], thinkingLevelMap: tlMap };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  const toggleModel = (pIdx: number, mIdx: number) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      models[mIdx] = { ...models[mIdx], _collapsed: !models[mIdx]._collapsed };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  // ── Headers ──

  const addHeader = (pIdx: number) => {
    setProviders(prev => {
      const next = [...prev];
      next[pIdx] = { ...next[pIdx], headers: { ...(next[pIdx].headers || {}), [`header-${Date.now()}`]: '' } };
      return next;
    });
  };

  const updateHeader = (pIdx: number, oldKey: string, newKey: string, value: string) => {
    setProviders(prev => {
      const next = [...prev];
      const headers = { ...(next[pIdx].headers || {}) };
      if (oldKey !== newKey) { delete headers[oldKey]; headers[newKey] = value; }
      else { headers[oldKey] = value; }
      next[pIdx] = { ...next[pIdx], headers };
      return next;
    });
  };

  const removeHeader = (pIdx: number, key: string) => {
    setProviders(prev => {
      const next = [...prev];
      const headers = { ...(next[pIdx].headers || {}) };
      delete headers[key];
      next[pIdx] = { ...next[pIdx], headers };
      return next;
    });
  };

  // ── 输入类型切换 ──

  const toggleInputType = (pIdx: number, mIdx: number, type: string) => {
    setProviders(prev => {
      const next = [...prev];
      const models = [...(next[pIdx].models || [])];
      const input = [...(models[mIdx].input || ['text'])];
      const idx = input.indexOf(type);
      if (idx >= 0) input.splice(idx, 1);
      else input.push(type);
      models[mIdx] = { ...models[mIdx], input };
      next[pIdx] = { ...next[pIdx], models };
      return next;
    });
  };

  // ── 渲染辅助 ──

  const renderBool = (label: string, value: boolean | undefined, onChange: (v: boolean) => void) => (
    <div className="pi-field-row" key={label}>
      <label>{label}</label>
      <label className="pi-toggle">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        <span className="pi-toggle-slider" />
      </label>
    </div>
  );

  const renderSelect = (label: string, value: string | undefined, options: string[], optionLabels: string[] | undefined, onChange: (v: string) => void) => (
    <div className="pi-field-row" key={label}>
      <label>{label}</label>
      <select className="pi-select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
        {options.map((opt, i) => (
          <option key={opt} value={opt}>{optionLabels ? optionLabels[i] : opt || '(默认)'}</option>
        ))}
      </select>
    </div>
  );

  const renderNumberInput = (label: string, value: number | undefined | null, placeholder: string, onChange: (v: number | null) => void) => (
    <div className="pi-field-row" key={label}>
      <label>{label}</label>
      <input className="pi-input" type="number" value={value ?? ''} placeholder={placeholder}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : null)} />
    </div>
  );

  // ── 渲染兼容性字段 ──

  const renderProviderCompatFields = (pIdx: number, compat: ProviderCompat | undefined) => (
    <div className="pi-compat-grid">
      {COMPAT_PROVIDER_FIELDS.map(f => {
        const val = compat?.[f.key];
        if (f.type === 'bool') {
          return renderBool(f.label, val as boolean | undefined, (v) => updateProviderCompat(pIdx, f.key, v));
        }
        if (f.type === 'select') {
          return renderSelect(f.label, val as string, f.options!, f.optionLabels, (v) => updateProviderCompat(pIdx, f.key, v));
        }
        return null;
      })}
    </div>
  );

  const renderModelCompatFields = (pIdx: number, mIdx: number, compat: ModelCompat | undefined) => (
    <div className="pi-compat-grid">
      {COMPAT_MODEL_FIELDS.map(f => {
        const val = compat?.[f.key];
        if (f.type === 'bool') {
          return renderBool(f.label, val as boolean | undefined, (v) => updateModelCompat(pIdx, mIdx, f.key, v));
        }
        if (f.type === 'select') {
          return renderSelect(f.label, val as string, f.options!, f.optionLabels, (v) => updateModelCompat(pIdx, mIdx, f.key, v));
        }
        return null;
      })}
    </div>
  );

  // ── 渲染提供者卡片 ──

  const renderProvider = (p: Provider, pIdx: number) => {
    const compatSectionKey = `pcompat-${pIdx}`;
    const compatCollapsed = collapsedSections[compatSectionKey] !== false;
    const headersSectionKey = `headers-${pIdx}`;
    const headersCollapsed = collapsedSections[headersSectionKey] !== false;

    return (
      <div key={pIdx} className="pi-provider-card">
        <div className="pi-provider-header" onClick={() => toggleProvider(pIdx)}>
          <span className="pi-collapse-icon">{p._collapsed ? '▶' : '▼'}</span>
          <span className="pi-provider-key">{p.key || '新提供者'}</span>
          <span className="pi-provider-meta">{(p.models || []).length} 个模型</span>
          <button className="pi-btn-danger" onClick={(e) => { e.stopPropagation(); removeProvider(pIdx); }}>删除</button>
        </div>
        {!p._collapsed && (
          <div className="pi-provider-body">
            {/* 基本字段 */}
            <div className="pi-field-row">
              <label>提供者标识</label>
              <input className="pi-input" value={p.key} onChange={e => updateProvider(pIdx, 'key', e.target.value)} placeholder="例如: my-provider" />
            </div>
            <div className="pi-field-row">
              <label>API 地址</label>
              <input className="pi-input" value={p.baseUrl || ''} onChange={e => updateProvider(pIdx, 'baseUrl', e.target.value)} placeholder="http://localhost:11434/v1" />
            </div>
            <div className="pi-field-row">
              <label>API 类型</label>
              <select className="pi-select" value={p.api || 'openai-completions'} onChange={e => updateProvider(pIdx, 'api', e.target.value)}>
                <option value="openai-completions">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses API</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
              </select>
            </div>
            <div className="pi-field-row">
              <label>API 密钥</label>
              <input className="pi-input" type="password" value={p.apiKey || ''} onChange={e => updateProvider(pIdx, 'apiKey', e.target.value)} placeholder="密钥 或 $ENV_VAR 或 !command" />
            </div>

            {/* 自定义请求头（折叠） */}
            <div className="pi-section">
              <div className="pi-collapsible-header" onClick={() => toggleSection(headersSectionKey)}>
                <span className="pi-collapse-icon">{headersCollapsed ? '▶' : '▼'}</span>
                <span className="pi-section-title">自定义请求头 ({Object.keys(p.headers || {}).length})</span>
              </div>
              {!headersCollapsed && (
                <div className="pi-collapsible-body">
                  {(p.headers && Object.keys(p.headers).length > 0) && (
                    <div className="pi-kv-list">
                      {Object.entries(p.headers).map(([k, v]) => (
                        <div className="pi-kv-row" key={k}>
                          <input className="pi-input" value={k} onChange={e => updateHeader(pIdx, k, e.target.value, v)} placeholder="Header 名" />
                          <input className="pi-input" value={v} onChange={e => updateHeader(pIdx, k, k, e.target.value)} placeholder="Header 值" />
                          <button className="pi-btn-danger-sm" onClick={() => removeHeader(pIdx, k)}>删除</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button className="btn btn-sm" onClick={() => addHeader(pIdx)}>＋ 添加请求头</button>
                </div>
              )}
            </div>

            {/* 提供者兼容性配置（折叠） */}
            <div className="pi-section">
              <div className="pi-collapsible-header" onClick={() => toggleSection(compatSectionKey)}>
                <span className="pi-collapse-icon">{compatCollapsed ? '▶' : '▼'}</span>
                <span className="pi-section-title">兼容性配置</span>
              </div>
              {!compatCollapsed && renderProviderCompatFields(pIdx, p.compat)}
            </div>

            {/* 模型列表 */}
            <div className="pi-section">
              <div className="pi-section-title">模型列表</div>
              <button className="btn btn-sm" onClick={() => addModel(pIdx)}>＋ 添加模型</button>
              <div className="pi-model-list">
                {(p.models || []).map((m, mIdx) => renderModelCard(p, m, pIdx, mIdx))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── 渲染模型卡片 ──

  const renderModelCard = (p: Provider, m: ModelDef, pIdx: number, mIdx: number) => {
    const costSectionKey = `cost-${pIdx}-${mIdx}`;
    const costCollapsed = collapsedSections[costSectionKey] !== false;
    const tlSectionKey = `tl-${pIdx}-${mIdx}`;
    const tlCollapsed = collapsedSections[tlSectionKey] !== false;
    const mCompatSectionKey = `mcompat-${pIdx}-${mIdx}`;
    const mCompatCollapsed = collapsedSections[mCompatSectionKey] !== false;

    const inputTypes = m.input || ['text'];
    const tlMap = m.thinkingLevelMap || {};

    return (
      <div key={mIdx} className="pi-model-card">
        <div className="pi-model-header" onClick={() => toggleModel(pIdx, mIdx)}>
          <span className="pi-collapse-icon">{m._collapsed ? '▶' : '▼'}</span>
          <span className="pi-model-id">{m.id || '新模型'}</span>
          <button className="pi-btn-danger" onClick={(e) => { e.stopPropagation(); removeModel(pIdx, mIdx); }}>删除</button>
        </div>
        {!m._collapsed && (
          <div className="pi-model-body">
            {/* 基本字段 */}
            <div className="pi-field-row">
              <label>模型 ID</label>
              <input className="pi-input" value={m.id} onChange={e => updateModel(pIdx, mIdx, 'id', e.target.value)} placeholder="llama3.1:8b" />
            </div>
            <div className="pi-field-row">
              <label>模型名称</label>
              <input className="pi-input" value={m.name || ''} onChange={e => updateModel(pIdx, mIdx, 'name', e.target.value)} placeholder="可读名称" />
            </div>
            <div className="pi-field-row">
              <label>推理能力</label>
              <label className="pi-toggle">
                <input type="checkbox" checked={!!m.reasoning} onChange={e => updateModel(pIdx, mIdx, 'reasoning', e.target.checked)} />
                <span className="pi-toggle-slider" />
              </label>
            </div>

            {/* 输入类型 */}
            <div className="pi-field-row">
              <label>输入类型</label>
              <div className="pi-checkbox-group">
                {['text', 'image'].map(type => (
                  <label className="pi-checkbox-label" key={type}>
                    <input type="checkbox" checked={inputTypes.includes(type)}
                      onChange={() => toggleInputType(pIdx, mIdx, type)} />
                    <span>{type}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* 上下文窗口 / 最大输出 */}
            <div className="pi-field-row">
              <label>上下文窗口</label>
              <input className="pi-input" type="number" value={m.contextWindow ?? ''} onChange={e => updateModel(pIdx, mIdx, 'contextWindow', e.target.value ? Number(e.target.value) : null)} placeholder="128000" />
            </div>
            <div className="pi-field-row">
              <label>最大输出</label>
              <input className="pi-input" type="number" value={m.maxTokens ?? ''} onChange={e => updateModel(pIdx, mIdx, 'maxTokens', e.target.value ? Number(e.target.value) : null)} placeholder="16384" />
            </div>

            {/* 费用配置（折叠） */}
            <div className="pi-section">
              <div className="pi-collapsible-header" onClick={() => toggleSection(costSectionKey)}>
                <span className="pi-collapse-icon">{costCollapsed ? '▶' : '▼'}</span>
                <span className="pi-section-title">费用配置 (每百万 tokens){m.cost?.input != null ? ' · 有数据' : ''}</span>
              </div>
              {!costCollapsed && (
                <div className="pi-collapsible-body">
                  <div className="pi-cost-grid">
                    {renderNumberInput('输入价格', m.cost?.input, '0', v => updateModelCost(pIdx, mIdx, 'input', v))}
                    {renderNumberInput('输出价格', m.cost?.output, '0', v => updateModelCost(pIdx, mIdx, 'output', v))}
                    {renderNumberInput('缓存读取', m.cost?.cacheRead, '0', v => updateModelCost(pIdx, mIdx, 'cacheRead', v))}
                    {renderNumberInput('缓存写入', m.cost?.cacheWrite, '0', v => updateModelCost(pIdx, mIdx, 'cacheWrite', v))}
                  </div>
                </div>
              )}
            </div>

            {/* 思考层级映射（折叠） */}
            <div className="pi-section">
              <div className="pi-collapsible-header" onClick={() => toggleSection(tlSectionKey)}>
                <span className="pi-collapse-icon">{tlCollapsed ? '▶' : '▼'}</span>
                <span className="pi-section-title">思考层级映射</span>
              </div>
              {!tlCollapsed && (
                <div className="pi-collapsible-body">
                  {THINKING_LEVELS.map(lvl => {
                    const val = tlMap[lvl];
                    const isNull = val === null;
                    const isSupported = val !== undefined && val !== null;
                    return (
                      <div className="pi-tl-row" key={lvl}>
                        <span className="pi-tl-label">{lvl}</span>
                        <select className="pi-select pi-tl-select"
                          value={isNull ? 'null' : isSupported ? 'supported' : ''}
                          onChange={e => {
                            if (e.target.value === 'null') updateThinkingLevel(pIdx, mIdx, lvl, null);
                            else if (e.target.value === 'supported') updateThinkingLevel(pIdx, mIdx, lvl, '');
                            else updateThinkingLevel(pIdx, mIdx, lvl, undefined);
                          }}>
                          <option value="">未配置</option>
                          <option value="supported">已支持</option>
                          <option value="null">不支持的</option>
                        </select>
                        {isSupported && (
                          <input className="pi-input pi-tl-value" value={val ?? ''} placeholder="映射值"
                            onChange={e => updateThinkingLevel(pIdx, mIdx, lvl, e.target.value || '')} />
                        )}
                      </div>
                    );
                  })}
                  <p className="pi-tl-hint">每个层级选择"不支持"或输入发送给提供者的值</p>
                </div>
              )}
            </div>

            {/* 模型兼容性配置（折叠） */}
            <div className="pi-section">
              <div className="pi-collapsible-header" onClick={() => toggleSection(mCompatSectionKey)}>
                <span className="pi-collapse-icon">{mCompatCollapsed ? '▶' : '▼'}</span>
                <span className="pi-section-title">兼容性配置</span>
              </div>
              {!mCompatCollapsed && (
                <div className="pi-collapsible-body">
                  {renderModelCompatFields(pIdx, mIdx, m.compat)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="pi-model-config">
      <div className="pi-model-toolbar">
        <span className="pi-settings-badge">{status}</span>
        <div className="pi-model-toolbar-actions">
          <button className="btn btn-sm" onClick={addProvider}>＋ 添加提供者</button>
          <button className="btn btn-sm" onClick={load}>↻ 刷新
          </button>
        </div>
      </div>

      <div className="pi-model-providers">
        {providers.length === 0 && (
          <div className="pi-model-empty">
            <p>暂无提供者配置</p>
            <p className="pi-model-empty-hint">点击上方按钮添加第一个 AI 模型提供者</p>
          </div>
        )}
        {providers.map((p, pIdx) => renderProvider(p, pIdx))}
      </div>
    </div>
  );
}