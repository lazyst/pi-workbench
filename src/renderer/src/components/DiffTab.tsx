// 中间区 Tab 内容组件：Git diff 查看（keep-alive 友好）。
// 由右侧 GitDiffDrawer 抽屉改造而来——去掉 overlay / 左侧拖拽 resizer / 关闭按钮，
// 改为占满 tab 内容的形态。关闭由统一 Tab 条的 × 负责。
// 关键行为完全等价于原抽屉：
//   • commitHash 为 null → 工作区 diff（unstaged + staged），额外订阅 gitWatch 实时刷新（250ms 防抖）
//   • commitHash 为某 hash → 该提交的 diff（历史快照，无需订阅）
//   • 提交 diff 时显示「← 返回工作区改动」按钮（onBack 回调通知父组件切回工作区 diff）
// 纯只读：无 write/push/checkout（对齐 GitView 的只读范围）。
//
// v2：改用自定义 SingleDiffView（单栏 unified diff + 按文件分块折叠），
// 替代 MonacoDiffEditor 的双栏并排模式。
import { useCallback, useEffect, useState } from 'react';
import { pi } from '../ipc';
import { SideBySideDiffView } from './SideBySideDiffView';

interface Props {
  cwd: string;
  /** null → 工作区 diff；某 hash → 该提交 diff。 */
  commitHash: string | null;
  /** 是否当前可见 tab（keep-alive：非 active 时父容器用 CSS 隐藏，本组件仍挂载）。 */
  active: boolean;
  /** commitHash 非 null 时点击「← 返回工作区改动」的回调（父组件切回工作区 diff）。 */
  onBack?: () => void;
}

export function DiffTab({ cwd, commitHash, active, onBack }: Props) {
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the right diff whenever the target (cwd / commit) changes.
  // 工作区 diff（commitHash 为 null）额外订阅该仓库的实时变更，文件改动即时刷新；
  // 提交 diff（历史快照）无需订阅。
  // 注意：setDiff 仅在内容真正变化时更新，避免 gitWatch 的重复 change 事件（Windows
  // 上 recursive fs.watch 极易连发）或相同字符串新引用导致无谓重渲染——否则每次
  // 刷新都会让 MonacoDiffEditor 销毁/重建模型、闪一帧。
  useEffect(() => {
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
      // 250ms 防抖合并突发事件；刷新复用本轮 fetch 逻辑（重新拉取 diff）。
      let timer: ReturnType<typeof setTimeout> | null = null;
      unsubscribe = pi.gitWatch(cwd, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          // 静默刷新：仅当内容真正变化时更新（setDiff 内部已去重），不切 loading 态，
          // 避免 Windows 上 recursive fs.watch 的密集 change 事件造成「加载中↔diff」闪。
          pi.gitDiff(cwd).then((d) => { if (!cancelled) setDiff((prev) => (prev === d ? prev : d)); }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        }, 250);
      });
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [cwd, commitHash]);

  const title = commitHash ? '提交改动' : '工作区改动';
  const empty = !loading && !error && diff.trim().length === 0;

  // 不再需要 reconstructDiffSides，SingleDiffView 直接接收 unified diff 文本

  // active 当前仅语义占位（keep-alive 由父容器 CSS 控制），但接收以备父组件传递。
  void active;

  const handleBack = useCallback(() => {
    onBack?.();
  }, [onBack]);

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
