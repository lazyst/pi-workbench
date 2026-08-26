import path from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { external: ['node-pty'] } } },
  preload: { build: { rollupOptions: { external: ['node-pty'] } } },
  renderer: {
    resolve: {
      alias: {
        '@': '/src/renderer/src',
        // monaco 0.56 的 package.json exports 仅暴露 esm/vs/*，聚合主题 CSS 只在 min/ 下，
        // 用绝对路径绕过 exports 限制，让 vite 直接读取物理 CSS 文件。
        'monaco-editor/min/vs/editor/editor.main.css': path.join(
          process.cwd(),
          'node_modules/monaco-editor/min/vs/editor/editor.main.css',
        ),
      },
    },
    plugins: [react()],
    // Monaco worker 以 `?worker` 导入，需以 ES module 格式产出，
    // 否则 electron 渲染进程加载 worker 时会因格式不匹配报错。
    worker: {
      format: 'es',
    },
  },
});
