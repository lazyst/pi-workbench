import { useState, useCallback } from 'react';
import { defaultConfig } from '../../../main/config';
import { pi } from '../ipc';
import { SYNC_FIT_PANES_EVENT } from '../constants/terminal';

/**
 * 面板布局状态 hook：管理侧边栏和右栏的宽度与折叠状态。
 *
 * 所有状态通过 `pi.getConfig` 初始化，改变时通过 `pi.setConfig` 持久化。
 */
export function usePanelLayout() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(defaultConfig().sidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(defaultConfig().rightPanelWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(defaultConfig().sidebarCollapsed);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState<boolean>(defaultConfig().rightPanelCollapsed);

  /**
   * 从 config 初始化面板布局状态。
   * 在 App 挂载时调用一次。
   */
  const initFromConfig = useCallback((cfg: ReturnType<typeof defaultConfig>) => {
    setSidebarWidth(cfg.sidebarWidth);
    setRightPanelWidth(cfg.rightPanelWidth ?? defaultConfig().rightPanelWidth);
    setSidebarCollapsed(cfg.sidebarCollapsed);
    setRightPanelCollapsed(cfg.rightPanelCollapsed);
  }, []);

  /**
 * 切换某面板折叠状态并持久化，同时派发同步 fit 事件让终端在下一帧绘制前同步到新尺寸
 * （消除侧边栏开关时的 ~16ms 尺寸跳变闪烁）。
 */
function togglePanel(
  setter: React.Dispatch<React.SetStateAction<boolean>>,
  configKey: 'sidebarCollapsed' | 'rightPanelCollapsed',
) {
  setter((prev) => {
    const next = !prev;
    pi.setConfig({ [configKey]: next }).catch(() => {});
    window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT));
    return next;
  });
}

/** 侧边栏拖拽改宽 */
  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w);
    pi.setConfig({ sidebarWidth: w }).catch(() => {});
  }, []);

  /** 右栏拖拽改宽 */
  const handleRightPanelResize = useCallback((w: number) => {
    setRightPanelWidth(w);
    pi.setConfig({ rightPanelWidth: w }).catch(() => {});
  }, []);

  /** 切换侧边栏折叠 */
  const handleToggleSidebar = useCallback(() => {
    togglePanel(setSidebarCollapsed, 'sidebarCollapsed');
  }, []);

  /** 切换右栏折叠 */
  const handleToggleRightPanel = useCallback(() => {
    togglePanel(setRightPanelCollapsed, 'rightPanelCollapsed');
  }, []);

  return {
    sidebarWidth,
    rightPanelWidth,
    sidebarCollapsed,
    rightPanelCollapsed,
    initFromConfig,
    handleSidebarResize,
    handleRightPanelResize,
    handleToggleSidebar,
    handleToggleRightPanel,
  };
}