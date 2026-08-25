import { describe, it, expect } from 'vitest';
import { clampSidebarWidth, SIDEBAR_MIN_WIDTH, clampRightPanelWidth, RIGHT_PANEL_MIN_WIDTH } from '../components/sidebarGeometry';

describe('clampSidebarWidth', () => {
  it('floors at the absolute 200px minimum', () => {
    expect(clampSidebarWidth(100, 1000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(0, 1000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(-50, 1000)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('caps at 60% of the window width', () => {
    expect(clampSidebarWidth(800, 1000)).toBe(600);
    expect(clampSidebarWidth(700, 1000)).toBe(600); // 700 > 600 → clamp to ceiling
    expect(clampSidebarWidth(601, 1000)).toBe(600);
  });

  it('passes through in-range widths', () => {
    expect(clampSidebarWidth(400, 1000)).toBe(400);
    expect(clampSidebarWidth(280, 1000)).toBe(280);
  });

  it('never lets the floor exceed the ceiling on a tiny window', () => {
    // 300px 窗口 → 60% = 180 → max(200, 180) = 200；夹取后仍是 200
    expect(clampSidebarWidth(500, 300)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(100, 300)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe('clampRightPanelWidth', () => {
  it('floors at the absolute 200px minimum', () => {
    expect(clampRightPanelWidth(100, 1000)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(0, 1000)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(-50, 1000)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('caps at 60% of the window width', () => {
    expect(clampRightPanelWidth(800, 1000)).toBe(600);
    expect(clampRightPanelWidth(601, 1000)).toBe(600); // 601 > 600 → clamp to ceiling
    expect(clampRightPanelWidth(700, 1000)).toBe(600);
  });

  it('passes through in-range widths', () => {
    expect(clampRightPanelWidth(280, 1000)).toBe(280);
    expect(clampRightPanelWidth(400, 1000)).toBe(400);
  });

  it('never lets the floor exceed the ceiling on a tiny window', () => {
    // 300px 窗口 → 60% = 180 → max(200, 180) = 200；夹取后仍是 200
    expect(clampRightPanelWidth(500, 300)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(100, 300)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });
});
