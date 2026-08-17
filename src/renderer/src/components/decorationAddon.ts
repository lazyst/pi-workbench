/**
 * DecorationAddon —— 移植自 VS Code
 * src/vs/workbench/contrib/terminal/browser/xterm/decorationAddon.ts 的「差分 overlay 基座」。
 *
 * 作用：在终端 buffer 行上挂载 DOM 覆盖层装饰（gutter 标记 / overview-ruler 色条），命令状态
 * 变化只更新 overlay，不进 VT 流。这是 VS Code 命令装饰、mark 导航、错误/成功色条的技术基座。
 *
 * 与 VS Code 原版的差异（裁剪，不改 overlay 语义）：
 *   - VS Code 深度耦合 IDE 服务（hover service、context menu、chat、clipboard service、
 *     command service 等）；本项目是单进程 TUI 场景，故移除这些服务依赖，只保留：
 *       * registerCommandDecoration：命令开始/结束锚定 marker 的差分 overlay 注册
 *       * registerMarkDecoration：mark 锚定的 gutter/overview-ruler 装饰
 *       * clearDecorations / refreshLayouts：批量释放与布局刷新
 *       * onRender 钩子：装饰首次渲染时套用 CSS 类（对齐 VS Code updateLayout + _updateClasses）
 *   - 不实现命令动作菜单（run command / copy as HTML）、hover tooltip、chat 上下文——这些依赖
 *     IDE 能力，本项目无对应场景。
 *   - overview-ruler 装饰在本项目 CSS 中默认禁用（全屏 TUI 不需侧边色条），但 API 保留，
 *     调用方可传 overviewRulerOptions 启用。
 */
import type { IDecoration, IDecorationOptions, IMarker, ITerminalAddon, Terminal } from '@xterm/xterm';

export const enum DecorationSelector {
  CommandDecoration = 'terminal-command-decoration',
  Hide = 'hide',
  ErrorColor = 'error',
  DefaultColor = 'default-color',
  Default = 'default',
  Codicon = 'codicon',
  XtermDecoration = 'xterm-decoration',
  OverviewRuler = '.xterm-decoration-overview-ruler',
}

interface IDisposableDecoration {
  decoration: IDecoration;
  disposables: (() => void)[];
  command?: { marker?: IMarker; exitCode?: number };
  markProperties?: { marker?: IMarker; hoverMessage?: string };
}

export class DecorationAddon implements ITerminalAddon {
  private _terminal: Terminal | undefined;
  private _decorations = new Map<number, IDisposableDecoration>();
  private _placeholderDecoration: IDecoration | undefined;
  private _showGutterDecorations = true;
  private _showOverviewRulerDecorations = false;

  activate(terminal: Terminal): void {
    this._terminal = terminal;
  }

  dispose(): void {
    this.clearDecorations();
  }

  /**
   * 注册一条命令装饰（对齐 VS Code registerCommandDecoration）。
   * 锚定到 command.marker；beforeCommandExecution=true 时记为 placeholder（命令执行前的占位，
   * 执行开始后被 _clearPlaceholder 替换）。
   * @returns 注册的 IDecoration，或 undefined（无 terminal / 无可显示装饰类型）。
   */
  registerCommandDecoration(
    command?: { marker?: IMarker; exitCode?: number },
    beforeCommandExecution?: boolean,
    markProperties?: { marker?: IMarker; hoverMessage?: string },
  ): IDecoration | undefined {
    if (!this._terminal || (beforeCommandExecution && !command) || (!this._showGutterDecorations && !this._showOverviewRulerDecorations)) {
      return undefined;
    }
    const marker = command?.marker || markProperties?.marker;
    if (!marker) {
      throw new Error('cannot add a decoration for a command with no marker');
    }
    this._clearPlaceholder();
    const color = this._getDecorationColor(command) ?? '';
    const decoration = this._terminal.registerDecoration({
      marker,
      overviewRulerOptions: this._showOverviewRulerDecorations
        ? beforeCommandExecution
          ? { color, position: 'left' }
          : { color, position: command?.exitCode ? 'right' : 'left' }
        : undefined,
    });
    if (!decoration) {
      return undefined;
    }
    if (beforeCommandExecution) {
      this._placeholderDecoration = decoration;
    }
    decoration.onRender((element) => {
      if (element.classList.contains(DecorationSelector.OverviewRuler)) {
        return;
      }
      if (!this._decorations.get(decoration!.marker.id)) {
        decoration!.onDispose(() => this._decorations.delete(decoration!.marker.id));
        this._decorations.set(decoration!.marker.id, {
          decoration: decoration!,
          disposables: this._createDisposables(command, markProperties),
          command,
          markProperties,
        });
      }
      // 首次渲染或 buffer 被清：套用布局与 CSS 类（对齐 VS Code updateLayout + _updateClasses）。
      this._updateClasses(element, command, markProperties);
    });
    return decoration;
  }

