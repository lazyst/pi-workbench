// @vitest-environment jsdom
/**
 * terminal-scroll 测试
 *
 * 测试 ScrollState 的捕获、恢复、deferred restore 和 pending fit scroll restore。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IMarker, Terminal } from '@xterm/xterm'
import {
  captureScrollState,
  cancelDeferredScrollRestore,
  getTerminalOutputEpoch,
  recordTerminalOutput,
  releaseScrollStateMarker,
  restoreScrollState,
  restoreScrollStateAfterFit,
  resumePendingFitScrollRestoreAfterFit,
  type ScrollState,
} from '../scroll'

// ===========================================================================
// 辅助工厂函数
// ===========================================================================

/** 创建一个模拟的 xterm IMarker。 */
function createMarker(line: number): IMarker {
  return {
    id: line,
    isDisposed: false,
    line,
    dispose: vi.fn(function (this: { isDisposed: boolean }) {
      this.isDisposed = true
    }),
    onDispose: vi.fn(),
  } as unknown as IMarker
}

/** 创建一个模拟的 xterm Terminal。 */
function createTerminal(args: {
  viewportY: number
  baseY: number
  type?: 'normal' | 'alternate'
  cursorY?: number
}): Terminal {
  const active: {
    type: string
    viewportY: number
    baseY: number
    cursorY: number
    getLine?: () => undefined
  } = {
    type: args.type ?? 'normal',
    viewportY: args.viewportY,
    baseY: args.baseY,
    cursorY: args.cursorY ?? 5,
  }

  return {
    buffer: { active },
    element: {} as HTMLElement,
    registerMarker: vi.fn((cursorYOffset: number) =>
      createMarker(active.baseY + active.cursorY + cursorYOffset)
    ),
    scrollToBottom: vi.fn(() => {
      active.viewportY = active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      active.viewportY = line
    }),
    scrollLines: vi.fn((delta: number) => {
      active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + delta))
    }),
    cols: 80,
    options: {},
  } as unknown as Terminal
}

/** 更新模拟 IMarker 的行号。 */
function setMarkerLine(marker: IMarker, line: number): void {
  const mutableMarker = marker as unknown as { line: number }
  mutableMarker.line = line
}

// ===========================================================================
// 测试
// ===========================================================================

