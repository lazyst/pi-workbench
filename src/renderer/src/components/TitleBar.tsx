import { IconSettings, IconMinimize, IconMaximize, IconRestore, IconClose, IconSidebarToggle, IconRightPanelToggle } from './icons';
import { pi } from '../ipc';
import { useMaximized } from '../hooks/useMaximized';

interface Props {
  onOpenSettings: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
}

// Custom title bar for the frameless window. Everything is painted with CSS
// variables, so its colours follow the active theme automatically (task 3).
// The bar itself is a drag region; only the buttons opt out via
// `-webkit-app-region: no-drag` (see app.css).
export function TitleBar({ onOpenSettings, sidebarCollapsed, onToggleSidebar, rightPanelCollapsed, onToggleRightPanel }: Props) {
  const maximized = useMaximized();

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-title">Pi Workbench</span>
        <button
          className="titlebar-btn titlebar-panel-toggle"
          type="button"
          title={sidebarCollapsed ? '展开左侧栏' : '收起左侧栏'}
          aria-label={sidebarCollapsed ? '展开左侧栏' : '收起左侧栏'}
          onClick={onToggleSidebar}
        >
          <IconSidebarToggle collapsed={sidebarCollapsed} />
        </button>
      </div>
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <button
          className="titlebar-btn titlebar-panel-toggle"
          type="button"
          title={rightPanelCollapsed ? '展开右侧栏' : '收起右侧栏'}
          aria-label={rightPanelCollapsed ? '展开右侧栏' : '收起右侧栏'}
          onClick={onToggleRightPanel}
        >
          <IconRightPanelToggle collapsed={rightPanelCollapsed} />
        </button>
        <button className="titlebar-btn" type="button" title="设置" aria-label="设置" onClick={onOpenSettings}>
          <IconSettings />
        </button>
        <button
          className="titlebar-btn"
          type="button"
          title="最小化"
          aria-label="最小化"
          onClick={() => pi.minimizeWindow()}
        >
          <IconMinimize />
        </button>
        <button
          className="titlebar-btn"
          type="button"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => pi.toggleMaximizeWindow()}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={() => pi.closeWindow()}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
