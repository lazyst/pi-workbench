import { useEffect, useState, useCallback } from 'react';
import { pi } from '../../ipc';
import { ConfirmDialog } from '../ConfirmDialog';

// ─── 扩展管理组件 ──────────────────────────────────────────────────────

interface ExtensionInfo {
  name: string;
  type: string;
  source: string;
  disabled: boolean;
  managed: boolean;
  dir?: string;
}

export function PiExtensionsManager() {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [tab, setTab] = useState<'enabled' | 'disabled'>('enabled');
  const [status, setStatus] = useState('加载中...');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('加载中...');
    try {
      const data = await pi.piExtensionsList();
      setExtensions(data.extensions);
      setStatus(`${data.extensions.length} 个`);
    } catch {
      setStatus('加载失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runWithReload = async (action: () => Promise<{ success: boolean }>) => {
    try {
      const res = await action();
      if (res.success) await load();
    } catch { /* ignore */ }
  };

  const disable = async (ext: ExtensionInfo) => {
    await runWithReload(() => pi.piExtensionsDisable({ name: ext.name, type: ext.type, source: ext.source, dir: ext.dir }));
  };

  const enable = async (ext: ExtensionInfo) => {
    await runWithReload(() => pi.piExtensionsEnable({ name: ext.name, type: ext.type, source: ext.source, dir: ext.dir }));
  };

  const doDelete = async (name: string) => {
    setConfirmDelete(null);
    const ext = extensions.find(e => e.name === name);
    if (!ext) return;
    await runWithReload(() => pi.piExtensionsDelete({ name: ext.name, type: ext.type, source: ext.source, dir: ext.dir }));
  };

  const filtered = extensions.filter(e => e.disabled === (tab === 'disabled'));

  const typeLabel = (type: string) => {
    switch (type) {
      case 'local': return '本地目录';
      case 'package': return '包安装';
      default: return '直接路径';
    }
  };

  // 不可管理的扩展给出原因提示：
  //   local 且 !managed → pi-workbench 同步扩展等系统内置项
  //   path              → settings.json 中的直接路径扩展，需编辑配置文件
  const unmanagedHint = (e: ExtensionInfo) => {
    if (e.type === 'path') return '直接路径扩展，请编辑 settings.json 管理';
    return '系统内置扩展，不可禁用/删除';
  };

  return (
    <div className="pi-extensions-manager">
      <div className="pi-extensions-toolbar">
        <span className="pi-settings-badge">{status}</span>
        <button className="btn btn-sm" onClick={load}>↻ 刷新</button>
      </div>

      <div className="pi-extensions-tabs">
        <button className={`pi-tab ${tab === 'enabled' ? 'active' : ''}`} onClick={() => setTab('enabled')}>已启用</button>
        <button className={`pi-tab ${tab === 'disabled' ? 'active' : ''}`} onClick={() => setTab('disabled')}>已禁用</button>
      </div>

      <div className="pi-extensions-list">
        {filtered.length === 0 && (
          <div className="pi-empty-state">
            <p>{tab === 'disabled' ? '暂无已禁用的扩展' : '暂无已启用的扩展'}</p>
          </div>
        )}
        {filtered.map(e => (
          <div className="pi-extension-card" key={e.name}>
            <div className="pi-extension-card-header">
              <span className="pi-extension-name">{e.name}</span>
              <span className="pi-extension-type">{typeLabel(e.type)}</span>
              <span className={`pi-extension-badge ${e.disabled ? 'pi-badge-disabled' : 'pi-badge-enabled'}`}>
                {e.disabled ? '已禁用' : '正常'}
              </span>
            </div>
            <div className="pi-extension-desc">
              <code className="pi-extension-source">{e.source}</code>
            </div>
            <div className="pi-extension-actions">
              {!e.managed ? (
                <span className="pi-muted">{unmanagedHint(e)}</span>
              ) : e.disabled ? (
                <>
                  <button className="btn btn-sm" onClick={() => enable(e)}>启用</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(e.name)}>删除</button>
                </>
              ) : (
                <>
                  <button className="btn btn-sm" onClick={() => disable(e)}>禁用</button>
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(e.name)}>删除</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除扩展"
          message={`确定要删除扩展「${confirmDelete}」吗？此操作不可撤销。\n\n提示：如果扩展是通过 pi install 安装的，仅从配置中移除。`}
          onConfirm={() => doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}