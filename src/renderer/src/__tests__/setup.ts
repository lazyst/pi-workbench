import '@testing-library/jest-dom';

// 在所有测试中 mock @xterm/addon-fit，避免 jsdom 下 FitAddon.proposeDimensions
// 因 term.dimensions 为 undefined 而抛出 "Cannot read properties of undefined"。
// 各测试可按需通过 hoist 变量或 vi.spyOn 覆盖 proposeDimensions 返回值。
import { vi } from 'vitest';
vi.mock('@xterm/addon-fit', () => {
  class FitAddonMock {
    _terminal: any = null;
    activate(t: any) { this._terminal = t; }
    dispose() {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
    fit() {
      const d = this.proposeDimensions();
      if (d && this._terminal) { this._terminal.resize(d.cols, d.rows); }
    }
  }
  return { FitAddon: FitAddonMock };
});

// --- Minimal jsdom polyfills for xterm.js (renderer-only component) ---
// These are only relevant for DOM test environments. Guard on a real DOM so
// this shared setup file is also safe for the node-environment (main process)
// test files. They must run here (the vitest setup file) because they are
// needed before the test's module-eval/useEffect run:
//  * getContext is called at @xterm/xterm *import time*; jsdom has no canvas backend.
//  * window.matchMedia is called by xterm's CoreBrowserService at term.open() time.
//  * ResizeObserver is referenced by addons/renderer lifecycle.
// The stubs are inert (no-op) and do not weaken the test's assertions.
if (typeof document !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  const ctxStub = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (prop === 'canvas') return undefined;
      return () => {};
    },
    set: () => true,
  });
  const canvasProto = document.createElement('canvas').constructor.prototype;
  Object.defineProperty(canvasProto, 'getContext', { configurable: true, value: () => ctxStub });
}