describe('terminal-scroll', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // ── captureScrollState ─────────────────────────────────────────────────

  describe('captureScrollState', () => {
    it('捕获数值视口位置', () => {
      const terminal = createTerminal({ viewportY: 42, baseY: 100, cursorY: 7 })

      const state = captureScrollState(terminal)

      expect(state).toMatchObject({
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      })
      expect(terminal.registerMarker).toHaveBeenCalledWith(-65)
    })

    it('在底部时 wasAtBottom 为 true 且不创建标记', () => {
      const terminal = createTerminal({ viewportY: 100, baseY: 100, cursorY: 5 })

      const state = captureScrollState(terminal)

      expect(state.wasAtBottom).toBe(true)
      expect(state.firstVisibleLineMarker).toBeUndefined()
      expect(state.firstVisibleLogicalLineMarker).toBeUndefined()
      expect(terminal.registerMarker).not.toHaveBeenCalled()
    })

    it('在 alternate buffer 中不创建标记', () => {
      const terminal = createTerminal({ viewportY: 50, baseY: 100, type: 'alternate', cursorY: 5 })

      const state = captureScrollState(terminal)

      expect(state.bufferType).toBe('alternate')
      expect(state.firstVisibleLineMarker).toBeUndefined()
      expect(terminal.registerMarker).not.toHaveBeenCalled()
    })
  })

  // ── recordTerminalOutput / getTerminalOutputEpoch ──────────────────────

  describe('输出纪元', () => {
    it('按终端分别跟踪输出纪元', () => {
      const terminalA = createTerminal({ viewportY: 0, baseY: 0 })
      const terminalB = createTerminal({ viewportY: 0, baseY: 0 })

      recordTerminalOutput(terminalA)
      recordTerminalOutput(terminalA)
      recordTerminalOutput(terminalB)

      expect(getTerminalOutputEpoch(terminalA)).toBe(2)
      expect(getTerminalOutputEpoch(terminalB)).toBe(1)
    })

    it('未记录过的终端返回 0', () => {
      const terminal = createTerminal({ viewportY: 0, baseY: 0 })
      expect(getTerminalOutputEpoch(terminal)).toBe(0)
    })
  })

  // ── restoreScrollState ────────────────────────────────────────────────

  describe('restoreScrollState', () => {
    it('恢复到捕获的视口行', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
      expect(terminal.buffer.active.viewportY).toBe(42)
    })

    it('终端元素不存在时跳过恢复', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      ;(terminal as unknown as { element: HTMLElement | undefined }).element = undefined
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: true,
        viewportY: 100,
        baseY: 100,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToBottom).not.toHaveBeenCalled()
      expect(terminal.scrollToLine).not.toHaveBeenCalled()
    })

    it('静默处理 xterm dimensions TypeError（scrollToBottom）', () => {
      const terminal = createTerminal({ viewportY: 50, baseY: 100 })
      ;(terminal.scrollToBottom as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: true,
        viewportY: 100,
        baseY: 100,
      }

      expect(() => restoreScrollState(terminal, state)).not.toThrow()
      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    })

    it('静默处理 xterm dimensions TypeError（scrollToLine）', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      ;(terminal.scrollToLine as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      expect(() => restoreScrollState(terminal, state)).not.toThrow()
      expect(terminal.scrollToLine).toHaveBeenCalledTimes(1)
    })

    it('使用可见行标记（reflow 后行号变化）', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 300 })
      const marker = createMarker(160)
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToLine).toHaveBeenCalledWith(160)
      expect(terminal.buffer.active.viewportY).toBe(160)
      expect(marker.dispose).toHaveBeenCalledTimes(1)
    })

    it('将恢复的视口行裁剪到当前 buffer 底部', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 30 })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToLine).toHaveBeenCalledWith(30)
      expect(terminal.buffer.active.viewportY).toBe(30)
    })

    it('之前处于底部时调用 scrollToBottom', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 250 })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: true,
        viewportY: 100,
        baseY: 100,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
      expect(terminal.scrollToLine).not.toHaveBeenCalled()
      expect(terminal.buffer.active.viewportY).toBe(250)
    })

    it('在 normal 和 alternate buffer 之间不恢复', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const state: ScrollState = {
        bufferType: 'alternate',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      restoreScrollState(terminal, state)

      expect(terminal.scrollToLine).not.toHaveBeenCalled()
      expect(terminal.buffer.active.viewportY).toBe(10)
    })
  })

  // ── restoreScrollStateAfterFit ────────────────────────────────────────

  describe('restoreScrollStateAfterFit', () => {
    it('成功恢复时调用 onRestored', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const state = captureScrollState(terminal)
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => true,
      })

      expect(onRestored).toHaveBeenCalledTimes(1)
    })

    it('shouldRestore 返回 false 时跳过恢复', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const state = captureScrollState(terminal)
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => false,
      })

      expect(terminal.scrollToLine).not.toHaveBeenCalled()
      expect(onRestored).not.toHaveBeenCalled()
    })

    it('初始恢复失败时通过 rAF 重试', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      // 首次 scrollToLine 失败（dimensions 错误），第二次成功
      const scrollToLineMock = terminal.scrollToLine as ReturnType<typeof vi.fn>
      scrollToLineMock
        .mockImplementationOnce(() => {
          throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
        })
        .mockImplementationOnce((line: number) => {
          (terminal.buffer.active as { viewportY: number }).viewportY = line
        })

      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => true,
      })

      // 第一次 rAF 重试
      expect(frameCallbacks.length).toBe(1)
      frameCallbacks.shift()?.(0)

      expect(scrollToLineMock).toHaveBeenCalledTimes(2)
      expect(onRestored).toHaveBeenCalledTimes(1)
    })

    it('重试帧数耗尽后暂停，可后续恢复', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      // scrollToLine 始终失败
      const scrollToLineMock = terminal.scrollToLine as ReturnType<typeof vi.fn>
      scrollToLineMock.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })

      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => true,
      })

      // FIT_SCROLL_RESTORE_MAX_FRAMES = 2 次 rAF 重试
      expect(frameCallbacks.length).toBe(1)
      frameCallbacks.shift()?.(0) // 第一次重试
      expect(frameCallbacks.length).toBe(1)
      frameCallbacks.shift()?.(0) // 第二次重试
      expect(frameCallbacks.length).toBe(0) // 不再有重试

      expect(scrollToLineMock).toHaveBeenCalledTimes(3) // 初始 + 2 次重试
      expect(onRestored).not.toHaveBeenCalled()
    })

    it('释放 fit 恢复中抛出意外错误时的标记', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const marker = createMarker(42)
      vi.mocked(terminal.scrollToLine).mockImplementation(() => {
        throw new Error('unexpected renderer failure')
      })
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker,
      }

      expect(() =>
        restoreScrollStateAfterFit(terminal, state, {
          onRestored: vi.fn(),
          shouldRestore: () => true,
        })
      ).toThrow('unexpected renderer failure')
      expect(marker.isDisposed).toBe(true)
    })

    it('释放异步重试中抛出错误时的标记', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const marker = createMarker(42)
      vi.mocked(terminal.scrollToLine)
        .mockImplementationOnce(() => {
          throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
        })
        .mockImplementationOnce(() => {
          throw new Error('unexpected asynchronous renderer failure')
        })

      restoreScrollStateAfterFit(
        terminal,
        {
          bufferType: 'normal',
          wasAtBottom: false,
          viewportY: 42,
          baseY: 100,
          firstVisibleLineMarker: marker,
        },
        { onRestored: vi.fn(), shouldRestore: () => true }
      )

      expect(() => frameCallbacks.shift()?.(0)).toThrow('unexpected asynchronous renderer failure')
      expect(marker.isDisposed).toBe(true)
    })
  })

  // ── cancelDeferredScrollRestore ──────────────────────────────────────

  describe('cancelDeferredScrollRestore', () => {
    it('取消挂起的 fit 恢复', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const scrollToLineMock = terminal.scrollToLine as ReturnType<typeof vi.fn>
      scrollToLineMock.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })

      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => true,
      })

      expect(frameCallbacks.length).toBe(1)

      cancelDeferredScrollRestore(terminal)

      // 取消后 rAF 回调不应再执行恢复
      frameCallbacks.shift()?.(0)

      // scrollToLine 应只被调用 1 次（初始调用），rAF 回调被取消
      expect(scrollToLineMock).toHaveBeenCalledTimes(1)
      expect(onRestored).not.toHaveBeenCalled()
    })

    it('无挂起恢复时安全执行', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      expect(() => cancelDeferredScrollRestore(terminal)).not.toThrow()
    })
  })

  // ── releaseScrollStateMarker ─────────────────────────────────────────

  describe('releaseScrollStateMarker', () => {
    it('释放物理标记', () => {
      const marker = createMarker(42)
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker,
      }

      releaseScrollStateMarker(state)

      expect(marker.dispose).toHaveBeenCalledTimes(1)
      expect(state.firstVisibleLineMarker).toBeUndefined()
      expect(state.firstVisibleLogicalLineMarker).toBeUndefined()
    })

    it('物理标记和逻辑标记相同时只释放一次', () => {
      const marker = createMarker(42)
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker,
        firstVisibleLogicalLineMarker: marker,
      }

      releaseScrollStateMarker(state)

      expect(marker.dispose).toHaveBeenCalledTimes(1)
    })

    it('物理标记和逻辑标记不同时分别释放', () => {
      const marker1 = createMarker(42)
      const marker2 = createMarker(100)
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
        firstVisibleLineMarker: marker1,
        firstVisibleLogicalLineMarker: marker2,
      }

      releaseScrollStateMarker(state)

      expect(marker1.dispose).toHaveBeenCalledTimes(1)
      expect(marker2.dispose).toHaveBeenCalledTimes(1)
    })

    it('无标记时安全执行', () => {
      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      expect(() => releaseScrollStateMarker(state)).not.toThrow()
    })
  })

  // ── resumePendingFitScrollRestoreAfterFit ────────────────────────────

  describe('resumePendingFitScrollRestoreAfterFit', () => {
    it('无挂起恢复时返回 false', () => {
      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      expect(resumePendingFitScrollRestoreAfterFit(terminal)).toBe(false)
    })

    it('恢复成功后调用 onRestored', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const scrollToLineMock = terminal.scrollToLine as ReturnType<typeof vi.fn>
      // 始终失败以耗尽重试
      scrollToLineMock.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })

      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, {
        onRestored,
        shouldRestore: () => true,
      })

      // 耗尽 rAF 重试
      while (frameCallbacks.length > 0) {
        frameCallbacks.shift()?.(0)
      }

      expect(onRestored).not.toHaveBeenCalled()

      // 恢复 scrollToLine 使其成功
      scrollToLineMock.mockReset()
      scrollToLineMock.mockImplementation((line: number) => {
        (terminal.buffer.active as { viewportY: number }).viewportY = line
      })

      // 恢复挂起的恢复
      const result = resumePendingFitScrollRestoreAfterFit(terminal)

      expect(result).toBe(true)
      expect(onRestored).toHaveBeenCalledTimes(1)
      expect(terminal.buffer.active.viewportY).toBe(42)
    })

    it('shouldRestore 返回 false 时取消挂起恢复', () => {
      const frameCallbacks: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      vi.stubGlobal('cancelAnimationFrame', vi.fn())

      const terminal = createTerminal({ viewportY: 10, baseY: 100 })
      const scrollToLineMock = terminal.scrollToLine as ReturnType<typeof vi.fn>
      scrollToLineMock.mockImplementation(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })

      const state: ScrollState = {
        bufferType: 'normal',
        wasAtBottom: false,
        viewportY: 42,
        baseY: 100,
      }

      // 使用可变变量模拟 shouldRestore 从 true 变为 false
      let shouldRestoreValue = true
      restoreScrollStateAfterFit(terminal, state, {
        onRestored: vi.fn(),
        shouldRestore: () => shouldRestoreValue,
      })

      // 耗尽 rAF 重试
      while (frameCallbacks.length > 0) {
        frameCallbacks.shift()?.(0)
      }

      // 将 shouldRestore 改为 false，再次恢复时应被取消
      shouldRestoreValue = false

      const result = resumePendingFitScrollRestoreAfterFit(terminal)

      expect(result).toBe(false)
    })
  })
})
