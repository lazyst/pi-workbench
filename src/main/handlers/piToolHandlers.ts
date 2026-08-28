import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { PI_WORKBENCH_SYNC_FILE } from '../pi-workbench-sync-source';

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

  /** 根据 scope 返回 settings.json 的完整路径。 */
  function settingsPathFor(scope: 'global' | 'project'): string {
    return scope === 'project'
      ? path.join(process.cwd(), '.pi', 'settings.json')
      : path.join(piAgentDir, 'settings.json');
  }

  /** 四层 MCP 配置文件的路径定义。 */
  function getMcpConfigFiles(): Array<{ id: string; label: string; path: string }> {
    const cwd = process.cwd();
    const home = os.homedir();
    return [
      { id: 'user-global', label: '用户全局配置 (Shared)', path: path.join(home, '.config', 'mcp', 'mcp.json') },
      { id: 'pi-global', label: 'Pi 全局覆盖 (Pi Agent)', path: path.join(piAgentDir, 'mcp.json') },
      { id: 'project-shared', label: '项目共享 (Project)', path: path.join(cwd, '.mcp.json') },
      { id: 'project-pi', label: 'Pi 项目覆盖 (Project Pi)', path: path.join(cwd, '.pi', 'mcp.json') },
    ];
  }

  // ── Settings ──
  ipcMain.handle('pi:settings:get', (_e, scope: 'global' | 'project') => {
    const settingsPath = settingsPathFor(scope);
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
    const settingsPath = settingsPathFor(payload.scope);
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
    return getMcpConfigFiles().map(f => {
      const exists = fs.existsSync(f.path);
      let config: unknown = null;
      if (exists) {
        try { config = JSON.parse(fs.readFileSync(f.path, 'utf-8')); } catch { /* empty */ }
      }
      return { ...f, exists, config };
    });
  });

  ipcMain.handle('pi:mcp:configs:save', (_e, payload: { id: string; config: unknown }) => {
    const files = getMcpConfigFiles();
    const filePath = files.find(f => f.id === payload.id)?.path;
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

  /** 从 lockfile 读取到的 skill 来源元数据。 */
  type SkillSourceInfo = { source: string; sourceUrl: string; sourceType: string };

  /**
   * skills CLI（npm 包 `skills`）维护的全局 lockfile 路径。
   * 与 skills CLI 的 getSkillLockPath() 规则一致：
   *   $XDG_STATE_HOME/skills/.skill-lock.json  或  ~/.agents/.skill-lock.json
   * 直接读写此文件即可获取/维护 skill 来源元数据，无需调用 `npx skills`。
   */
  function getSkillLockPath(): string {
    const xdg = process.env.XDG_STATE_HOME;
    if (xdg) return path.join(xdg, 'skills', '.skill-lock.json');
    return path.join(os.homedir(), '.agents', '.skill-lock.json');
  }

  /** 读取全局 skill lockfile，返回 name → SkillSourceInfo 映射。lockfile 缺失或损坏时返回空 Map。 */
  function readSkillSources(): Map<string, SkillSourceInfo> {
    const map = new Map<string, SkillSourceInfo>();
    try {
      const lockPath = getSkillLockPath();
      if (!fs.existsSync(lockPath)) return map;
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      const skills = parsed?.skills;
      if (skills && typeof skills === 'object') {
        for (const [name, entry] of Object.entries(skills as Record<string, any>)) {
          if (entry && typeof entry === 'object' && typeof entry.source === 'string') {
            map.set(name, {
              source: entry.source,
              sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : '',
              sourceType: typeof entry.sourceType === 'string' ? entry.sourceType : '',
            });
          }
        }
      }
    } catch { /* lockfile 损坏或不可读：当作无来源信息 */ }
    return map;
  }

  /**
   * 从全局 skill lockfile 中移除一个条目（仅在条目存在时写回）。
   * 严格保持 lockfile 的 version 3 结构与字段，避免破坏 skills CLI 兼容性。
   */
  function removeSkillFromLock(name: string): void {
    try {
      const lockPath = getSkillLockPath();
      if (!fs.existsSync(lockPath)) return;
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.skills || typeof parsed.skills !== 'object') return;
      if (!(name in parsed.skills)) return;
      delete parsed.skills[name];
      fs.writeFileSync(lockPath, JSON.stringify(parsed, null, 2), 'utf-8');
    } catch { /* lockfile 不可写或损坏：忽略，文件系统删除仍会执行 */ }
  }

  function findSkillRoot(name: string): { root: string; disabled: boolean } | null {
    // 先跨所有 root 查启用，再查禁用——与 listSkills 的去重优先级一致。
    // 旧版单 root 内“先启用后禁用”的顺序，在跨 root 有残留禁用副本时会误判为已禁用。
    for (const root of SKILL_ROOTS) {
      const normal = path.join(root, name);
      if (fs.existsSync(normal) && fs.statSync(normal).isDirectory()) {
        return { root, disabled: false };
      }
    }
    for (const root of SKILL_ROOTS) {
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

  /** 扫描一个 skill 目录（启用或禁用），合并入 result 并登记 seen。 */
  function scanSkillDir(
    dir: string,
    disabled: boolean,
    seenNames: Set<string>,
    result: SkillInfo[],
    sources: Map<string, SkillSourceInfo>,
  ): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !seenNames.has(entry.name)) {
        const skillDir = path.join(dir, entry.name);
        const src = sources.get(entry.name);
        result.push({
          name: entry.name,
          disabled,
          description: readSkillDescription(skillDir),
          source: src?.source ?? null,
          sourceUrl: src?.sourceUrl ?? null,
          sourceType: src?.sourceType ?? null,
        });
        seenNames.add(entry.name);
      }
    }
  }

  function listSkills(): SkillInfo[] {
    // lockfile 即 skills CLI 维护的来源缓存，实时读取（小文件），无需再缓存到 pi-tool-state.json。
    const sources = readSkillSources();

    const result: SkillInfo[] = [];
    const seenNames = new Set<string>();

    // 先扫启用目录、再扫禁用目录（同名以启用为准）。
    for (const root of SKILL_ROOTS) {
      scanSkillDir(root, false, seenNames, result, sources);
    }
    for (const root of SKILL_ROOTS) {
      scanSkillDir(path.join(root, '.disabled'), true, seenNames, result, sources);
    }
    return result;
  }

  ipcMain.handle('pi:skills:list', () => ({ skills: listSkills() }));

  // 刷新：lockfile 即数据源，listSkills 每次实时读取，刷新只需重新列举（瞬时）。
  ipcMain.handle('pi:skills:refreshCache', () => ({ skills: listSkills() }));

  /** 将 skill 移动到所在 root 的 .disabled/ 目录（启用 → 禁用）。 */
  function disableSkillByName(name: string): { success: boolean; error?: string } {
    const found = findSkillRoot(name);
    if (!found || found.disabled) return { success: false, error: 'Skill not found or already disabled' };
    const src = path.join(found.root, name);
    const dst = path.join(found.root, '.disabled', name);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      // 禁用只是把目录移到 .disabled/，lockfile 条目保持不变，
      // 故 source 在 listSkills() 中仍可从 lockfile 直接读到，无需额外记录。
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  ipcMain.handle('pi:skills:disable', (_e, payload: { name: string; source?: string | null }) => {
    return disableSkillByName(payload.name);
  });

  ipcMain.handle('pi:skills:enable', (_e, name: string) => {
    const found = findSkillRoot(name);
    if (!found || !found.disabled) return { success: false, error: 'Disabled skill not found' };
    const src = path.join(found.root, '.disabled', name);
    const dst = path.join(found.root, name);
    fs.renameSync(src, dst);
    return { success: true };
  });

  /** 从所有 skill root（含 .disabled/）删除指定名称的目录。返回是否删除了任何目录。 */
  function removeSkillDirs(name: string): boolean {
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
    return deleted;
  }

  ipcMain.handle('pi:skills:delete', async (_e, payload: { name: string; disabled?: boolean }) => {
    // 先清理 skills CLI lockfile 条目（保持 version 3 结构，不破坏 CLI 兼容）；
    // 无论启用/禁用态都清理——禁用只是把目录移到 .disabled/，lockfile 条目仍存在。
    removeSkillFromLock(payload.name);

    const deleted = removeSkillDirs(payload.name);
    return { success: deleted, error: deleted ? undefined : 'Skill not found' };
  });

  ipcMain.handle('pi:skills:batchDisable', (_e, payload: { names: string[]; source?: string | null }) => {
    return { results: payload.names.map(name => ({ name, ...disableSkillByName(name) })) };
  });

  ipcMain.handle('pi:skills:batchDelete', async (_e, payload: { names: string[] }) => {
    return {
      results: payload.names.map(name => {
        try {
          removeSkillFromLock(name);
          return { name, success: removeSkillDirs(name) };
        } catch (err) {
          return { name, success: false, error: String(err) };
        }
      }),
    };
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
      const isPiWorkbench = entry.name === PI_WORKBENCH_SYNC_FILE;
      result.push({
        name: entry.name,
        type: 'local',
        source: full,
        disabled,
        // pi-workbench-sync 为系统内置同步扩展，界面不可禁用/删除（禁用会在下次启动被重写）。
        managed: !isPiWorkbench,
        dir: full,
      });
      seenNames.add(entry.name);
    }
  }

  /** 全局与项目 settings.json 的路径列表（先全局后项目，写操作顺序无影响）。 */
  function settingsPaths(): string[] {
    return [settingsPathFor('global'), settingsPathFor('project')];
  }

  /**
   * 从全局与项目的 settings.json 中移除指定 source 的 packages 条目。
   * 返回是否修改了任何文件。
   */
  function removePackageFromSettings(source: string): boolean {
    let changed = false;
    for (const sp of settingsPaths()) {
      if (!fs.existsSync(sp)) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(sp, 'utf-8'));
        if (Array.isArray(settings.packages)) {
          const before = settings.packages.length;
          settings.packages = settings.packages.filter((p: unknown) => getPackageSourceString(p) !== source);
          if (settings.packages.length !== before) {
            changed = true;
            fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          }
        }
      } catch { /* 损坏的 settings 文件忽略 */ }
    }
    return changed;
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
    const [globalSettingsPath, projectSettingsPath] = settingsPaths();
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
      if (payload.name === PI_WORKBENCH_SYNC_FILE) return { success: false, error: 'Cannot disable built-in extension' };
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
      const changed = removePackageFromSettings(payload.source);
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
          // 启用目录已有同名（如 pi-workbench-sync 被启动覆盖写回）。此时禁用副本是残留，删除即可。
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
      if (payload.name === PI_WORKBENCH_SYNC_FILE) return { success: false, error: 'Cannot delete built-in extension' };
      if (!fs.existsSync(payload.dir)) return { success: false, error: 'Extension not found' };
      try {
        fs.rmSync(payload.dir, { recursive: true, force: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    if (payload.type === 'package') {
      const changed = removePackageFromSettings(payload.source);
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