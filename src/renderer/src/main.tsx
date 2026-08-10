import './theme';
// Monaco 本地化集成：必须在任何 Monaco 组件挂载前执行，以设置本地 worker 分发、
// 关闭 TS/JS 诊断（先前未被引入，导致走 CDN worker 且诊断未关，配合畸形 URI 触发
// "Could not find source file"）。作为副作用引入，无需在别处再次 import。
import './components/editor/monaco-setup';
import './styles/tokens.css';
import './styles/app.css';
import 'katex/dist/katex.min.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
