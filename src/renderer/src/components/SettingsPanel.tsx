import { Fragment, useEffect, useState } from 'react';
import { useDebouncedSave } from '../hooks/useDebouncedSave';
import { getTheme, getThemeFamily, setTheme, setThemeFamily } from '../theme';
import { pi } from '../ipc';
import { ConfirmDialog } from './ConfirmDialog';
import { SessionContentDialog } from './SessionContentDialog';
import { IconTrash } from './icons';
import type { Theme, ThemeFamily, CloseBehavior, SessionGroup, TerminalProfile, FontWeight } from '../types';
import { getFontSize, bumpFontSize, onFontSizeChange, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../fontSize';
import { PiConfigEditor } from './pi-settings/PiConfigEditor';
import { PiModelConfig } from './pi-settings/PiModelConfig';
import { PiMcpManager } from './pi-settings/PiMcpManager';
import { PiSkillsManager } from './pi-settings/PiSkillsManager';
import { PiExtensionsManager } from './pi-settings/PiExtensionsManager';
import { broadcastConfigUpdate } from '../lib/terminal-registry';

interface Props {
  onClose: () => void;
}

type NavKey = 'general' | 'sessions' | 'terminal' | 'pi-config' | 'pi-models' | 'pi-mcp' | 'pi-skills' | 'pi-extensions';

// 左侧导航项配置：key + 标签；sectionBreak 为 true 的项前插入分隔线 + 分组标题。
const NAV_ITEMS: { key: NavKey; label: string; sectionBreak?: boolean }[] = [
  { key: 'general', label: '常规' },
  { key: 'sessions', label: '会话管理' },
  { key: 'terminal', label: '终端' },
  { key: 'pi-config', label: '配置文件', sectionBreak: true },
  { key: 'pi-models', label: '模型配置' },
  { key: 'pi-mcp', label: 'MCP 管理' },
  { key: 'pi-skills', label: 'Skills 管理' },
  { key: 'pi-extensions', label: '扩展管理' },
];

// Modal settings panel with a left-hand navigation:
//  - 常规：主题、关闭按钮行为（原有设置项迁移至此）。
//  - 会话管理：展示全部磁盘会话（按目录分组），支持单条删除、清空目录、批量删除。
//  - Pi 设置：集成 pi-tool 的配置管理功能（配置文件、模型、MCP、Skills、扩展）。
const NAV_STORAGE_KEY = 'pi-desktop:settings-nav';

function loadSavedNav(): NavKey {
  try {
    const saved = localStorage.getItem(NAV_STORAGE_KEY);
    if (saved && NAV_ITEMS.some(i => i.key === saved)) {
      return saved as NavKey;
    }
  } catch { /* ignore */ }
  return 'general';
}

/** 导航项按钮。 */
function NavItem({ nav, current, onSelect, label }: { nav: NavKey; current: NavKey; onSelect: (n: NavKey) => void; label: string }) {
  const active = nav === current;
  return (
    <button
      type="button"
      className={`nav-item${active ? ' active' : ''}`}
      aria-current={active}
      onClick={() => onSelect(nav)}
    >
      {label}
    </button>
  );
}

/** 按 nav 渲染对应面板（避免嵌套三元）。各面板为 function 声明，在文件下方续肩提升后引用。 */
function renderNavContent(nav: NavKey) {
  switch (nav) {
    case 'general': return <GeneralSettings />;
    case 'sessions': return <SessionManagement />;
    case 'terminal': return <TerminalSettings />;
    case 'pi-config': return <PiConfigEditor />;
    case 'pi-models': return <PiModelConfig />;
    case 'pi-mcp': return <PiMcpManager />;
    case 'pi-skills': return <PiSkillsManager />;
    case 'pi-extensions': return <PiExtensionsManager />;
  }
}

function saveNav(nav: NavKey) {
  try {
    localStorage.setItem(NAV_STORAGE_KEY, nav);
  } catch { /* ignore */ }
}

export function SettingsPanel({ onClose }: Props) {
  const [nav, setNav] = useState<NavKey>(loadSavedNav);

  const handleNav = (key: NavKey) => {
    setNav(key);
    saveNav(key);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
            <IconCloseHint />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置导航">
            {NAV_ITEMS.map(({ key, label, sectionBreak }) => (
              <Fragment key={key}>
                {sectionBreak && (
                  <>
                    <div className="nav-separator" />
                    <span className="nav-section-label">Pi 配置</span>
                  </>
                )}
                <NavItem nav={key} current={nav} onSelect={handleNav} label={label} />
              </Fragment>
            ))}
          </nav>
          <div className="settings-content">
            {renderNavContent(nav)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 常规 ────────────────────────────────────────────────────────────────────
const THEME_FAMILIES: { key: ThemeFamily; label: string; desc: string }[] = [
  { key: 'github', label: 'GitHub', desc: '经典 GitHub 蓝调' },
  { key: 'aurora', label: 'Aurora', desc: '冷蓝渐变 · 玻璃质感' },
  { key: 'mineral', label: 'Mineral', desc: '琥珀暖橙 · 矿物质感' },
];

function GeneralSettings() {
  const [theme, setLocal] = useState<Theme>(getTheme());
  const [themeFamily, setLocalFamily] = useState<ThemeFamily>(getThemeFamily());
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-to-tray');
  // 字体大小：本地 state 镜像全局 fontSize，步进按钮 / Ctrl+滚轮都走 setFontSize 通道。
  const [fontSize, setFontSizeLocal] = useState<number>(getFontSize());

  useEffect(() => {
    pi.getConfig().then((cfg) => setCloseBehavior(cfg.closeBehavior)).catch(() => {});
  }, []);

  // 订阅全局字号变化：Ctrl+滚轮在 App 层调整时，这里同步显示（保持面板数值实时）。
  useEffect(() => {
    return onFontSizeChange(setFontSizeLocal);
  }, []);

  const choose = (t: Theme) => {
    setTheme(t);
    setLocal(t);
  };

  const chooseFamily = (f: ThemeFamily) => {
    setThemeFamily(f);
    setLocalFamily(f);
  };

  const chooseClose = (b: CloseBehavior) => {
    setCloseBehavior(b);
    pi.setConfig({ closeBehavior: b }).catch(() => {});
  };

  const step = (delta: number) => {
    const atMin = fontSize <= FONT_SIZE_MIN && delta < 0;
    const atMax = fontSize >= FONT_SIZE_MAX && delta > 0;
    if (atMin || atMax) return; // 已在边界，避免无谓写盘
    setFontSizeLocal(bumpFontSize(delta));
  };

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">配色风格</span>
        <div className="segmented" role="radiogroup" aria-label="配色风格">
          {THEME_FAMILIES.map((f) => (
            <button
              key={f.key}
              type="button"
              role="radio"
              aria-checked={themeFamily === f.key}
              className={`seg${themeFamily === f.key ? ' active' : ''}`}
              onClick={() => chooseFamily(f.key)}
              title={f.desc}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label">主题</span>
        <div className="segmented" role="radiogroup" aria-label="主题">
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            className={`seg${theme === 'dark' ? ' active' : ''}`}
            onClick={() => choose('dark')}
          >
            深色
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            className={`seg${theme === 'light' ? ' active' : ''}`}
            onClick={() => choose('light')}
          >
            浅色
          </button>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label">关闭按钮行为</span>
        <div className="segmented" role="radiogroup" aria-label="关闭按钮行为">
          <button
            type="button"
            role="radio"
            aria-checked={closeBehavior === 'close'}
            className={`seg${closeBehavior === 'close' ? ' active' : ''}`}
            onClick={() => chooseClose('close')}
          >
            直接关闭
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={closeBehavior === 'minimize-to-tray'}
            className={`seg${closeBehavior === 'minimize-to-tray' ? ' active' : ''}`}
            onClick={() => chooseClose('minimize-to-tray')}
          >
            最小化到托盘
          </button>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label">字体大小</span>
        <div className="font-stepper" role="group" aria-label="字体大小">
          <button
            type="button"
            className="stepper-btn"
            aria-label="减小字体"
            disabled={fontSize <= FONT_SIZE_MIN}
            onClick={() => step(-1)}
          >
            −
          </button>
          <span className="stepper-value" aria-live="polite">{fontSize}px</span>
          <button
            type="button"
            className="stepper-btn"
            aria-label="增大字体"
            disabled={fontSize >= FONT_SIZE_MAX}
            onClick={() => step(1)}
          >
            +
          </button>
        </div>
      </div>
      <p className="settings-hint">提示：也可按住 Ctrl（macOS 为 Cmd）+ 滚轮快速调整字体大小。</p>
      <hr className="settings-divider" />
      <UpdateCheck />
    </>
  );
}

// ── 版本更新检查 ──────────────────────────────────────────────────────────────
function UpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{
    currentVersion: string;
    latestVersion: string | null;
    hasUpdate: boolean;
    releaseUrl: string | null;
    releaseName: string | null;
    releaseBody: string | null;
    checkedAt: string | null;
    error: string | null;
  } | null>(null);

  // 启动时获取当前版本和缓存检查结果
  const [currentVersion, setCurrentVersion] = useState<string>('');
  useEffect(() => {
    pi.getCurrentVersion().then(setCurrentVersion).catch(() => {});
    pi.getUpdateStatus().then(setResult).catch(() => {});
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setResult(null);
    try {
      // 手动点击 → 绕过主进程 TTL 缓存，强制重新请求，保证检查时间/结果实时刷新
      const info = await pi.checkUpdate(true);
      setResult(info);
    } catch (err) {
      setResult({
        currentVersion: '',
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        releaseName: null,
        releaseBody: null,
        checkedAt: null,
        error: err instanceof Error ? err.message : '检查更新失败',
      });
    } finally {
      setChecking(false);
    }
  };

  const openRelease = (url: string) => {
    pi.openExternal(url).catch(() => {});
  };

  return (
    <div className="update-check">
      <h3 className="update-check-title">版本更新</h3>
      <div className="settings-row">
        <span className="settings-label">当前版本</span>
        <span className="update-current-version">{currentVersion || (result?.currentVersion ?? '')}</span>
      </div>
      <div className="settings-row">
        <button
          type="button"
          className="btn"
          disabled={checking}
          onClick={handleCheck}
        >
          {checking ? '检查中…' : '检查更新'}
        </button>
      </div>

      {result && (
        <div className="update-result">
          {result.error ? (
            <p className="update-error">⚠ {result.error}</p>
          ) : result.hasUpdate ? (
            <div className="update-available">
              <p className="update-new-version">
                🎉 发现新版本：<strong>{result.latestVersion}</strong>
              </p>
              {result.releaseName && (
                <p className="update-release-name">{result.releaseName}</p>
              )}
              {result.releaseBody && (
                <pre className="update-release-body">{result.releaseBody}</pre>
              )}
              {result.releaseUrl && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => openRelease(result.releaseUrl!)}
                >
                  前往 GitHub 下载
                </button>
              )}
              <p className="settings-hint">点击按钮在浏览器打开 release 页面，下载安装包后运行即可升级。</p>
            </div>
          ) : (
            <p className="update-latest">✅ 已是最新版本</p>
          )}
          {result.checkedAt && (
            <p className="update-checked-at">
              检查时间：{new Date(result.checkedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── 会话管理 ──────────────────────────────────────────────────────────────────
type PendingDelete =
  | { kind: 'session'; key: string; name: string }
  | { kind: 'directory'; cwd: string; count: number }
  | { kind: 'batch'; keys: string[]; count: number };

function SessionManagement() {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<PendingDelete | null>(null);
  // 每个目录的折叠状态：默认收起（仅显示前 3 个会话），展开后显示全部。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [viewingContent, setViewingContent] = useState<{ key: string; name: string } | null>(null);

  const refresh = () => {
    pi.listSessions().then(setGroups).catch(() => setGroups([]));
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const enterSelect = () => { setSelectionMode(true); setSelected(new Set()); };
  const exitSelect = () => { setSelectionMode(false); setSelected(new Set()); };

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    setError(null);
    try {
      if (pending.kind === 'session') {
        await pi.deleteSession(pending.key);
      } else if (pending.kind === 'directory') {
        await pi.clearDirectory(pending.cwd);
      } else {
        await pi.deleteMany(pending.keys);
      }
      refresh();
      if (selectionMode) exitSelect();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const allKeys = groups.flatMap((g) => g.sessions.map((s) => s.key));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allKeys));
  };

  // 每个目录默认最多展示 3 个会话，超出部分折叠；点击“展开 N 个 / 收起”切换。
  const COLLAPSE_THRESHOLD = 3;
  const toggleExpand = (cwd: string) =>
    setExpanded((m) => ({ ...m, [cwd]: !m[cwd] }));

  return (
    <div className="session-mgmt">
      <div className="session-mgmt-toolbar">
        {selectionMode ? (
          <>
            <label className="select-all">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              <span>全选</span>
            </label>
            <span className="select-count">已选 {selected.size} 项</span>
            <button className="btn btn-danger" disabled={selected.size === 0} onClick={() => setConfirm({ kind: 'batch', keys: [...selected], count: selected.size })}>
              删除
            </button>
            <button className="btn" onClick={exitSelect}>取消</button>
          </>
        ) : (
          <button className="btn" onClick={enterSelect}>选择</button>
        )}
        {error && <span className="header-error">⚠ {error}</span>}
      </div>

      <div className="session-mgmt-list">
        {groups.length === 0 && <div className="empty-state">暂无会话。</div>}
        {groups.map((g) => {
          const total = g.sessions.length;
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.sessions : g.sessions.slice(0, COLLAPSE_THRESHOLD);
          const hidden = total - visible.length;
          return (
            <div key={g.cwd} className="group">
              <div className="group-title">
                <span className="group-name">
                  📁 {g.cwd} <span className="group-count">（会话数：{total}）</span>
                </span>
                <span className="group-actions">
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirm({ kind: 'directory', cwd: g.cwd, count: total })}
                  >
                    清空目录
                  </button>
                </span>
              </div>
              {visible.map((s) => {
                const isSelected = selected.has(s.key);
                return (
                  <div
                    key={s.key}
                    className={`session-item${selectionMode ? ' selectable' : ''}${isSelected ? ' selected' : ''}`}
                    onClick={selectionMode ? () => toggleSelect(s.key) : () => setViewingContent({ key: s.key, name: s.name })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (selectionMode) toggleSelect(s.key);
                        else setViewingContent({ key: s.key, name: s.name });
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={selectionMode ? `选择会话 ${s.name}` : `查看会话内容 ${s.name}`}
                  >
                    {selectionMode && (
                      <input
                        type="checkbox"
                        className="select-box"
                        checked={isSelected}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(s.key)}
                      />
                    )}
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {!selectionMode && (
                      <button className="icon-btn icon-danger session-delete" title={`删除会话 ${s.name}`} aria-label={`删除会话 ${s.name}`} onClick={() => setConfirm({ kind: 'session', key: s.key, name: s.name })}>
                        <IconTrash />
                      </button>
                    )}
                  </div>
                );
              })}
              {total > COLLAPSE_THRESHOLD && (
                <button
                  className="group-expand"
                  onClick={() => toggleExpand(g.cwd)}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'directory' ? '清空目录' : '删除会话'}
          message={
            confirm.kind === 'session'
              ? `确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`
              : confirm.kind === 'directory'
                ? `确定清空目录「${confirm.cwd}」下的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
                : `确定删除选中的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      {viewingContent && (
        <SessionContentDialog
          sessionKey={viewingContent.key}
          sessionName={viewingContent.name}
          onClose={() => setViewingContent(null)}
        />
      )}
    </div>
  );
}

// ── 常用等宽字体预设 ──
const FONT_PRESETS = [
  { label: 'JetBrains Mono', value: "'JetBrains Mono',ui-monospace,monospace" },
  { label: 'Fira Code', value: "'Fira Code',ui-monospace,monospace" },
  { label: 'Cascadia Code', value: "'Cascadia Code',ui-monospace,monospace" },
  { label: 'Cascadia Mono', value: "'Cascadia Mono',ui-monospace,monospace" },
  { label: 'Source Code Pro', value: "'Source Code Pro',ui-monospace,monospace" },
  { label: 'Consolas', value: 'Consolas,ui-monospace,monospace' },
  { label: 'Monaco', value: 'Monaco,ui-monospace,monospace' },
  { label: 'monospace', value: 'monospace' },
];

const FONT_WEIGHTS: { label: string; value: FontWeight }[] = [
  { label: '100 (Thin)', value: '100' },
  { label: '200 (Extra Light)', value: '200' },
  { label: '300 (Light)', value: '300' },
  { label: '400 / Normal', value: 'normal' },
  { label: '500 (Medium)', value: '500' },
  { label: '600 (Semi Bold)', value: '600' },
  { label: '700 / Bold', value: 'bold' },
  { label: '800 (Extra Bold)', value: '800' },
  { label: '900 (Black)', value: '900' },
];

// 辅助：广播配置变更到所有存活终端（不持久化，持久化由 useDebouncedSave 处理）。
function broadcastTerminalConfig(partial: Record<string, unknown>) {
  broadcastConfigUpdate(partial as any);
}

function TerminalSettings() {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [appWorkDir, setAppWorkDir] = useState('');
  const [scrollback, setScrollback] = useState<number>(5000);

  // 光标
  const [cursorBlink, setCursorBlink] = useState(true);
  const [cursorStyle, setCursorStyle] = useState<'block' | 'bar' | 'underline'>('bar');
  const [cursorInactiveStyle, setCursorInactiveStyle] = useState<'none' | 'outline' | 'block' | 'bar' | 'underline'>('outline');
  const [cursorWidth, setCursorWidth] = useState(1);

  // 字体
  const [fontFamily, setFontFamily] = useState("");
  const [lineHeight, setLineHeight] = useState(1.0);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [fontWeight, setFontWeight] = useState<FontWeight>('normal');
  const [fontWeightBold, setFontWeightBold] = useState<FontWeight>('bold');

  // 滚动
  const [smoothScrolling, setSmoothScrolling] = useState(false);
  const [scrollSensitivity, setScrollSensitivity] = useState(1);
  const [fastScrollSensitivity, setFastScrollSensitivity] = useState(5);

  // 滚动条
  const [scrollbarWidth, setScrollbarWidth] = useState(14);

  // 渲染
  const [customGlyphs, setCustomGlyphs] = useState(true);
  const [gpuAcceleration, setGpuAcceleration] = useState<'auto' | 'on' | 'off'>('auto');

  // 防抖自动保存：将所有终端配置项合并为一个对象，800ms 防抖后持久化
  const terminalConfig = {
    scrollback, cursorBlink, cursorStyle, cursorInactiveStyle, cursorWidth,
    fontFamily, lineHeight, letterSpacing, fontWeight, fontWeightBold,
    smoothScrolling, scrollSensitivity, fastScrollSensitivity, scrollbarWidth,
    customGlyphs, gpuAcceleration,
  };
  useDebouncedSave(terminalConfig, async (cfg) => {
    pi.setConfig(cfg as any).catch(() => {});
  }, { delay: 800, deepCompare: true });

  // 应用工作目录独立防抖自动保存
  useDebouncedSave(appWorkDir, async (dir) => {
    pi.setConfig({ appWorkDir: dir }).catch(() => {});
  }, { delay: 800 });

  useEffect(() => {
    pi.getConfig()
      .then((cfg) => {
        setDefaultId(cfg.defaultTerminalProfile);
        setAppWorkDir(cfg.appWorkDir ?? '');
        setScrollback(cfg.scrollback ?? 5000);
        setCursorBlink(cfg.cursorBlink ?? true);
        setCursorStyle(cfg.cursorStyle ?? 'bar');
        setCursorInactiveStyle(cfg.cursorInactiveStyle ?? 'outline');
        setCursorWidth(cfg.cursorWidth ?? 1);
        setFontFamily(cfg.fontFamily ?? "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace");
        setLineHeight(cfg.lineHeight ?? 1.0);
        setLetterSpacing(cfg.letterSpacing ?? 0);
        setFontWeight(cfg.fontWeight ?? 'normal');
        setFontWeightBold(cfg.fontWeightBold ?? 'bold');
        setSmoothScrolling(cfg.smoothScrolling ?? false);
        setScrollSensitivity(cfg.scrollSensitivity ?? 1);
        setFastScrollSensitivity(cfg.fastScrollSensitivity ?? 5);
        setScrollbarWidth(cfg.scrollbarWidth ?? 14);
        setCustomGlyphs(cfg.customGlyphs ?? true);
        setGpuAcceleration(cfg.gpuAcceleration ?? 'auto');
      })
      .catch(() => {});
    pi.listTerminalProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // 默认终端 profile 逻辑
  const selected = defaultId ?? '';

  const ensureCustom = (path: string, args: string[]) => {
    setProfiles((prev) => {
      const exists = prev.some((p) => p.id === 'custom');
      if (exists) return prev;
      return [
        ...prev,
        { id: 'custom', label: '自定义', path, args, platform: 'all', isCustom: true },
      ];
    });
  };

  const onSelect = (value: string) => {
    if (value === 'custom') {
      setDefaultId('custom');
      return;
    }
    setDefaultId(value);
    pi.setConfig({ defaultTerminalProfile: value }).catch(() => {});
  };

  const saveCustom = () => {
    if (!customPath.trim()) {
      setCustomError('请填写 shell 路径');
      return;
    }
    setCustomError(null);
    const args = customArgs.split(/\s+/).filter(Boolean);
    ensureCustom(customPath, args);
    setDefaultId('custom');
    pi.setConfig({
      defaultTerminalProfile: 'custom',
      terminalProfiles: { custom: { path: customPath, args } },
    }).catch(() => {});
  };

  return (
    <div className="terminal-settings">
      {/* ── 默认终端 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">默认终端</h3>
        <div className="settings-row">
          <span className="settings-label">默认终端</span>
          <select
            className="profile-select"
            aria-label="默认终端"
            value={selected}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="">（使用探测到的默认终端）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">其他（自定义路径）</option>
          </select>
        </div>

        {selected === 'custom' && (
          <div className="custom-terminal">
            <div className="settings-row">
              <span className="settings-label">shell 路径</span>
              <input
                type="text"
                className="custom-path-input"
                aria-label="shell 路径"
                placeholder={'C:\\Program Files\\Git\\bin\\bash.exe'}
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">启动参数</span>
              <input
                type="text"
                className="custom-args-input"
                aria-label="启动参数"
                placeholder="--login -i"
                value={customArgs}
                onChange={(e) => setCustomArgs(e.target.value)}
              />
            </div>
            {customError && <p className="settings-hint error">{customError}</p>}
            <button type="button" className="btn" onClick={saveCustom}>保存为默认</button>
          </div>
        )}
        <p className="settings-hint">提示：新建集成终端时会使用此处选择的默认终端。</p>
      </div>

      {/* ── 光标 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">光标</h3>

        <div className="settings-row">
          <span className="settings-label">光标闪烁</span>
          <label className="toggle-label">
            <input
              type="checkbox"
              className="toggle-input"
              checked={cursorBlink}
              onChange={(e) => {
                const v = e.target.checked;
                setCursorBlink(v);
                broadcastTerminalConfig({ cursorBlink: v });
              }}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>

        <div className="settings-row">
          <span className="settings-label">光标样式</span>
          <select
            className="profile-select"
            aria-label="光标样式"
            value={cursorStyle}
            onChange={(e) => {
              const v = e.target.value as 'block' | 'bar' | 'underline';
              setCursorStyle(v);
              broadcastTerminalConfig({ cursorStyle: v });
            }}
          >
            <option value="block">Block (█)</option>
            <option value="bar">Bar (|)</option>
            <option value="underline">Underline (_)</option>
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-label">非活跃光标样式</span>
          <select
            className="profile-select"
            aria-label="非活跃光标样式"
            value={cursorInactiveStyle}
            onChange={(e) => {
              const v = e.target.value as 'none' | 'outline' | 'block' | 'bar' | 'underline';
              setCursorInactiveStyle(v);
              broadcastTerminalConfig({ cursorInactiveStyle: v });
            }}
          >
            <option value="none">无</option>
            <option value="outline">轮廓</option>
            <option value="block">方块</option>
            <option value="bar">竖线</option>
            <option value="underline">下划线</option>
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-label">光标宽度</span>
          <div className="input-unit-group">
            <input
              type="number"
              className="num-input"
              aria-label="光标宽度"
              min={1}
              max={25}
              step={1}
              value={cursorWidth}
              onChange={(e) => {
                const v = Math.min(25, Math.max(1, Number(e.target.value)));
                setCursorWidth(v);
              }}
              onBlur={() => {
                const clamped = Math.min(25, Math.max(1, Math.round(cursorWidth)));
                setCursorWidth(clamped);
                broadcastTerminalConfig({ cursorWidth: clamped });
              }}
            />
            <span className="settings-unit">px</span>
          </div>
        </div>
        <p className="settings-hint">范围 1–25，仅光标样式为 Bar 时可见。</p>
      </div>

      {/* ── 字体 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">字体</h3>

        <div className="settings-row">
          <span className="settings-label">字体系列</span>
          <div className="font-family-group">
            <input
              type="text"
              className="font-family-input"
              aria-label="字体系列"
              placeholder="'JetBrains Mono',ui-monospace,monospace"
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              onBlur={() => {
                if (fontFamily.trim()) {
                  broadcastTerminalConfig({ fontFamily: fontFamily.trim() });
                }
              }}
            />
            <select
              className="font-preset-select"
              aria-label="字体预设"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  setFontFamily(v);
                  broadcastTerminalConfig({ fontFamily: v });
                }
              }}
            >
              <option value="" disabled>预设字体</option>
              {FONT_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">行高</span>
          <input
            type="number"
            className="num-input"
            aria-label="行高"
            min={0.5}
            max={3.0}
            step={0.1}
            value={lineHeight}
            onChange={(e) => {
              const v = Math.min(3.0, Math.max(0.5, Number(e.target.value)));
              setLineHeight(v);
            }}
            onBlur={() => {
              const clamped = Math.min(3.0, Math.max(0.5, Math.round(lineHeight * 10) / 10));
              setLineHeight(clamped);
              broadcastTerminalConfig({ lineHeight: clamped });
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">字间距</span>
          <div className="input-unit-group">
            <input
              type="number"
              className="num-input"
              aria-label="字间距"
              min={-5}
              max={20}
              step={1}
              value={letterSpacing}
              onChange={(e) => {
                const v = Math.min(20, Math.max(-5, Number(e.target.value)));
                setLetterSpacing(v);
              }}
              onBlur={() => {
                const clamped = Math.min(20, Math.max(-5, Math.round(letterSpacing)));
                setLetterSpacing(clamped);
                broadcastTerminalConfig({ letterSpacing: clamped });
              }}
            />
            <span className="settings-unit">px</span>
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-label">常规字重</span>
          <select
            className="profile-select"
            aria-label="常规字重"
            value={fontWeight}
            onChange={(e) => {
              const v = e.target.value as FontWeight;
              setFontWeight(v);
              broadcastTerminalConfig({ fontWeight: v });
            }}
          >
            {FONT_WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <span className="settings-label">粗体字重</span>
          <select
            className="profile-select"
            aria-label="粗体字重"
            value={fontWeightBold}
            onChange={(e) => {
              const v = e.target.value as FontWeight;
              setFontWeightBold(v);
              broadcastTerminalConfig({ fontWeightBold: v });
            }}
          >
            {FONT_WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </div>
        <p className="settings-hint">字号已在「常规」设置中调整，此处配置终端专属字体选项。</p>
      </div>

      {/* ── 滚动 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">滚动</h3>

        <div className="settings-row">
          <span className="settings-label">滚动缓冲区</span>
          <div className="input-unit-group">
            <input
              type="number"
              className="num-input"
              style={{ width: 100 }}
              aria-label="滚动缓冲区行数"
              min={1000}
              max={100000}
              step={1000}
              value={scrollback}
              onChange={(e) => setScrollback(Number(e.target.value))}
              onBlur={() => {
                const clamped = Math.min(100000, Math.max(1000, Math.round(scrollback)));
                setScrollback(clamped);
              }}
            />
            <span className="settings-unit">行</span>
          </div>
        </div>
        <p className="settings-hint">范围 1000–100000，修改后只影响之后新建的终端。</p>

        <div className="settings-row">
          <span className="settings-label">平滑滚动</span>
          <label className="toggle-label">
            <input
              type="checkbox"
              className="toggle-input"
              checked={smoothScrolling}
              onChange={(e) => {
                const v = e.target.checked;
                setSmoothScrolling(v);
                broadcastTerminalConfig({ smoothScrolling: v, isPhysicalMouseWheel: true });
              }}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>

        <div className="settings-row">
          <span className="settings-label">滚动灵敏度</span>
          <input
            type="number"
            className="num-input"
            aria-label="滚动灵敏度"
            min={0.1}
            max={20}
            step={0.5}
            value={scrollSensitivity}
            onChange={(e) => {
              const v = Math.min(20, Math.max(0.1, Number(e.target.value)));
              setScrollSensitivity(v);
            }}
            onBlur={() => {
              const clamped = Math.min(20, Math.max(0.1, Math.round(scrollSensitivity * 10) / 10));
              setScrollSensitivity(clamped);
              broadcastTerminalConfig({ scrollSensitivity: clamped });
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-label">快速滚动速度</span>
          <input
            type="number"
            className="num-input"
            aria-label="快速滚动速度"
            min={1}
            max={100}
            step={1}
            value={fastScrollSensitivity}
            onChange={(e) => {
              const v = Math.min(100, Math.max(1, Number(e.target.value)));
              setFastScrollSensitivity(v);
            }}
            onBlur={() => {
              const clamped = Math.min(100, Math.max(1, Math.round(fastScrollSensitivity)));
              setFastScrollSensitivity(clamped);
              broadcastTerminalConfig({ fastScrollSensitivity: clamped });
            }}
          />
        </div>
      </div>

      {/* ── 滚动条 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">滚动条</h3>

        <div className="settings-row">
          <span className="settings-label">滚动条宽度</span>
          <div className="input-unit-group">
            <input
              type="number"
              className="num-input"
              aria-label="滚动条宽度"
              min={6}
              max={40}
              step={1}
              value={scrollbarWidth}
              onChange={(e) => {
                const v = Math.min(40, Math.max(6, Number(e.target.value)));
                setScrollbarWidth(v);
              }}
              onBlur={() => {
                const clamped = Math.min(40, Math.max(6, Math.round(scrollbarWidth)));
                setScrollbarWidth(clamped);
                broadcastTerminalConfig({ scrollbarWidth: clamped });
              }}
            />
            <span className="settings-unit">px</span>
          </div>
        </div>
        <p className="settings-hint">范围 6–40，全屏 TUI 下 CSS 已隐藏滚动条，此值影响 xterm 内部布局计算。</p>
      </div>

      {/* ── 渲染 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">渲染</h3>

        <div className="settings-row">
          <span className="settings-label">自定义字形</span>
          <label className="toggle-label">
            <input
              type="checkbox"
              className="toggle-input"
              aria-label="自定义字形"
              checked={customGlyphs}
              onChange={(e) => {
                const v = e.target.checked;
                setCustomGlyphs(v);
                broadcastTerminalConfig({ customGlyphs: v });
              }}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>
        <p className="settings-hint">为 Box Drawing、Block Elements、Powerline 等 Unicode 范围绘制自定义字形，而非使用字体（对齐 VS Code Custom Glyphs）。</p>

        <div className="settings-row">
          <span className="settings-label">GPU 加速</span>
          <select
            className="profile-select"
            aria-label="GPU 加速"
            value={gpuAcceleration}
            onChange={(e) => {
              const v = e.target.value as 'auto' | 'on' | 'off';
              setGpuAcceleration(v);
              broadcastTerminalConfig({ gpuAcceleration: v });
            }}
          >
            <option value="auto">自动（auto）</option>
            <option value="on">开启（on）</option>
            <option value="off">关闭（off）</option>
          </select>
        </div>
        <p className="settings-hint">auto 自动探测 WebGL；on 强制开启 GPU 渲染；off 强制使用 DOM 渲染器（对齐 VS Code Gpu Acceleration）。</p>
      </div>

      {/* ── 应用工作目录 ── */}
      <div className="settings-section">
        <h3 className="settings-section-title">工作目录</h3>
        <div className="settings-row">
          <span className="settings-label">应用工作目录</span>
          <div className="app-work-dir">
            <input
              type="text"
              className="app-work-dir-input"
              aria-label="应用工作目录"
              placeholder={'~/piDesktop'}
              value={appWorkDir}
              onChange={(e) => setAppWorkDir(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const dir = await pi.pickDirectory();
                if (dir) setAppWorkDir(dir);
              }}
            >
              浏览…
            </button>

          </div>
        </div>
        <p className="settings-hint">用于收容与具体项目无关、与 pi-agent 闲聊或临时的集成终端。修改后只影响之后新建的终端。</p>
      </div>
    </div>
  );
}

// Small inline ✕ so the panel doesn't depend on the window-control icon set.
function IconCloseHint() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