  /** 注册一条 mark 装饰（gutter/overview-ruler），对齐 VS Code registerMarkDecoration。 */
  registerMarkDecoration(mark: { marker: IMarker; hoverMessage?: string }): IDecoration | undefined {
    if (!this._terminal || (!this._showGutterDecorations && !this._showOverviewRulerDecorations)) {
      return undefined;
    }
    const color = '#a371f7';
    const decoration = this._terminal.registerDecoration({
      marker: mark.marker,
      overviewRulerOptions: this._showOverviewRulerDecorations ? { color, position: 'left' } : undefined,
    });
    if (!decoration) {
      return undefined;
    }
    decoration.onRender((element) => {
      if (element.classList.contains(DecorationSelector.OverviewRuler)) {
        return;
      }
      if (!this._decorations.get(decoration!.marker.id)) {
        decoration!.onDispose(() => this._decorations.delete(decoration!.marker.id));
        this._decorations.set(decoration!.marker.id, {
          decoration: decoration!,
          disposables: this._createDisposables(undefined, mark),
        });
      }
      this._updateClasses(element, undefined, mark);
    });
    return decoration;
  }

  /** 批量释放全部装饰（对齐 VS Code clearDecorations）。 */
  clearDecorations(): void {
    for (const d of this._decorations.values()) {
      for (const dispose of d.disposables) dispose();
      try {
        d.decoration.dispose();
      } catch {
        /* 已释放 */
      }
    }
    this._decorations.clear();
    this._placeholderDecoration = undefined;
  }

  /** 刷新装饰布局（对齐 VS Code refreshLayouts，本项目仅触发一次重绘画笔）。 */
  refreshLayouts(): void {
    this._terminal?.refresh(0, this._terminal.rows - 1);
  }

  /** 设置装饰可见性（gutter / overview-ruler）。 */
  setVisibility(opts: { gutter?: boolean; overviewRuler?: boolean }): void {
    if (opts.gutter !== undefined) this._showGutterDecorations = opts.gutter;
    if (opts.overviewRuler !== undefined) this._showOverviewRulerDecorations = opts.overviewRuler;
  }

  private _clearPlaceholder(): void {
    if (this._placeholderDecoration) {
      try {
        this._placeholderDecoration.dispose();
      } catch {
        /* 已释放 */
      }
      this._placeholderDecoration = undefined;
    }
  }

  private _getDecorationColor(command?: { exitCode?: number }): string | undefined {
    if (command?.exitCode === undefined) return undefined;
    if (command.exitCode === 0) return '#3fb950'; // success green
    return '#ff7b72'; // error red
  }

  private _createDisposables(
    command?: { marker?: IMarker; exitCode?: number },
    markProperties?: { marker?: IMarker; hoverMessage?: string },
  ): (() => void)[] {
    // 本项目不实现 hover/context menu（依赖 IDE 服务）。命令结束（有 exitCode）或 mark 有
    // hoverMessage 时，可在此挂 DOM 事件；当前最小实现返回空（overlay 仅作视觉标记）。
    return [];
  }

  private _updateClasses(
    element: HTMLElement,
    command?: { marker?: IMarker; exitCode?: number },
    markProperties?: { marker?: IMarker; hoverMessage?: string },
  ): void {
    if (!element) return;
    // 清空旧类（对齐 VS Code 先 remove 全部再 add 的语义）。
    for (const cls of Array.from(element.classList)) {
      element.classList.remove(cls);
    }
    element.classList.add(DecorationSelector.CommandDecoration, DecorationSelector.Codicon, DecorationSelector.XtermDecoration);

    if (markProperties) {
      element.classList.add(DecorationSelector.Default);
      return;
    }
    if (command?.exitCode === undefined) {
      element.classList.add(DecorationSelector.Default);
      return;
    }
    if (command.exitCode === 0) {
      element.classList.add(DecorationSelector.DefaultColor, DecorationSelector.Default);
    } else {
      element.classList.add(DecorationSelector.ErrorColor);
    }
  }
}
