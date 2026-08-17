import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { PI_DESKTOP_SYNC_FILE } from '../pi-desktop-sync-source';

/**
 * Pi 工具配置相关 IPC handler 注册。
 *
 * 管理 settings、models、MCP、skills、extensions 的读写。
 */
export function registerPiToolHandlers(
  ipcMain: Electron.IpcMain,
  win: Electron.BrowserWindow,
  piAgentDir: string,
): void {
  /** 深度合并 source 到 target（仅对象，数组直接替换） */
  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = result[key];
      if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
          tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
        result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
      } else {
        result[key] = sv;
      }
    }
    return result;
  }

  // ── Settings ──
  ipcMain.handle('pi:settings:get', (_e, scope: 'global' | 'project') => {
    const settingsPath = scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const exists = fs.existsSync(settingsPath);
    let data: unknown = null;
    let raw = '';
    if (exists) {
      raw = fs.readFileSync(settingsPath, 'utf-8');
      try { data = JSON.parse(raw); } catch { /* 不合法 JSON 也能编辑 */ }
    }
    return { data, raw, path: settingsPath, exists };
  });

  ipcMain.handle('pi:settings:set', (_e, payload: { scope: 'global' | 'project'; data?: Record<string, unknown>; raw?: string }) => {
    const settingsPath = payload.scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (payload.raw !== undefined) {
      fs.writeFileSync(settingsPath, payload.raw, 'utf-8');
    } else if (payload.data !== undefined) {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* 忽略损坏的现有文件 */ }
      }
      const merged = deepMerge(existing, payload.data);
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    }
    return { success: true, path: settingsPath };
  });

  // ── Models ──
  const modelsPath = path.join(piAgentDir, 'models.json');

  ipcMain.handle('pi:models:get', () => {
    if (fs.existsSync(modelsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
        return data;
      } catch { /* fall through */ }
    }
    return { providers: {} };
  });

  ipcMain.handle('pi:models:set', (_e, data: unknown) => {
    if (!fs.existsSync(piAgentDir)) fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  });

  // ── MCP ──
  ipcMain.handle('pi:mcp:configs', () => {
    const cwd = process.cwd();
    const home = os.homedir();
    const files = [
      { id: 'user-global', label: '用户全局配置 (Shared)', path: path.join(home, '.config', 'mcp', 'mcp.json') },
      { id: 'pi-global', label: 'Pi 全局覆盖 (Pi Agent)', path: path.join(piAgentDir, 'mcp.json') },
      { id: 'project-shared', label: '项目共享 (Project)', path: path.join(cwd, '.mcp.json') },
      { id: 'project-pi', label: 'Pi 项目覆盖 (Project Pi)', path: path.join(cwd, '.pi', 'mcp.json') },
    ];
    return files.map(f => {
      const exists = fs.existsSync(f.path);
      let config: unknown = null;
      if (exists) {
        try { config = JSON.parse(fs.readFileSync(f.path, 'utf-8')); } catch { /* empty */ }
      }
      return { ...f, exists, config };
    });
  });

  ipcMain.handle('pi:mcp:configs:save', (_e, payload: { id: string; config: unknown }) => {
    const home = os.homedir();
    const cwd = process.cwd();
    const fileDefs: Record<string, string> = {
      'user-global': path.join(home, '.config', 'mcp', 'mcp.json'),
      'pi-global': path.join(piAgentDir, 'mcp.json'),
      'project-shared': path.join(cwd, '.mcp.json'),
      'project-pi': path.join(cwd, '.pi', 'mcp.json'),
    };
    const filePath = fileDefs[payload.id];
    if (!filePath) throw new Error('Unknown MCP config: ' + payload.id);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload.config, null, 2), 'utf-8');
    return { success: true, path: filePath };
  });

  ipcMain.handle('pi:mcp:status', () => {
    const locations = [
      path.join(piAgentDir, 'npm', 'node_modules', 'pi-mcp-adapter', 'package.json'),
      path.join(piAgentDir, 'node_modules', 'pi-mcp-adapter', 'package.json'),
    ];
    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(loc, 'utf-8'));
          return { installed: true, version: pkg.version };
        } catch { /* ignore */ }
      }
    }
    return { installed: false };
  });

  // ── Skills ──
  const SKILL_ROOTS = [
    path.join(piAgentDir, 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];

  function readSkillDescription(skillDir: string): string | undefined {
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf-8');
      const match = content.match(/description:\s*"([^"]+)"|description:\s*([^\r\n]+)/);
      return match?.[1] || match?.[2]?.trim() || undefined;
    }
    return undefined;
  }

  function findSkillRoot(name: string): { root: string; disabled: boolean } | null {
    for (const root of SKILL_ROOTS) {
      const normal = path.join(root, name);
      if (fs.existsSync(normal) && fs.statSync(normal).isDirectory()) {
        return { root, disabled: false };
      }
      const disabled = path.join(root, '.disabled', name);
      if (fs.existsSync(disabled) && fs.statSync(disabled).isDirectory()) {
        return { root, disabled: true };
      }
    }
    return null;
  }

  interface SkillInfo {
    name: string;
    disabled: boolean;
    description?: string;
    source: string | null;
    sourceUrl: string | null;
    sourceType: string | null;
  }

  function listSkills(): SkillInfo[] {
    const state = readPiToolState();
    const sourceCache: Record<string, { source: string; sourceUrl: string; sourceType: string }> =
      (state.skillSourceCache as any) || {};

    const result: SkillInfo[] = [];
    const seenNames = new Set<string>();

    for (const root of SKILL_ROOTS) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const skillDir = path.join(root, entry.name);
          const description = readSkillDescription(skillDir);
          const cached = sourceCache[entry.name];
          result.push({
            name: entry.name,
            disabled: false,
            description,
            source: cached?.source ?? null,
            sourceUrl: cached?.sourceUrl ?? null,
            sourceType: cached?.sourceType ?? null,
          });
          seenNames.add(entry.name);
        }
      }
    }

    for (const root of SKILL_ROOTS) {
      const disabledDir = path.join(root, '.disabled');
      if (!fs.existsSync(disabledDir)) continue;
      for (const entry of fs.readdirSync(disabledDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !seenNames.has(entry.name)) {
          const skillDir = path.join(disabledDir, entry.name);
          const description = readSkillDescription(skillDir);
          const cached = sourceCache[entry.name];
          result.push({
            name: entry.name,
            disabled: true,
            description,
            source: cached?.source ?? null,
            sourceUrl: cached?.sourceUrl ?? null,
            sourceType: cached?.sourceType ?? null,
          });
          seenNames.add(entry.name);
        }
      }
    }
    return result;
  }

  function refreshSkillSourceCache(): void {
    try {
      const output = execSync('npx skills ls -g --json', {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      const npxResults: any[] = JSON.parse(output);
      const cache: Record<string, { source: string; sourceUrl: string; sourceType: string }> = {};
      for (const skill of npxResults) {
        if (skill.source) {
          cache[skill.name] = {
            source: skill.source,
            sourceUrl: skill.sourceUrl || '',
            sourceType: skill.sourceType || '',
          };
        }
      }
      const state = readPiToolState();
      state.skillSourceCache = cache;
      writePiToolState(state);
    } catch {
      // npx skills 不可用时跳过
    }
  }

  ipcMain.handle('pi:skills:list', () => ({ skills: listSkills() }));

  ipcMain.handle('pi:skills:refreshCache', () => {
    refreshSkillSourceCache();
    return { skills: listSkills() };
  });

  ipcMain.handle('pi:skills:disable', (_e, payload: { name: string; source?: string | null }) => {
    const found = findSkillRoot(payload.name);
    if (!found || found.disabled) return { success: false, error: 'Skill not found or already disabled' };
    const src = path.join(found.root, payload.name);
    const dst = path.join(found.root, '.disabled', payload.name);
    const disabledDir = path.join(found.root, '.disabled');
    if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(src, dst);
    if (payload.source) {
      try {
        const state = readPiToolState();
        if (!state.disabledSkills) state.disabledSkills = {};
        (state.disabledSkills as Record<string, string>)[payload.name] = payload.source;
        writePiToolState(state);
      } catch { /* ignore */ }
    }
    return { success: true };
  });

  ipcMain.handle('pi:skills:enable', (_e, name: string) => {
    const found = findSkillRoot(name);
    if (!found || !found.disabled) return { success: false, error: 'Disabled skill not found' };
    const src = path.join(found.root, '.disabled', name);
    const dst = path.join(found.root, name);
    fs.renameSync(src, dst);
    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        delete (state.disabledSkills as Record<string, string>)[name];
        writePiToolState(state);
      }
    } catch { /* ignore */ }
    return { success: true };
  });

  ipcMain.handle('pi:skills:delete', async (_e, payload: { name: string; disabled?: boolean }) => {
    if (!payload.disabled) {
      try {
        execSync(`npx skills remove "${payload.name}" -g -y`, {
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
        });
      } catch {
        // npx skills remove 失败，fallback 到文件系统
      }
    }

    let deleted = false;
    for (const root of SKILL_ROOTS) {
      const normal = path.join(root, payload.name);
      if (fs.existsSync(normal)) {
        fs.rmSync(normal, { recursive: true, force: true });
        deleted = true;
      }
      const disabled = path.join(root, '.disabled', payload.name);
      if (fs.existsSync(disabled)) {
        fs.rmSync(disabled, { recursive: true, force: true });
        deleted = true;
      }
    }

    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        delete (state.disabledSkills as Record<string, string>)[payload.name];
        writePiToolState(state);
      }
    } catch { /* ignore */ }

    return { success: deleted, error: deleted ? undefined : 'Skill not found' };
  });

  ipcMain.handle('pi:skills:batchDisable', (_e, payload: { names: string[]; source?: string | null }) => {
    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const name of payload.names) {
      const found = findSkillRoot(name);
      if (!found || found.disabled) {
        results.push({ name, success: false, error: 'Skill not found or already disabled' });
        continue;
      }
      const src = path.join(found.root, name);
      const dst = path.join(found.root, '.disabled', name);
      const disabledDir = path.join(found.root, '.disabled');
      try {
        if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true });
        fs.renameSync(src, dst);
        results.push({ name, success: true });
      } catch (err) {
        results.push({ name, success: false, error: String(err) });
      }
    }
    if (payload.source) {
      try {
        const state = readPiToolState();
        if (!state.disabledSkills) state.disabledSkills = {};
        for (const r of results) {
          if (r.success) {
            (state.disabledSkills as Record<string, string>)[r.name] = payload.source;
          }
        }
        writePiToolState(state);
      } catch { /* ignore */ }
    }
    return { results };
  });

  ipcMain.handle('pi:skills:batchDelete', async (_e, payload: { names: string[] }) => {
    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const name of payload.names) {
      try {
        try {
          execSync(`npx skills remove "${name}" -g -y`, {
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: true,
          });
        } catch { /* fallback */ }

        let deleted = false;
        for (const root of SKILL_ROOTS) {
          const normal = path.join(root, name);
          if (fs.existsSync(normal)) {
            fs.rmSync(normal, { recursive: true, force: true });
            deleted = true;
          }
          const disabled = path.join(root, '.disabled', name);
          if (fs.existsSync(disabled)) {
            fs.rmSync(disabled, { recursive: true, force: true });
            deleted = true;
          }
        }
        results.push({ name, success: deleted });
      } catch (err) {
        results.push({ name, success: false, error: String(err) });
      }
    }
    try {
      const state = readPiToolState();
      if (state.disabledSkills && typeof state.disabledSkills === 'object') {
        for (const r of results) {
          if (r.success) {
            delete (state.disabledSkills as Record<string, string>)[r.name];
          }
        }
        writePiToolState(state);
      }
    } catch { /* ignore */ }
    return { results };
  });

  // ── Extensions ──
  // pi 扩展自动发现位置（见 pi extensions 文档）：
  //   全局：~/.pi/agent/extensions/*.ts | */index.ts
  //   项目：.pi/extensions/*.ts | */index.ts
  // 禁用态：移入同根目录下的 .disabled/ 子目录。启用优先于禁用（同名去重）。
  const extDir = path.join(piAgentDir, 'extensions');
  const disabledExtDir = path.join(piAgentDir, 'extensions', '.disabled');
  const projectExtDir = path.join(process.cwd(), '.pi', 'extensions');
  const projectDisabledExtDir = path.join(process.cwd(), '.pi', 'extensions', '.disabled');

  /** 所有合法的「本地扩展」目录（已 resolve，便于直接做前缀比较）。用于路径边界校验。 */
  const EXT_LOCAL_DIRS = [extDir, disabledExtDir, projectExtDir, projectDisabledExtDir].map((p) => path.resolve(p));

  type ExtItem = { name: string; type: string; source: string; disabled: boolean; managed: boolean; dir?: string };

  /** 判断 dir 是否落在合法的本地扩展目录内，防止 payload.dir 穿越到任意路径。 */
  function isInsideLocalExtDir(dir: string): boolean {
    const norm = path.resolve(dir);
    return EXT_LOCAL_DIRS.some((base) => norm === base || norm.startsWith(base + path.sep));
  }

  /** 校验 name 是单层目录/文件名（不含分隔符、.、..），避免 path.join 后穿越。 */
  function isSafeLocalName(name: string): boolean {
    if (!name || name.startsWith('.')) return false;
    if (name.includes('/') || name.includes('\\')) return false;
    if (name.includes('..')) return false;
    return true;
  }

  function getPackageSourceString(pkg: unknown): string {
    if (typeof pkg === 'string') return pkg;
    if (pkg && typeof pkg === 'object') {
      const s = (pkg as Record<string, unknown>).source;
      return typeof s === 'string' ? s : '';
    }
    return '';
  }

  function getPackageDisplayName(source: string): string {
    if (source.startsWith('npm:')) return source.slice(4);
    if (source.startsWith('git:')) {
      const parts = source.split('/');
      return parts[parts.length - 1] || source;
    }
    return path.basename(source.replace(/\\/g, '/'));
  }

  function readSettingsPackages(settingPath: string): { packages: unknown[]; extensions: string[] } {
    if (!fs.existsSync(settingPath)) return { packages: [], extensions: [] };
    try {
      const data = JSON.parse(fs.readFileSync(settingPath, 'utf-8'));
      return {
        packages: Array.isArray(data.packages) ? data.packages : [],
        extensions: Array.isArray(data.extensions) ? data.extensions : [],
      };
    } catch {
      return { packages: [], extensions: [] };
    }
  }

  /** 扫描一个本地扩展目录（启用或禁用），合并入 result 并登记 seen。 */
  function scanLocalDir(dir: string, disabled: boolean, seenNames: Set<string>, result: ExtItem[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;            // 跳过 .disabled 等隐藏项
      if (!(entry.isDirectory() || entry.isFile())) continue;
      if (seenNames.has(entry.name)) continue;             // 同名去重（启用目录先扫，优先）
      const full = path.join(dir, entry.name);
      const isPiDesktop = entry.name === PI_DESKTOP_SYNC_FILE;
      result.push({
        name: entry.name,
        type: 'local',
        source: full,
        disabled,
        // pi-desktop-sync 为系统内置同步扩展，界面不可禁用/删除（禁用会在下次启动被重写）。
        managed: !isPiDesktop,
        dir: full,
      });
      seenNames.add(entry.name);
    }
  }

  ipcMain.handle('pi:extensions:list', () => {
    const result: ExtItem[] = [];
    const seenNames = new Set<string>();

    // 本地扩展：先扫启用目录、再扫禁用目录（同名以启用为准）。
    scanLocalDir(extDir, false, seenNames, result);
    scanLocalDir(projectExtDir, false, seenNames, result);
    scanLocalDir(disabledExtDir, true, seenNames, result);
    scanLocalDir(projectDisabledExtDir, true, seenNames, result);

    // settings.json 的 packages 与 extensions 字段。
    const globalSettingsPath = path.join(piAgentDir, 'settings.json');
    const projectSettingsPath = path.join(process.cwd(), '.pi', 'settings.json');
    const globalPkgs = readSettingsPackages(globalSettingsPath);
    const projectPkgs = readSettingsPackages(projectSettingsPath);
    const state = readPiToolState();
    const disabledPackages: string[] = (state.disabledExtensions as string[]) || [];

    // packages：npm:/git:/本地路径形式的包安装。
    const seenPkgSources = new Set<string>();
    for (const pkg of [...globalPkgs.packages, ...projectPkgs.packages]) {
      const source = getPackageSourceString(pkg);
      if (!source || seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: disabledPackages.includes(source), managed: true });
    }
    // 仅记录在 disabledExtensions 中的孤儿包（已禁用、已从 settings 移除）。
    for (const source of disabledPackages) {
      if (seenPkgSources.has(source)) continue;
      seenPkgSources.add(source);
      result.push({ name: getPackageDisplayName(source), type: 'package', source, disabled: true, managed: true });
    }

    // extensions：settings.json 中的直接路径扩展（只读展示，不在界面增删）。
    const seenExtPaths = new Set<string>();
    for (const extPath of [...globalPkgs.extensions, ...projectPkgs.extensions]) {
      if (typeof extPath !== 'string' || !extPath || seenExtPaths.has(extPath)) continue;
      seenExtPaths.add(extPath);
      result.push({
        name: path.basename(extPath.replace(/\\/g, '/')),
        type: 'path',
        source: extPath,
        disabled: false,
        managed: false,
      });
    }

    return { extensions: result };
  });

  ipcMain.handle('pi:extensions:disable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      if (!isSafeLocalName(payload.name)) return { success: false, error: 'Invalid extension name' };
      if (!isInsideLocalExtDir(src)) return { success: false, error: 'Invalid extension path' };
      if (payload.name === PI_DESKTOP_SYNC_FILE) return { success: false, error: 'Cannot disable built-in extension' };
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      const disabledDir = path.join(path.dirname(src), '.disabled');
      const dst = path.join(disabledDir, payload.name);
      try {
        // mkdirSync(recursive) 对已存在的目录是 no-op，无需先 existsSync 判空。
        fs.mkdirSync(disabledDir, { recursive: true });
        // 目标已存在（重复禁用残留）：先清理旧副本再移动，避免 rename 抛 EEXIST 崩溃。
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.renameSync(src, dst);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    if (payload.type === 'package') {
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      if (changed) {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        if (!list.includes(payload.source)) {
          list.push(payload.source);
          st.disabledExtensions = list;
          writePiToolState(st);
        }
      }
      return { success: changed, error: changed ? undefined : 'Package not found in settings' };
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:enable', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      const src = payload.dir;
      if (!isSafeLocalName(payload.name)) return { success: false, error: 'Invalid extension name' };
      if (!isInsideLocalExtDir(src)) return { success: false, error: 'Invalid extension path' };
      if (!fs.existsSync(src)) return { success: false, error: 'Extension not found' };
      // src 在 <root>/.disabled/<name>，启用目标是 <root>/<name>。
      const enabledRoot = path.join(path.dirname(src), '..');
      const dst = path.join(enabledRoot, payload.name);
      try {
        if (fs.existsSync(dst)) {
          // 启用目录已有同名（如 pi-desktop-sync 被启动覆盖写回）。此时禁用副本是残留，删除即可。
          fs.rmSync(src, { recursive: true, force: true });
          return { success: true };
        }
        fs.renameSync(src, dst);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    if (payload.type === 'package') {
      const st = readPiToolState();
      const list: string[] = (st.disabledExtensions as string[]) || [];
      const idx = list.indexOf(payload.source);
      if (idx === -1) return { success: false, error: 'Extension not found in disabled list' };
      list.splice(idx, 1);
      st.disabledExtensions = list;
      writePiToolState(st);
      const globalSettingsPath = path.join(piAgentDir, 'settings.json');
      try {
        const settings = fs.existsSync(globalSettingsPath)
          ? JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'))
          : {};
        if (!Array.isArray(settings.packages)) settings.packages = [];
        // 用 getPackageSourceString 统一判断，兼容 packages 为对象形式（{ source: '...' }）的情况，
        // 避免 includes(payload.source) 只匹配纯字符串而导致重复添加字符串条目。
        const exists = settings.packages.some((p: unknown) => getPackageSourceString(p) === payload.source);
        if (!exists) {
          settings.packages.push(payload.source);
          const dir = path.dirname(globalSettingsPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        }
        return { success: true };
      } catch {
        return { success: false, error: 'Failed to write settings' };
      }
    }
    return { success: false, error: 'Unsupported extension type' };
  });

  ipcMain.handle('pi:extensions:delete', (_e, payload: { name: string; type: string; source: string; dir?: string }) => {
    if (payload.type === 'local' && payload.dir) {
      if (!isSafeLocalName(payload.name)) return { success: false, error: 'Invalid extension name' };
      if (!isInsideLocalExtDir(payload.dir)) return { success: false, error: 'Invalid extension path' };
      if (payload.name === PI_DESKTOP_SYNC_FILE) return { success: false, error: 'Cannot delete built-in extension' };
      if (!fs.existsSync(payload.dir)) return { success: false, error: 'Extension not found' };
      try {
        fs.rmSync(payload.dir, { recursive: true, force: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    if (payload.type === 'package') {
      const settingsPaths = [path.join(piAgentDir, 'settings.json'), path.join(process.cwd(), '.pi', 'settings.json')];
      let changed = false;
      for (const sp of settingsPaths) {
        if (fs.existsSync(sp)) {
          try {
            const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            if (Array.isArray(settings.packages)) {
              const before = settings.packages.length;
              settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== payload.source);
              if (settings.packages.length !== before) {
                changed = true;
                fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              }
            }
          } catch { /* empty */ }
        }
      }
      // 无论是否从 settings 移除，都清理 disabledExtensions 中的残留记录，
      // 否则「仅禁用未启用」的包会永远删不掉、记录残留。
      let stateChanged = false;
      try {
        const st = readPiToolState();
        const list: string[] = (st.disabledExtensions as string[]) || [];
        const idx = list.indexOf(payload.source);
        if (idx !== -1) {
          list.splice(idx, 1);
          st.disabledExtensions = list;
          writePiToolState(st);
          stateChanged = true;
        }
      } catch { /* ignore */ }
      const ok = changed || stateChanged;
      return { success: ok, error: ok ? undefined : 'Package not found' };
    }
    return { success: false, error: 'Unsupported extension type' };
  });
}

/** 读取 Pi 工具状态缓存文件。 */
function readPiToolState(): Record<string, unknown> {
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const statePath = path.join(piAgentDir, 'pi-tool-state.json');
  if (fs.existsSync(statePath)) {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { /* empty */ }
  }
  return {};
}

/** 写入 Pi 工具状态缓存文件。 */
function writePiToolState(state: Record<string, unknown>): void {
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  fs.writeFileSync(path.join(piAgentDir, 'pi-tool-state.json'), JSON.stringify(state, null, 2), 'utf-8');
}