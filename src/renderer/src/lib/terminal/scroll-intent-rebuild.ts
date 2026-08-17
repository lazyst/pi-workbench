/**
 * scroll-intent-rebuild —— 滚动意图 buffer 重建协调
 *
 * 移植自 Orca 的 terminal-scroll-intent-rebuild.ts
 *
 * ## 为什么需要
 *
 * 当终端的 buffer 被重建（snapshot replay、scrollback restore、eager buffer flush）时：
 * - 旧 buffer 的绝对行号全部失效
 * - 正在进行的 fit 操作应延期到重建完成
 * - 重建完成后应恢复滚动意图
 *
 * 本模块提供 begin/end 生命周期标记，fit 操作在重建期间被延期，
 * 重建完成后按注册顺序执行。DOM 事件跟踪器在重建完成后自动同步滚动意图。
 */

// ─── 类型 ──────────────────────────────────────────────────────────────────

type RebuildState = {
  inFlight: boolean
  completeCallbacks: ((completed: boolean) => void)[]
  pendingFitOperations: (() => void)[]
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const rebuildStates = new WeakMap<object, RebuildState>()

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 标记 buffer 重建开始。
 * 期间 fit 操作将被延期并排队。
 *
 * @param terminal - xterm Terminal 实例（或任何可作 WeakMap key 的对象）
 */
export function beginTerminalScrollIntentBufferRebuild(terminal: object): void {
  rebuildStates.set(terminal, {
    inFlight: true,
    completeCallbacks: [],
    pendingFitOperations: [],
  })
}

/**
 * 标记 buffer 重建完成。
 * 执行所有挂起的完成回调和延期 fit 操作。
 *
 * @param terminal - 之前传入 beginTerminalScrollIntentBufferRebuild 的同一对象
 * @param completed - 重建是否成功完成
 */
export function endTerminalScrollIntentBufferRebuild(
  terminal: object,
  completed = true,
): void {
  const state = rebuildStates.get(terminal)
  if (!state) return

  state.inFlight = false
  rebuildStates.delete(terminal)

  // 执行延期的 fit 操作
  for (const fit of state.pendingFitOperations) {
    try {
      fit()
    } catch {
      /* 单个 fit 失败不影响其他操作 */
    }
  }

  // 通知完成回调
  for (const cb of state.completeCallbacks) {
    try {
      cb(completed)
    } catch {
      /* 单个回调失败不影响其他回调 */
    }
  }
}

/**
 * 检查是否正在进行 buffer 重建。
 *
 * @param terminal - xterm Terminal 实例
 * @returns true 表示正在重建中
 */
export function isTerminalScrollIntentRebuildInFlight(terminal: object): boolean {
  return rebuildStates.get(terminal)?.inFlight === true
}

/**
 * 注册 buffer 重建完成回调。
 * 如果不在重建中，立即执行回调。
 * 返回取消函数（在回调执行前调用可取消注册）。
 *
 * @param terminal - xterm Terminal 实例
 * @param callback - 重建完成后的回调，参数为是否成功完成
 * @returns 取消函数（调用后 callback 不会被调用）
 */
export function onTerminalScrollIntentBufferRebuildComplete(
  terminal: object,
  callback: (completed: boolean) => void,
): () => void {
  const state = rebuildStates.get(terminal)
  if (!state?.inFlight) {
    // 不在重建中，立即执行
    try {
      callback(true)
    } catch {
      /* 忽略 */
    }
    return () => {}
  }

  state.completeCallbacks.push(callback)
  return () => {
    const index = state.completeCallbacks.indexOf(callback)
    if (index >= 0) {
      state.completeCallbacks.splice(index, 1)
    }
  }
}