import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AckDataBufferer } from '../components/ackDataBufferer';
import { FlowControlConstants } from '../../../main/backpressure';

describe('AckDataBufferer (aligned with VS Code AckDataBufferer)', () => {
  let ackCallback: ReturnType<typeof vi.fn>;
  let bufferer: AckDataBufferer;

  beforeEach(() => {
    ackCallback = vi.fn();
    bufferer = new AckDataBufferer(ackCallback);
  });

  it('does not send ack when under CharCountAckSize', () => {
    bufferer.ack(100);
    expect(ackCallback).not.toHaveBeenCalled();
  });

  it('sends ack when accumulated chars exceed CharCountAckSize', () => {
    bufferer.ack(FlowControlConstants.CharCountAckSize + 1);
    expect(ackCallback).toHaveBeenCalledTimes(1);
    expect(ackCallback).toHaveBeenCalledWith(FlowControlConstants.CharCountAckSize);
  });

  it('sends multiple acks when accumulated chars exceed CharCountAckSize multiple times', () => {
    const total = FlowControlConstants.CharCountAckSize * 3 + 1000;
    bufferer.ack(total);
    expect(ackCallback).toHaveBeenCalledTimes(3);
    expect(ackCallback).toHaveBeenCalledWith(FlowControlConstants.CharCountAckSize);
    // 剩余 1000 未达阈值，等待下次 ack 或 flush
  });

  it('uses > threshold so exact boundary does not trigger ack until exceeded', () => {
    // 累积两次刚好到阈值
    bufferer.ack(FlowControlConstants.CharCountAckSize / 2);
    expect(ackCallback).not.toHaveBeenCalled();
    bufferer.ack(FlowControlConstants.CharCountAckSize / 2);
    expect(ackCallback).not.toHaveBeenCalled();
    // 再累积超过阈值
    bufferer.ack(1);
    expect(ackCallback).toHaveBeenCalledTimes(1);
    expect(ackCallback).toHaveBeenCalledWith(FlowControlConstants.CharCountAckSize);
  });

  it('flush forces remaining chars out even when under threshold', () => {
    bufferer.ack(999);
    expect(ackCallback).not.toHaveBeenCalled();
    bufferer.flush();
    expect(ackCallback).toHaveBeenCalledTimes(1);
    expect(ackCallback).toHaveBeenCalledWith(999);
  });

  it('flush is idempotent when no chars accumulated', () => {
    bufferer.flush();
    expect(ackCallback).not.toHaveBeenCalled();
    bufferer.flush();
    expect(ackCallback).not.toHaveBeenCalled();
  });

  it('dispose flushes remaining chars and marks as disposed', () => {
    bufferer.ack(500);
    bufferer.dispose();
    expect(ackCallback).toHaveBeenCalledWith(500);
    expect(bufferer.disposed).toBe(true);
    expect(bufferer.unsentCharCount).toBe(0);
  });

  it('ack after dispose is silently ignored', () => {
    bufferer.dispose();
    ackCallback.mockClear();
    bufferer.ack(FlowControlConstants.CharCountAckSize);
    expect(ackCallback).not.toHaveBeenCalled();
  });

  it('handles zero and negative charCount gracefully', () => {
    bufferer.ack(0);
    bufferer.ack(-100);
    expect(ackCallback).not.toHaveBeenCalled();
  });

  it('unsentCharCount tracks accumulated chars', () => {
    expect(bufferer.unsentCharCount).toBe(0);
    bufferer.ack(1000);
    expect(bufferer.unsentCharCount).toBe(1000);
    bufferer.ack(2000);
    expect(bufferer.unsentCharCount).toBe(3000);
    bufferer.flush();
    expect(bufferer.unsentCharCount).toBe(0);
  });

  it('refills accumulated chars after partial flush', () => {
    bufferer.ack(FlowControlConstants.CharCountAckSize + 1); // → sends one ack, leaves 1
    expect(ackCallback).toHaveBeenCalledTimes(1);
    bufferer.ack(FlowControlConstants.CharCountAckSize + 500); // → sends one ack, leaves 501
    expect(ackCallback).toHaveBeenCalledTimes(2);
    expect(bufferer.unsentCharCount).toBe(501);
    bufferer.flush(); // → sends remaining 501
    expect(ackCallback).toHaveBeenCalledTimes(3);
    expect(ackCallback).toHaveBeenLastCalledWith(501);
    expect(bufferer.unsentCharCount).toBe(0);
  });
});