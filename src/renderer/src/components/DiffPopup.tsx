// 点击 Monaco 编辑器行号旁 Git 变更标记时弹出的 diff 弹窗。
// 显示该行所在的 hunk 上下文（类似 VS Code 的「查看改动」popup）。
// 点击外部关闭。
import { useCallback, useEffect, useRef } from 'react';

interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  newLine: number | null;
}

interface Props {
  x: number;
  y: number;
  lines: DiffLine[];
  onClose: () => void;
}

export function DiffPopup({ x, y, lines, onClose }: Props) {
  const popupRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
      onClose();
    }
  }, [onClose]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClickOutside, handleKeyDown]);

  // 定位：弹窗在点击位置右下方，不超出视口
  const popupStyle: React.CSSProperties = {
    left: Math.min(x + 16, window.innerWidth - 520),
    top: Math.min(y + 8, window.innerHeight - 320),
  };

  const addedCount = lines.filter((l) => l.type === 'add').length;
  const removedCount = lines.filter((l) => l.type === 'del').length;

  return (
    <>
      <div className="diff-popup-overlay" />
      <div className="diff-popup" ref={popupRef} style={popupStyle}>
        <div className="diff-popup-header">
          <span>Git 变更</span>
          <span>
            {addedCount > 0 && <span style={{ color: 'var(--diff-added, #4ade80)' }}>+{addedCount} </span>}
            {removedCount > 0 && <span style={{ color: 'var(--diff-removed, #f87171)' }}>-{removedCount} </span>}
          </span>
        </div>
        <div className="diff-popup-body">
          {lines.map((l, i) => (
            <div
              key={i}
              className={`diff-popup-line ${
                l.type === 'add' ? 'diff-popup-line-add' : l.type === 'del' ? 'diff-popup-line-del' : 'diff-popup-line-ctx'
              }`}
            >
              <span className="diff-popup-prefix">
                {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
              </span>
              <span className="diff-popup-text">{l.text || '\u00a0'}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}