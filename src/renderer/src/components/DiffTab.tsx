// 中间区 Tab 内容组件：Git diff 查看（keep-alive 友好）。
// 支持三种模式：
//   • commitHash = null → 工作区 diff（全量），订阅 gitWatch 实时刷新
//   • commitHash + filePath = null → 该提交全量 diff
//   • commitHash + filePath = string → 该提交中某文件的左右分栏 diff（Monaco DiffEditor）
// 纯只读：无 write/push/checkout。
import { useCallback, useEffect, useState } from 'react';
import { pi } from '../ipc';
import { SideBySideDiffView } from './SideBySideDiffView';
import { MonacoDiffView } from './MonacoDiffView';

interface Props {
  cwd: string;
  /** null → 工作区 diff；某 hash → 该提交 diff。 */
  commitHash: string | null;
  /** 指定提交中的某个文件 diff（仅 commitHash 非 null 时有效）。 */
  filePath?: string | null;
  /** 是否当前可见 tab（keep-alive：非 active 时父容器用 CSS 隐藏，本组件仍挂载）。 */
  active: boolean;
  /** 点击「返回」的回调。 */
  onBack?: () => void;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', html: 'html', xml: 'xml',
    yaml: 'yaml', yml: 'yaml', py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', swift: 'swift', kt: 'kotlin', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', sh: 'shell', bash: 'shell',
    sql: 'sql', graphql: 'graphql', vue: 'html', svelte: 'html',
    toml: 'toml', ini: 'ini', cfg: 'ini', env: 'dotenv',
  };
  return map[ext] ?? 'plaintext';
}

export function DiffTab({ cwd, commitHash, filePath, active, onBack }: Props) {
  // 全量 unified diff（用于非文件级 diff 模式）
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 文件级 diff（用于 commitHash + filePath 模式）
  const [fileDiff, setFileDiff] = useState<{ original: string; modified: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // 判断是否为文件级 diff 模式
  const isFileMode = commitHash != null && filePath != null;

  // 获取全量 diff（非文件模式）
  useEffect(() => {
    if (isFileMode) return;
    if (!cwd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff('');
    (async () => {
      try {
        const d = await pi.gitDiff(cwd, commitHash ?? undefined);
        if (!cancelled) setDiff((prev) => (prev === d ? prev : d));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    let unsubscribe: (() => void) | undefined;
    if (commitHash === null) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      unsubscribe = pi.gitWatch(cwd, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          pi.gitDiff(cwd).then((d) => { if (!cancelled) setDiff((prev) => (prev === d ? prev : d)); }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        }, 250);
      });
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [cwd, commitHash, isFileMode]);

  // 获取文件级 diff（文件模式）
  useEffect(() => {
    if (!isFileMode || !commitHash || !filePath) return;
    if (!cwd) return;
    let cancelled = false;
    setFileLoading(true);
    setFileDiff(null);
    (async () => {
      try {
        const d = await pi.gitCommitFileDiff(cwd, commitHash, filePath);
        if (!cancelled) setFileDiff(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, commitHash, filePath, isFileMode]);

  void active;

  const handleBack = useCallback(() => {
    onBack?.();
  }, [onBack]);

  const title = commitHash ? `提交 ${commitHash.slice(0, 7)}` : '工作区改动';

  // 文件级 diff 模式
  if (isFileMode && filePath) {
    return (
      <div className="diff-tab">
        <div className="diff-tab-header">
          <span className="diff-tab-title">{filePath}</span>
          <button className="btn git-diff-back" onClick={handleBack}>← 返回提交改动</button>
        </div>
        <div className="diff-tab-body">
          {fileLoading && <div className="git-empty">加载文件 diff…</div>}
          {error && <div className="preview-error">{error}</div>}
          {!fileLoading && !error && fileDiff && (
            <MonacoDiffView
              original={fileDiff.original}
              modified={fileDiff.modified}
              language={detectLanguage(filePath)}
              fileName={filePath}
            />
          )}
        </div>
      </div>
    );
  }

  // 全量 diff 模式
  const empty = !loading && !error && diff.trim().length === 0;

  return (
    <div className="diff-tab">
      <div className="diff-tab-header">
        <span className="diff-tab-title">{title}</span>
        {commitHash && <button className="btn git-diff-back" onClick={handleBack}>← 返回工作区改动</button>}
      </div>
      <div className="diff-tab-body">
        {loading && <div className="git-empty">加载 diff…</div>}
        {error && <div className="preview-error">{error}</div>}
        {!loading && !error && empty && (
          <div className="git-empty">{commitHash ? '该提交无改动' : '无改动'}</div>
        )}
        {!loading && !error && !empty && (
          <SideBySideDiffView diff={diff} />
        )}
      </div>
    </div>
  );
}