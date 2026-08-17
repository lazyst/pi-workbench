import { useEffect, useState } from 'react';
import { pi } from '../ipc';

/**
 * 订阅窗口最大化状态，供标题条图标与缩放热区共用。
 *
 * 注意：不能把 `pi.onMaximizeChange` 的返回值当作 React cleanup 直接返回——
 * 它返回的是事件对象而非取消函数，直接返回会让 React 在卸载时把它当 cleanup
 * 调用并报错（“destroy is not a function”）。`onMaximizeChange` 自身会管理
 * 订阅生命周期，故这里无需返回 cleanup。
 */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    pi.onMaximizeChange?.(setMaximized);
  }, []);
  return maximized;
}
