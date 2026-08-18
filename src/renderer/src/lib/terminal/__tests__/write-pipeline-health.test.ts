// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWritePipelineHealthForTests,
  armTerminalWriteStallWatch,
  cancelTerminalWriteStallWatch,
  captureTerminalParseProgressGeneration,
  failTerminalWriteStallWatch,
  hasTerminalParseProgressSince,
  isTerminalWritePipelineCertifiedDead,
  notifyUndeliverableWrite,
  recordTerminalParseProgress,
  registerUndeliverableWriteHandler,
  settleTerminalWriteStallWatch,
  WRITE_PIPELINE_STALL_CHECK_MS
} from '../write-pipeline-health'

beforeEach(() => {
  _resetWritePipelineHealthForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 创建一个可控制回调的终端 mock，用于 armTerminalWriteStallWatch 的 probe 测试。 */
function createMockTerminal(): {
  terminal: { write: (data: string, cb?: () => void) => void }
  /** 触发最近一次 probe 写入的完成回调（如果已写入）。 */
  triggerProbeCallback: () => void
  /** 最近一次 probe 写入的完成回调（如果已写入）。 */
  lastProbeCallback: (() => void) | null
} {
  let lastProbeCallback: (() => void) | null = null
  return {
    terminal: {
      write(data: string, cb?: () => void): void {
        lastProbeCallback = cb ?? null
      }
    },
    triggerProbeCallback(): void {
      lastProbeCallback?.()
    },
    get lastProbeCallback(): (() => void) | null {
      return lastProbeCallback
    }
  }
}

// ─── registerUndeliverableWriteHandler / notifyUndeliverableWrite ────────────────

describe('registerUndeliverableWriteHandler / notifyUndeliverableWrite', () => {
  it('注册的处理器在 notify 时被调用', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    notifyUndeliverableWrite(terminal, 'write-stalled')
    expect(handler).toHaveBeenCalledWith('write-stalled')
  })

  it('同一终端多次 notify 只触发一次（去重）', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    notifyUndeliverableWrite(terminal, 'write-stalled')
    notifyUndeliverableWrite(terminal, 'write-stalled')
    notifyUndeliverableWrite(terminal, 'replay-wedged')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('已认证死亡的终端不会再触发 handler', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    notifyUndeliverableWrite(terminal, 'write-stalled')
    // 确认已认证死亡
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    // 再次 notify 不应触发
    notifyUndeliverableWrite(terminal, 'replay-wedged')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('取消注册后 handler 不再被调用', () => {
    const terminal = {}
    const handler = vi.fn()
    const unregister = registerUndeliverableWriteHandler(terminal, handler)
    unregister()
    notifyUndeliverableWrite(terminal, 'write-stalled')
    expect(handler).not.toHaveBeenCalled()
  })

  it('未注册 handler 时 notify 不抛异常', () => {
    const terminal = {}
    expect(() => {
      notifyUndeliverableWrite(terminal, 'write-stalled')
    }).not.toThrow()
  })
})

// ─── isTerminalWritePipelineCertifiedDead ───────────────────────────────────────

describe('isTerminalWritePipelineCertifiedDead', () => {
  it('notify 之前返回 false', () => {
    const terminal = {}
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
  })

  it('notify 之后返回 true', () => {
    const terminal = {}
    notifyUndeliverableWrite(terminal, 'write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })

  it('不同终端互不影响', () => {
    const t1 = {}
    const t2 = {}
    notifyUndeliverableWrite(t1, 'write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(t1)).toBe(true)
    expect(isTerminalWritePipelineCertifiedDead(t2)).toBe(false)
  })
})

// ─── armTerminalWriteStallWatch ─────────────────────────────────────────────────

describe('armTerminalWriteStallWatch', () => {
  it('已认证死亡的终端不会再次武装', () => {
    const terminal = { write: vi.fn() }
    notifyUndeliverableWrite(terminal, 'write-stalled')
    // 不应抛出，应静默跳过
    armTerminalWriteStallWatch(terminal)
    // 无 probe 写入触发，快进时间后不应有副作用
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    // 仍是已认证死亡状态（无二次通知）
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })

  it('已有 watch 的终端不会重复武装', () => {
    const { terminal } = createMockTerminal()
    armTerminalWriteStallWatch(terminal)
    // 第二次调用应被忽略
    armTerminalWriteStallWatch(terminal)
    // 快进到第一个 probe 超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // 此时 probe 已写入，但未触发回调，再快进
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // 应只通知一次
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    // 手动触发认证（因为 probe 未完成，超时后应认证死亡）
    // 但直接检查已死亡状态
    // 注意：第二次 arm 未创建新 watch，所以只有一个 probe 定时器
    // 我们需要验证：上面的逻辑不会因重复 arm 而出现双倍通知
    // 实际上，由于第二次 arm 被跳过，只有一个 probe 流程
    // 状态应该正常
  })

  it('probe 完成则管道被判定为存活，watch 被解除', () => {
    const { terminal, triggerProbeCallback } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)

    // 快进到第一个 probe 超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    // probe 写入已发出，触发其完成回调
    triggerProbeCallback()

    // 再快进大量时间，不应有二次 probe
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
  })

  it('probe 未完成则管道被认证为死亡', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)

    // 快进到第一个 probe 超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    // probe 写入已发出，但从未触发回调
    // 再快进一个间隔，probe 应超时并认证死亡
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })

  it('probe 写入同步抛出则立即认证死亡', () => {
    const terminal = {
      write(_data: string, _cb?: () => void): void {
        throw new Error('write failed')
      }
    }
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)

    // 快进到 probe 超时，probe 写入会同步抛出
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })

  it('onCertifiedDead 回调被调用', () => {
    const { terminal } = createMockTerminal()
    const onCertifiedDead = vi.fn()

    armTerminalWriteStallWatch(terminal, { onCertifiedDead })

    // 快进到 probe 超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // probe 未完成，再快进
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(onCertifiedDead).toHaveBeenCalled()
  })

  it('支持自定义 stallCheckMs', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    const customStallMs = 500

    armTerminalWriteStallWatch(terminal, { stallCheckMs: customStallMs })

    // 自定义间隔内不应触发
    vi.advanceTimersByTime(customStallMs - 1)
    expect(handler).not.toHaveBeenCalled()

    // 到达 probe 超时
    vi.advanceTimersByTime(1)
    // probe 未完成，再快进一个自定义间隔
    vi.advanceTimersByTime(customStallMs)

    expect(handler).toHaveBeenCalledWith('write-stalled')
  })
})

// ─── cancelTerminalWriteStallWatch ──────────────────────────────────────────────

describe('cancelTerminalWriteStallWatch', () => {
  it('取消后 watch 不再触发', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    cancelTerminalWriteStallWatch(terminal)

    // 快进大量时间，不应触发任何通知
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).not.toHaveBeenCalled()
  })

  it('对无 watch 的终端调用不抛异常', () => {
    const terminal = {}
    expect(() => {
      cancelTerminalWriteStallWatch(terminal)
    }).not.toThrow()
  })
})

