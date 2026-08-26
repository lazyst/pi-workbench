// Monaco 本地化集成骨架（非 CDN）。
// 参考 orca `lib/monaco-setup.ts`，为 pi 的最小骨架：仅建立本地打包与
// worker 分发、关掉 TS/JS 校验、开 jsx: Preserve，挂载 loader 本地实例。
//
// 核心设计决策：使用 Monaco 内置 vs-dark/vs 主题（不支持自定义主题），
// 编辑器背景色通过 CSS --editor-surface 变量 + app.css 中的选择器覆盖。
// 这与 orca 的做法一致（orca 也只使用内置主题），避免自定义主题注册
// 与 @monaco-editor/react 内部 theme 处理机制之间的冲突。
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// monaco 0.56+：`monaco.languages.typescript` 已标记 deprecated，
// 改为使用顶层 `monaco.typescript`。
const { typescript: monacoTS } = monaco;

// 按 language label 分发 worker，避免走 CDN loader。
// monaco 的 `editor.api.d.ts` 用 `declare global { let MonacoEnvironment }` 声明（仅类型，
// 运行时不产生绑定）。在 ESM（严格模式）下对未声明标识符直接赋值会抛 ReferenceError，
// 故必须显式挂到 globalThis（cast 以兼容 monaco 的类型声明，运行时等价于裸全局赋值）。
(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Why: Monaco 在 pi 中是预览/阅读表面而非 IDE——用户在自己 IDE 里改真实代码。
// 沙箱 TS worker 无法解析工程内 import，语义/语法校验会产生大量 false positive
// （未解析模块、未用 import 灰显、缺失名等）。关掉三类诊断，只保留着色（tokenization），
// 这才是阅读场景真正有用的能力。
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true,
};
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

// Why: .tsx/.jsx 在 Monaco 注册表里复用 'typescript'/'javascript' 语言 id（没有
// 独立的 'typescriptreact' id），故这两个 defaults 的 compilerOptions 对二者通用。
// 不开 jsx，worker 会对每个 JSX 标签报 TS17004 "Cannot use JSX unless the
// '--jsx' flag is provided"。Preserve 模式足以解析，且不强制 emit（pi 从不 emit）。
monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve,
});
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve,
});

// 配置 Monaco 使用本地打包的编辑器，而非 CDN。
loader.config({ monaco });

// 导出 monaco 实例供组件使用。
export { monaco };