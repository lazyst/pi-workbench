import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  // Electron 按 app.name 加单实例锁（见 src/main/index.ts requestSingleInstanceLock），
  // 并行 worker 启动多实例会在 firstWindow 前退出；串行执行规避冲突。
  workers: 1,
});