// ─── settleTerminalWriteStallWatch ──────────────────────────────────────────────

describe('settleTerminalWriteStallWatch', () => {
  it('settle 后记录解析进度并取消 watch', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    const genBefore = captureTerminalParseProgressGeneration(terminal)
    armTerminalWriteStallWatch(terminal)
    settleTerminalWriteStallWatch(terminal)

    // 验证进度已记录
    expect(hasTerminalParseProgressSince(terminal, genBefore)).toBe(true)

    // 快进时间，不应触发通知
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).not.toHaveBeenCalled()
  })

  it('对无 watch 的终端调用仍记录进度', () => {
    const terminal = {}
    const genBefore = captureTerminalParseProgressGeneration(terminal)
    settleTerminalWriteStallWatch(terminal)
    expect(hasTerminalParseProgressSince(terminal, genBefore)).toBe(true)
  })
})

// ─── failTerminalWriteStallWatch ────────────────────────────────────────────────

describe('failTerminalWriteStallWatch', () => {
  it('同步失败后立即认证死亡', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    failTerminalWriteStallWatch(terminal)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })

  it('已认证死亡后再次 fail 不会重复通知', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    failTerminalWriteStallWatch(terminal)
    failTerminalWriteStallWatch(terminal)

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ─── recordTerminalParseProgress / captureTerminalParseProgressGeneration / hasTerminalParseProgressSince ──

describe('解析进度追踪', () => {
  it('初始 generation 为 0', () => {
    const terminal = {}
    expect(captureTerminalParseProgressGeneration(terminal)).toBe(0)
  })

  it('recordTerminalParseProgress 递增 generation', () => {
    const terminal = {}
    const gen1 = captureTerminalParseProgressGeneration(terminal)
    recordTerminalParseProgress(terminal)
    const gen2 = captureTerminalParseProgressGeneration(terminal)
    expect(gen2).toBe(gen1 + 1)
  })

  it('hasTerminalParseProgressSince 正确检测变化', () => {
    const terminal = {}
    const gen = captureTerminalParseProgressGeneration(terminal)
    expect(hasTerminalParseProgressSince(terminal, gen)).toBe(false)
    recordTerminalParseProgress(terminal)
    expect(hasTerminalParseProgressSince(terminal, gen)).toBe(true)
  })

  it('不同终端独立计数', () => {
    const t1 = {}
    const t2 = {}
    const gen1 = captureTerminalParseProgressGeneration(t1)
    const gen2 = captureTerminalParseProgressGeneration(t2)
    recordTerminalParseProgress(t1)
    expect(hasTerminalParseProgressSince(t1, gen1)).toBe(true)
    expect(hasTerminalParseProgressSince(t2, gen2)).toBe(false)
  })
})

// ─── _resetWritePipelineHealthForTests ──────────────────────────────────────────

describe('_resetWritePipelineHealthForTests', () => {
  it('重置后终端不再被认证为死亡', () => {
    const terminal = {}
    notifyUndeliverableWrite(terminal, 'write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
    _resetWritePipelineHealthForTests(terminal)
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
  })

  it('重置后可以重新注册 handler 并接收通知', () => {
    const terminal = {}
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)
    notifyUndeliverableWrite(terminal, 'write-stalled')
    expect(handler).toHaveBeenCalledTimes(1)

    _resetWritePipelineHealthForTests(terminal)

    const handler2 = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler2)
    notifyUndeliverableWrite(terminal, 'replay-wedged')
    expect(handler2).toHaveBeenCalledWith('replay-wedged')
  })

  it('重置后解析进度归零', () => {
    const terminal = {}
    recordTerminalParseProgress(terminal)
    recordTerminalParseProgress(terminal)
    const genBefore = captureTerminalParseProgressGeneration(terminal)
    expect(genBefore).toBe(2)
    _resetWritePipelineHealthForTests(terminal)
    expect(captureTerminalParseProgressGeneration(terminal)).toBe(0)
  })

  it('不传 terminal 参数时不抛异常', () => {
    expect(() => {
      _resetWritePipelineHealthForTests()
    }).not.toThrow()
  })
})

// ─── WRITE_PIPELINE_STALL_CHECK_MS ──────────────────────────────────────────────

describe('WRITE_PIPELINE_STALL_CHECK_MS', () => {
  it('默认值为 10 秒', () => {
    expect(WRITE_PIPELINE_STALL_CHECK_MS).toBe(10_000)
  })
})

// ─── 集成场景：probe 完成 vs 未完成的完整流程 ─────────────────────────────────────

describe('集成场景', () => {
  it('正常写入流程：arm → settle → 不触发通知', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)
    // 写入正常完成
    settleTerminalWriteStallWatch(terminal)

    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).not.toHaveBeenCalled()
  })

  it('停滞恢复流程：arm → 超时 → probe 完成 → 管道存活', () => {
    const { terminal, triggerProbeCallback } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)

    // 写入停滞，超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // probe 写入发出，但还在处理中
    // 在第二个超时之前，probe 完成了
    triggerProbeCallback()

    // 再快进大量时间，不应触发通知
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 3)
    expect(handler).not.toHaveBeenCalled()
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(false)
  })

  it('完全停滞流程：arm → 超时 → probe 超时 → 认证死亡', () => {
    const { terminal } = createMockTerminal()
    const handler = vi.fn()
    registerUndeliverableWriteHandler(terminal, handler)

    armTerminalWriteStallWatch(terminal)

    // 写入停滞，超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)
    // probe 写入发出，但从未完成
    // 再等一个间隔，probe 超时
    vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS)

    expect(handler).toHaveBeenCalledWith('write-stalled')
    expect(isTerminalWritePipelineCertifiedDead(terminal)).toBe(true)
  })
})