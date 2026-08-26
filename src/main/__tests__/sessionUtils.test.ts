import { describe, it, expect } from 'vitest';
import { decodeCwd, formatTimestamp, readSessionCwd, readSessionName, readGroupCwd } from '../sessionUtils';

describe('decodeCwd', () => {
  it('decodes a --C--Users-hcz-.pi-agent-- path', () => {
    expect(decodeCwd('--C--Users-hcz-.pi-agent--')).toBe('C:\\Users-hcz-.pi-agent');
  });

  it('decodes a --D--personal-agent_space-pi-tool-- path', () => {
    expect(decodeCwd('--D--personal-agent_space-pi-tool--')).toBe('D:\\personal-agent_space-pi-tool');
  });

  it('decodes nested -- separated segments', () => {
    expect(decodeCwd('--D--a--b--c--')).toBe('D:\\a\\b\\c');
  });

  it('handles C--Users--test without leading --', () => {
    expect(decodeCwd('C--Users--test')).toBe('C:\\Users\\test');
  });

  it('handles empty string', () => {
    expect(decodeCwd('')).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('formats a full ISO-ish filename', () => {
    expect(formatTimestamp('2026-07-03T19-07-11-857Z_abc.jsonl')).toBe('2026-07-03 19:07');
  });

  it('returns unchanged for non-matching filenames', () => {
    expect(formatTimestamp('notes.txt')).toBe('notes.txt');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('abc.jsonl')).toBe('abc.jsonl');
  });
});

describe('readSessionCwd', () => {
  it('reads cwd from the first line of a .jsonl file', () => {
    const file = __dirname + '/fixtures/read-session-cwd.jsonl';
    // Create inline test fixture
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"cwd":"/my/project"}\n{"type":"message"}');
    expect(readSessionCwd(file)).toBe('/my/project');
    fs.unlinkSync(file);
  });

  it('returns undefined for nonexistent file', () => {
    expect(readSessionCwd('/tmp/nonexistent.jsonl')).toBeUndefined();
  });

  it('returns undefined when first line has no cwd', () => {
    const file = __dirname + '/fixtures/no-cwd.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{"type":"message"}\n');
    expect(readSessionCwd(file)).toBeUndefined();
    fs.unlinkSync(file);
  });
});

describe('readSessionName', () => {
  it('reads the first user message as the session name', () => {
    const file = __dirname + '/fixtures/read-session-name.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'message', message: { role: 'user', content: 'Hello, please help me' }
    }));
    expect(readSessionName(file)).toBe('Hello, please help me');
    fs.unlinkSync(file);
  });

  it('returns undefined when the file has no user message', () => {
    const file = __dirname + '/fixtures/no-user-message.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'message', message: { role: 'assistant', content: 'Hello' }
    }));
    expect(readSessionName(file)).toBeUndefined();
    fs.unlinkSync(file);
  });

  it('returns undefined for nonexistent file', () => {
    expect(readSessionName('/tmp/nonexistent.jsonl')).toBeUndefined();
  });

  it('reads the latest session_info name when present (latest wins)', () => {
    const file = __dirname + '/fixtures/session-info.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'should be overridden' } }),
      JSON.stringify({ type: 'session_info', name: 'old name' }),
      JSON.stringify({ type: 'session_info', name: '最新会话名' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(readSessionName(file)).toBe('最新会话名');
    fs.unlinkSync(file);
  });

  it('reads session_info name even when it lies beyond the 64KB head', () => {
    const file = __dirname + '/fixtures/session-info-beyond-64k.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 一条 70KB 的 assistant 消息把 session_info 推到前 64KB 之外，
    // 模拟长会话中 /name 后 session_info 位于文件尾部。
    const padding = 'x'.repeat(70000);
    const lines = [
      JSON.stringify({ type: 'session', version: 3 }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'first user msg' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: padding }] } }),
      JSON.stringify({ type: 'session_info', name: '远端会话名' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(readSessionName(file)).toBe('远端会话名');
    fs.unlinkSync(file);
  });

  it('falls back to first user message when session_info has empty name', () => {
    const file = __dirname + '/fixtures/session-info-empty.jsonl';
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello world' } }),
      JSON.stringify({ type: 'session_info', name: '' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(readSessionName(file)).toBe('hello world');
    fs.unlinkSync(file);
  });
});

describe('readGroupCwd', () => {
  it('reads cwd from the first .jsonl file in the directory', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = __dirname + '/fixtures/group-cwd';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'first.jsonl'), '{"cwd":"/group/cwd"}');
    fs.writeFileSync(path.join(dir, 'second.jsonl'), '{"cwd":"/other"}');
    expect(readGroupCwd(dir)).toBe('/group/cwd');
    fs.rmSync(dir, { recursive: true });
  });

  it('returns undefined when directory has no .jsonl files', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = __dirname + '/fixtures/empty-group';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    expect(readGroupCwd(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });
});