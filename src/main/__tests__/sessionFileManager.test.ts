import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionFileManager, decodeCwd, formatTimestamp, readSessionCwd, readSessionName, readGroupCwd } from '../sessionFileManager';
import type { TerminalDebugSnapshot } from '../unifiedTerminalPool';

// ============================================================================
//  SessionFileManager —— 集成测试（真实临时目录）
// ============================================================================
describe('SessionFileManager', () => {
  // --------------------------------------------------------------------------
  //  listFiles
  // --------------------------------------------------------------------------
  describe('listFiles', () => {
    it('returns empty array when sessionsDir does not exist', () => {
      const manager = new SessionFileManager('/tmp/this/does/not/exist/xyz');
      expect(manager.listFiles()).toEqual([]);
    });

    it('returns empty array when sessionsDir is empty', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-list-'));
      const manager = new SessionFileManager(dir);
      expect(manager.listFiles()).toEqual([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lists .jsonl files grouped by subdirectory', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-list-'));
      const groupDir = path.join(root, '--C--my-project--');
      fs.mkdirSync(groupDir, { recursive: true });

      const f1 = path.join(groupDir, '2026-07-03T19-07-11-857Z_abc.jsonl');
      const f2 = path.join(groupDir, '2026-07-04T10-00-00-000Z_def.jsonl');
      fs.writeFileSync(f1, JSON.stringify({ cwd: 'C:\\my-project' }) + '\n');
      fs.writeFileSync(f2, JSON.stringify({ cwd: 'C:\\my-project' }) + '\n');

      const manager = new SessionFileManager(root);
      const groups = manager.listFiles();

      expect(groups).toHaveLength(1);
      expect(groups[0].cwd).toBe('C:\\my-project');
      expect(groups[0].sessions).toHaveLength(2);
      expect(groups[0].sessions[0].key).toBe(f1);
      expect(groups[0].sessions[1].key).toBe(f2);

      fs.rmSync(root, { recursive: true, force: true });
    });

    it('skips non-.jsonl files and non-directory entries', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-list-'));
      const groupDir = path.join(root, 'some-group');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'notes.txt'), 'hello');
      fs.writeFileSync(path.join(groupDir, 'session.jsonl'), JSON.stringify({ cwd: '/cwd' }) + '\n');
      // 同级放一个文件而非目录
      fs.writeFileSync(path.join(root, 'not-a-dir.txt'), '');

      const manager = new SessionFileManager(root);
      const groups = manager.listFiles();

      expect(groups).toHaveLength(1);
      expect(groups[0].sessions).toHaveLength(1);

      fs.rmSync(root, { recursive: true, force: true });
    });

    it('decodes cwd from directory name when .jsonl files have no cwd field', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-list-'));
      const encDir = '--C--Users--user--project--'; // C:\Users\user\project
      const groupDir = path.join(root, encDir);
      fs.mkdirSync(groupDir, { recursive: true });
      const f1 = path.join(groupDir, 'session.jsonl');
      // Write a .jsonl with no cwd field (but valid JSON)
      fs.writeFileSync(f1, JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }) + '\n');

      const manager = new SessionFileManager(root);
      const groups = manager.listFiles();

      expect(groups).toHaveLength(1);
      expect(groups[0].cwd).toBe('C:\\Users\\user\\project');

      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  //  dirForCwd
  // --------------------------------------------------------------------------
  describe('dirForCwd', () => {
    it('returns undefined when sessionsDir does not exist', () => {
      const manager = new SessionFileManager('/tmp/nope');
      expect(manager.dirForCwd('/cwd')).toBeUndefined();
    });

    it('returns the directory for a matching cwd', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-dfc-'));
      const groupDir = path.join(root, '--C--my-project--');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 's.jsonl'), JSON.stringify({ cwd: 'C:\\my-project' }) + '\n');

      const manager = new SessionFileManager(root);
      const found = manager.dirForCwd('C:\\my-project');
      expect(found).toBe(groupDir);

      fs.rmSync(root, { recursive: true, force: true });
    });

    it('falls back to decodeCwd when .jsonl files have no cwd', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-dfc-'));
      const encDir = '--C--Users--user--project--';
      const groupDir = path.join(root, encDir);
      fs.mkdirSync(groupDir, { recursive: true });

      const manager = new SessionFileManager(root);
      const found = manager.dirForCwd('C:\\Users\\user\\project');
      expect(found).toBe(groupDir);

      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  //  deleteSession（含路径穿越守卫）
  // --------------------------------------------------------------------------
  describe('deleteSession', () => {
    it('deletes a .jsonl file inside sessionsDir', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-del-'));
      const file = path.join(root, 'session.jsonl');
      fs.writeFileSync(file, '{}');

      const manager = new SessionFileManager(root);
      manager.deleteSession(file);

      expect(fs.existsSync(file)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('refuses to delete files outside sessionsDir (path traversal)', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-del-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-out-'));
      const file = path.join(outside, 'evil.jsonl');
      fs.writeFileSync(file, '{}');

      const manager = new SessionFileManager(root);
      manager.deleteSession(file);

      expect(fs.existsSync(file)).toBe(true); // 未被删除
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('ignores non-.jsonl keys', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-del-'));
      const file = path.join(root, 'notes.txt');
      fs.writeFileSync(file, 'hello');

      const manager = new SessionFileManager(root);
      manager.deleteSession(file);

      expect(fs.existsSync(file)).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('handles missing file without throwing', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-del-'));
      const manager = new SessionFileManager(root);
      expect(() => manager.deleteSession(path.join(root, 'nonexistent.jsonl'))).not.toThrow();
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  //  deleteMany
  // --------------------------------------------------------------------------
  describe('deleteMany', () => {
    it('deletes multiple .jsonl files', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-multi-'));
      const a = path.join(root, 'a.jsonl');
      const b = path.join(root, 'b.jsonl');
      fs.writeFileSync(a, '{}');
      fs.writeFileSync(b, '{}');

      const manager = new SessionFileManager(root);
      manager.deleteMany([a, b]);

      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('skips out-of-directory keys silently', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-multi-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-out-'));
      const evil = path.join(outside, 'evil.jsonl');
      fs.writeFileSync(evil, '{}');

      const manager = new SessionFileManager(root);
      manager.deleteMany([evil]);
      expect(fs.existsSync(evil)).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  //  clearDirectory
  // --------------------------------------------------------------------------
  describe('clearDirectory', () => {
    it('deletes all .jsonl files in the cwd folder and removes the empty folder', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-clr-'));
      const groupDir = path.join(root, 'grp');
      fs.mkdirSync(groupDir);
      const a = path.join(groupDir, 'a.jsonl');
      const b = path.join(groupDir, 'b.jsonl');
      fs.writeFileSync(a, JSON.stringify({ cwd: '/my/cwd' }) + '\n');
      fs.writeFileSync(b, JSON.stringify({ cwd: '/my/cwd' }) + '\n');

      const manager = new SessionFileManager(root);
      manager.clearDirectory('/my/cwd');

      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
      // 空文件夹应被移除
      expect(fs.existsSync(groupDir)).toBe(false);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('no-ops when no directory matches the cwd', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-clr-'));
      const manager = new SessionFileManager(root);
      expect(() => manager.clearDirectory('/nonexistent/cwd')).not.toThrow();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('leaves non-.jsonl files in the group directory', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-clr-'));
      const groupDir = path.join(root, 'grp');
      fs.mkdirSync(groupDir);
      const note = path.join(groupDir, 'readme.txt');
      const session = path.join(groupDir, 's.jsonl');
      fs.writeFileSync(note, 'hello');
      fs.writeFileSync(session, JSON.stringify({ cwd: '/my/cwd' }) + '\n');

      const manager = new SessionFileManager(root);
      manager.clearDirectory('/my/cwd');

      expect(fs.existsSync(session)).toBe(false);
      expect(fs.existsSync(note)).toBe(true); // 非 .jsonl 保留
      // 目录非空，不移除
      expect(fs.existsSync(groupDir)).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  //  debugInfo
  // --------------------------------------------------------------------------
  describe('debugInfo', () => {
    it('returns count and pids of running entries', () => {
      const manager = new SessionFileManager('/tmp');
      const snapshot: TerminalDebugSnapshot[] = [
        { id: 'a', type: 'pi', status: 'running', pid: 100 },
        { id: 'b', type: 'shell', status: 'running', pid: 200 },
        { id: 'c', type: 'pi', status: 'dead', pid: 300 },
      ];
      const info = manager.debugInfo(snapshot);
      expect(info.count).toBe(2);
      expect(info.pids).toEqual([100, 200]);
    });

    it('filters out pids <= 0', () => {
      const manager = new SessionFileManager('/tmp');
      const snapshot: TerminalDebugSnapshot[] = [
        { id: 'a', type: 'pi', status: 'running', pid: -1 },
      ];
      const info = manager.debugInfo(snapshot);
      expect(info.count).toBe(1);
      expect(info.pids).toEqual([]);
    });
  });
});

// ============================================================================
//  工具函数
// ============================================================================
describe('decodeCwd', () => {
  it('decodes a basic encoded path', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toBe('C:\\Users-hcz-.pi-agent');
  });

  it('restores Windows drive-letter paths (colon stripped in encoding)', () => {
    expect(decodeCwd('--D--personal-agent_space-pi-tool--')).toBe('D:\\personal-agent_space-pi-tool');
  });

  it('handles multi-level paths', () => {
    expect(decodeCwd('--D--a--b--c--')).toBe('D:\\a\\b\\c');
  });

  it('handles paths without leading/trailing --', () => {
    expect(decodeCwd('C--Users--test')).toBe('C:\\Users\\test');
  });

  it('returns empty string unchanged', () => {
    expect(decodeCwd('')).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('formats a standard timestamp filename', () => {
    expect(formatTimestamp('2026-07-03T19-07-11-857Z_abc.jsonl')).toBe('2026-07-03 19:07');
  });

  it('returns the filename unchanged when it does not match the pattern', () => {
    expect(formatTimestamp('notes.txt')).toBe('notes.txt');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('abc.jsonl')).toBe('abc.jsonl');
  });
});

describe('readSessionCwd', () => {
  it('reads cwd from the first JSON line', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rsc-')), 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ cwd: '/my/project' }) + '\n');
    expect(readSessionCwd(file)).toBe('/my/project');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('returns undefined for missing file', () => {
    expect(readSessionCwd('/tmp/nonexistent.jsonl')).toBeUndefined();
  });

  it('returns undefined when first line is not valid JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rsc-')), 's.jsonl');
    fs.writeFileSync(file, 'not-json\n');
    expect(readSessionCwd(file)).toBeUndefined();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('readSessionName', () => {
  it('extracts the first user message as the session name', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rsn-')), 's.jsonl');
    const content = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hello, please help' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Sure!' } }),
    ].join('\n');
    fs.writeFileSync(file, content);
    expect(readSessionName(file)).toBe('Hello, please help');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('returns undefined when there is no user message', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rsn-')), 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'hi' } }) + '\n');
    expect(readSessionName(file)).toBeUndefined();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('truncates user messages longer than 80 characters', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rsn-')), 's.jsonl');
    const longMsg = 'a'.repeat(200);
    fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: longMsg } }) + '\n');
    const name = readSessionName(file);
    expect(name).toBe('a'.repeat(80));
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('returns undefined for missing file', () => {
    expect(readSessionName('/tmp/nonexistent.jsonl')).toBeUndefined();
  });
});

describe('readGroupCwd', () => {
  it('reads cwd from the first .jsonl in the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rgc-'));
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ cwd: '/group/cwd' }) + '\n');
    expect(readGroupCwd(dir)).toBe('/group/cwd');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for empty directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfm-rgc-'));
    expect(readGroupCwd(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
