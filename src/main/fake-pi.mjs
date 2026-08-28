// src/main/fake-pi.mjs
// Stand-in for `pi` in automated E2E: prints a heartbeat every second,
// echoes stdin lines, and on the FIRST stdin line writes a real .jsonl session
// file (so the fs.watch -> session:index promotion path is exercisable), then
// exits cleanly on SIGTERM. No network / model / credentials.
import * as fs from 'node:fs';
import * as path from 'node:path';

let n = 0;
const timer = setInterval(() => { n += 1; process.stdout.write(`tick ${n}\n`); }, 1000);
process.stdout.write('fake-pi ready\n');

let wroteSession = false;
process.stdin.on('data', (d) => {
  const s = d.toString();
  process.stdout.write(`echo: ${s}`);
  if (!wroteSession) {
    wroteSession = true;
    const dir = process.env.PI_WORKBENCH_SESSIONS_DIR;
    if (dir) {
      const group = path.join(dir, encodeURIComponent(process.cwd()));
      fs.mkdirSync(group, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(group, `${stamp}_e2e.jsonl`);
      const header = JSON.stringify({ type: 'session', version: 3, id: 'e2e', timestamp: stamp, cwd: process.cwd() });
      const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: s.trim() }] } });
      fs.writeFileSync(file, header + '\n' + msg + '\n');
    }
  }
});

function shutdown() {
  clearInterval(timer);
  process.stdout.write('terminated\n');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
