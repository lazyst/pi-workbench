import { describe, it, expect } from 'vitest';
import { defaultConfig, parseConfig, mergeConfig, clampFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../config';

describe('config (pure)', () => {
  it('defaultConfig has the expected shape', () => {
    const c = defaultConfig();
    expect(c.theme).toBe('dark');
    expect(c.themeFamily).toBe('github');
    expect(c.pinnedDirs).toEqual([]);
    expect(c.window.maximized).toBe(false);
    expect(c.window.bounds.width).toBe(1100);
    expect(c.sidebarWidth).toBe(280);
    expect(c.closeBehavior).toBe('minimize-to-tray');
  });

  it('parseConfig returns defaults for null/empty', () => {
    expect(parseConfig(null)).toEqual(defaultConfig());
    expect(parseConfig('')).toEqual(defaultConfig());
  });

  it('parseConfig falls back to defaults on corrupt JSON without throwing', () => {
    const c = parseConfig('{ not valid json');
    expect(c).toEqual(defaultConfig());
  });

  it('parseConfig merges a valid partial over defaults', () => {
    const c = parseConfig(JSON.stringify({ theme: 'light', sidebarWidth: 320 }));
    expect(c.theme).toBe('light');
    expect(c.sidebarWidth).toBe(320);
    expect(c.closeBehavior).toBe('minimize-to-tray'); // untouched
    expect(c.window.bounds.width).toBe(1100); // untouched
  });

  it('defaultConfig includes fontSize default 15', () => {
    expect(defaultConfig().fontSize).toBe(15);
  });

  it('defaultConfig includes integrated terminal fields with correct defaults', () => {
    const c = defaultConfig();
    expect(c.defaultTerminalProfile).toBeNull();
    expect(c.terminalProfiles).toEqual({});
  });

  it('parseConfig clamps out-of-range / invalid fontSize to defaults or bounds', () => {
    // 合法值透传
    expect(parseConfig(JSON.stringify({ fontSize: 20 })).fontSize).toBe(20);
    // 越界被夹到边界
    expect(parseConfig(JSON.stringify({ fontSize: 999 })).fontSize).toBe(FONT_SIZE_MAX);
    expect(parseConfig(JSON.stringify({ fontSize: -5 })).fontSize).toBe(FONT_SIZE_MIN);
    // 损坏/非数字回退默认
    expect(parseConfig(JSON.stringify({ fontSize: 'big' })).fontSize).toBe(15);
    expect(parseConfig('not json').fontSize).toBe(15);
  });

  it('clampFontSize rounds and clamps to [FONT_SIZE_MIN, FONT_SIZE_MAX]', () => {
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(FONT_SIZE_MIN - 1)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(FONT_SIZE_MAX + 1)).toBe(FONT_SIZE_MAX);
    expect(clampFontSize(NaN)).toBe(15);
    expect(clampFontSize('x')).toBe(15);
  });
});
