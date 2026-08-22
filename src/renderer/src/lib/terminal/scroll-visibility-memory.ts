/**
 * scroll-visibility-memory —— 终端可见性记忆
 *
 * 移植自 Orca 的 use-terminal-scroll-visibility-memory.ts
 *
 * ## 为什么需要
 *
 * 当终端面板被隐藏（tab 切换、工作区切换）后，将其恢复可见时：
 * - 如果之前是 followOutput（贴底），应滚动到最新输出
 * - 如果之前是 pinnedViewport（固定），应保持之前的位置
 *
 * 关键场景：全屏 TUI 程序在隐藏期间输出大量数据，
 * 恢复后应正确决定是贴底还是保持固定位置。
 *
 * ## 使用方式
 *
 * 1. 在隐藏前调用 rememberVisibleScrollSnapshot() 保存滚动位置
 * 2. 在恢复可见时调用 scheduleFollowOutputIfNeeded() 调度贴底检查
 * 3. 定期调用 pruneScrollSnapshots() 清理已销毁 pane 的记忆
 */

import type { Terminal } from '@xterm/xterm'
import { captureScrollState, getTerminalOutputEpoch, type ScrollState } from './scroll'
import { getTerminalScrollIntentKind, markTerminalFollowOutput } from './scroll-intent'
import { cancelDeferredScrollRestore } from './scroll'

// ─── 类型 ──────────────────────────────────────────────────────────────────

type VisibleScrollSnapshot = {
  scrollState: ScrollState
  outputEpoch: number
}

// ─── 内部状态 ──────────────────────────────────────────────────────────────

const visibleScrollSnapshots = new Map<string, VisibleScrollSnapshot>()
const pendingFollowOutputPaneIds = new Set<string>()
let followOutputFrameIds: number[] = []

/** 在 applyPendingFollowOutputRequests 无参调用时从中读取 pane 列表。 */
let currentPanes: { key: string; terminal: Terminal }[] = []
/** 当前可见性状态。 */
let currentIsVisible = false

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** followOutput 检查时 flush 的最大字符数。 */
const FOLLOW_OUTPUT_FLUSH_CHARS = 256 * 1024

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 记住当前可见终端的滚动快照。
 * 在隐藏前调用，保存 scrollState + outputEpoch。
 *
 * @param paneKey - 终端实例的唯一标识 key
 * @param terminal - xterm Terminal 实例
 */
export function rememberVisibleScrollSnapshot(
  paneKey: string,
  terminal: Terminal,
): void {
  visibleScrollSnapshots.set(paneKey, {
    scrollState: captureScrollState(terminal),
    outputEpoch: getTerminalOutputEpoch(terminal),
  })
}

/**
 * 忘记某 pane 的滚动快照与挂起的 followOutput 请求（pane 销毁时调用）。
 * 快照持有 captureScrollState 的 xterm marker 引用，若终端实例销毁后仍残留，
 * 会阻止相关对象被 GC（内存泄漏）。
 */
export function forgetVisibleScrollSnapshot(paneKey: string): void {
  visibleScrollSnapshots.delete(paneKey)
  pendingFollowOutputPaneIds.delete(paneKey)
}

/**
 * 调度一个 pane 在可见性恢复后执行 followOutput。
 * 如果意图是 followOutput，在下一个动画帧中 scrollToBottom。
 *
 * @param paneKey - 终端实例的唯一标识 key
 */
export function scheduleFollowOutputIfNeeded(
  paneKey: string,
  panes?: { key: string; terminal: Terminal }[],
  isVisible?: () => boolean,
): void {
  pendingFollowOutputPaneIds.add(paneKey)
  if (panes) {
    currentPanes = panes
  }
  if (isVisible) {
    currentIsVisible = isVisible()
  }
  if (followOutputFrameIds.length > 0) return

  const firstFrameId = requestAnimationFrame(() => {
    followOutputFrameIds = followOutputFrameIds.filter((id) => id !== firstFrameId)
    const secondFrameId = requestAnimationFrame(() => {
      followOutputFrameIds = followOutputFrameIds.filter((id) => id !== secondFrameId)
      applyPendingFollowOutputRequests()
    })
    followOutputFrameIds.push(secondFrameId)
  })
  followOutputFrameIds.push(firstFrameId)
}

/**
 * 执行所有挂起的 followOutput 请求（无参版本，使用内部存储的 pane 列表）。
 */
function applyPendingFollowOutputRequests(): void {
  if (pendingFollowOutputPaneIds.size === 0) return
  if (!currentIsVisible) return

  let didScroll = false
  for (const { key, terminal } of currentPanes) {
    if (!pendingFollowOutputPaneIds.has(key)) continue
    const previous = visibleScrollSnapshots.get(key)
    const currentEpoch = getTerminalOutputEpoch(terminal)
    const hasNewOutput = previous ? currentEpoch > previous.outputEpoch : currentEpoch > 0

    if (hasNewOutput) {
      if (getTerminalScrollIntentKind(terminal) === 'followOutput') {
        cancelDeferredScrollRestore(terminal)
        markTerminalFollowOutput(terminal)
        try {
          terminal.scrollToBottom()
          didScroll = true
        } catch {
          // 静默处理渲染器未就绪的异常
        }
      }
      visibleScrollSnapshots.set(key, {
        scrollState: captureScrollState(terminal),
        outputEpoch: currentEpoch,
      })
    }
    pendingFollowOutputPaneIds.delete(key)
  }
}
