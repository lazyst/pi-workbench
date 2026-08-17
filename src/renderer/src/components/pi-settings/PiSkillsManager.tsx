import { useEffect, useState, useCallback } from 'react';
import { pi } from '../../ipc';
import { ConfirmDialog } from '../ConfirmDialog';

// ─── Skills 管理组件 ───────────────────────────────────────────────────

interface SkillInfo {
  name: string;
  disabled: boolean;
  description?: string;
  source: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
}

interface SourceGroup {
  source: string | null;
  label: string;
  skills: SkillInfo[];
}

function groupBySource(skills: SkillInfo[]): SourceGroup[] {
  const map = new Map<string | null, SkillInfo[]>();
  for (const s of skills) {
    const key = s.source ?? '__local__';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const groups: SourceGroup[] = [];
  for (const [key, list] of map) {
    groups.push({
      source: key === '__local__' ? null : (key as string),
      label: key === '__local__' ? '本地 Skill' : (key as string),
      skills: list,
    });
  }
  // 排序：有 source 的排前面，source 按字母序
  groups.sort((a, b) => {
    if (a.source === null && b.source === null) return 0;
    if (a.source === null) return 1;
    if (b.source === null) return -1;
    return a.source.localeCompare(b.source);
  });
  return groups;
}

export function PiSkillsManager() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [tab, setTab] = useState<'enabled' | 'disabled'>('enabled');
  const [status, setStatus] = useState('加载中...');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmBatch, setConfirmBatch] = useState<{ action: 'delete' | 'disable'; group: SourceGroup } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setStatus('加载中...');
    try {
      const data = await pi.piSkillsList();
      setSkills(data.skills);
      setStatus(`${data.skills.length} 个`);
    } catch {
      setStatus('加载失败');
    }
  }, []);

  const refresh = useCallback(async () => {
    setStatus('刷新中...');
    try {
      const data = await pi.piSkillsRefreshCache();
      setSkills(data.skills);
      setStatus(`${data.skills.length} 个`);
    } catch {
      setStatus('刷新失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const disable = async (name: string, source?: string | null) => {
    try {
      const res = await pi.piSkillsDisable({ name, source });
      if (res.success) await load();
    } catch { /* ignore */ }
  };

  const enable = async (name: string) => {
    try {
      const res = await pi.piSkillsEnable(name);
      if (res.success) await load();
    } catch { /* ignore */ }
  };

  const doDelete = async (name: string, disabled?: boolean) => {
    setConfirmDelete(null);
    try {
      const res = await pi.piSkillsDelete({ name, disabled });
      if (res.success) await load();
    } catch { /* ignore */ }
  };

  const batchDisable = async (group: SourceGroup) => {
    setConfirmBatch(null);
    try {
      const names = group.skills.filter(s => !s.disabled).map(s => s.name);
      if (names.length === 0) return;
      const res = await pi.piSkillsBatchDisable({ names, source: group.source });
      if (res.results.some(r => r.success)) await load();
    } catch { /* ignore */ }
  };

  const batchDelete = async (group: SourceGroup) => {
    setConfirmBatch(null);
    try {
      const names = group.skills.map(s => s.name);
      if (names.length === 0) return;
      const res = await pi.piSkillsBatchDelete({ names });
      if (res.results.some(r => r.success)) await load();
    } catch { /* ignore */ }
  };

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filtered = skills.filter(s => s.disabled === (tab === 'disabled'));
  const groups = groupBySource(filtered);

  return (
    <div className="pi-skills-manager">
      <div className="pi-skills-toolbar">
        <span className="pi-settings-badge">{status}</span>
        <button className="btn btn-sm" onClick={refresh}>↻ 刷新</button>
      </div>

      <div className="pi-skills-tabs">
        <button className={`pi-tab ${tab === 'enabled' ? 'active' : ''}`} onClick={() => setTab('enabled')}>已启用</button>
        <button className={`pi-tab ${tab === 'disabled' ? 'active' : ''}`} onClick={() => setTab('disabled')}>已禁用</button>
      </div>

      <div className="pi-skills-list">
        {groups.length === 0 && (
          <div className="pi-empty-state">
            <p>{tab === 'disabled' ? '暂无已禁用的 Skill' : '暂无已启用的 Skill'}</p>
          </div>
        )}

        {groups.map(group => {
          const groupKey = group.source ?? '__local__';
          const isCollapsed = collapsed.has(groupKey);
          const activeSkills = group.skills.filter(s => !s.disabled);
          const disabledSkills = group.skills.filter(s => s.disabled);

          return (
            <div className="pi-skill-group" key={groupKey}>
              <div
                className="pi-skill-group-header"
                onClick={() => toggleCollapse(groupKey)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(groupKey); } }}
              >
                <span className="pi-chevron">{isCollapsed ? '▶' : '▼'}</span>
                <span className="pi-skill-group-title">{group.label}</span>
                <span className="pi-settings-badge">{group.skills.length} 个</span>
                <div className="pi-skill-group-actions" onClick={(e) => e.stopPropagation()}>
                  {tab === 'enabled' && activeSkills.length > 0 && (
                    <button
                      className="btn btn-sm"
                      onClick={() => setConfirmBatch({ action: 'disable', group })}
                    >
                      全部禁用
                    </button>
                  )}
                  {tab === 'disabled' && disabledSkills.length > 0 && (
                    <button
                      className="btn btn-sm"
                      onClick={() => disabledSkills.forEach(s => enable(s.name))}
                    >
                      全部启用
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => setConfirmBatch({ action: 'delete', group })}
                  >
                    全部删除
                  </button>
                </div>
              </div>

              <div className={`pi-skill-group-items ${isCollapsed ? 'pi-collapsed' : ''}`}>
                  {group.skills.map(s => (
                    <div className="pi-skill-card" key={s.name}>
                      <div className="pi-skill-card-header">
                        <span className="pi-skill-name">{s.name}</span>
                        <span className={`pi-skill-badge ${s.disabled ? 'pi-badge-disabled' : 'pi-badge-enabled'}`}>
                          {s.disabled ? '已禁用' : '正常'}
                        </span>
                      </div>
                      <div className="pi-skill-desc">
                        {s.description || <span className="pi-muted">无描述</span>}
                      </div>
                      <div className="pi-skill-card-meta">
                        {s.source && <code className="pi-skill-source">{s.source}</code>}
                      </div>
                      <div className="pi-skill-actions">
                        {s.disabled ? (
                          <>
                            <button className="btn btn-sm" onClick={() => enable(s.name)}>启用</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(s.name)}>删除</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => disable(s.name, s.source)}>禁用</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(s.name)}>删除</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
          );
        })}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除 Skill"
          message={`确定要永久删除 Skill「${confirmDelete}」吗？此操作不可撤销。`}
          onConfirm={() => doDelete(confirmDelete, tab === 'disabled')}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {confirmBatch && (
        <ConfirmDialog
          title={confirmBatch.action === 'disable' ? '批量禁用 Skill' : '批量删除 Skill'}
          message={
            confirmBatch.action === 'disable'
              ? `确定要禁用分类「${confirmBatch.group.label}」下的所有 Skill（共 ${confirmBatch.group.skills.filter(s => !s.disabled).length} 个）吗？`
              : `确定要永久删除分类「${confirmBatch.group.label}」下的所有 Skill（共 ${confirmBatch.group.skills.length} 个）吗？此操作不可撤销。`
          }
          onConfirm={() => {
            if (confirmBatch.action === 'disable') batchDisable(confirmBatch.group);
            else batchDelete(confirmBatch.group);
          }}
          onCancel={() => setConfirmBatch(null)}
        />
      )}
    </div>
  );
}