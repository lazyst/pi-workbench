/**
 * replay-cursor-reset —— Replay 后光标状态重置序列
 *
 * 在终端 scrollback 重放完成后，发送 ESC 序列重置被 TUI 污染的光标状态。
 *
 * 设计思路（对齐 Orca layout-serialization.ts）：
 *   - 重放 scrollback 可能含有 TUI 残留的 DECSCUSR 光标样式覆盖（如 \x1b[2 q → 稳态块状）
 *   - 可能含有 \x1b[?25l 光标隐藏，导致 shell 启动后光标不可见
 *   - 可能含有 Kitty 键盘协议、鼠标报告、焦点报告等模式污染
 *
 * 重置序列按场景分级：
 *   CURSOR_RESET_MINIMAL  — 仅光标样式 + 光标可见（最安全，适用于所有 replay）
 *   CURSOR_RESET_STANDARD — 光标 + 键盘 + 鼠标 + 焦点 + 括号粘贴（适用于冷恢复）
 *   CURSOR_RESET_KEEP_FOCUS — 保留焦点报告（适用于活跃 agent 重新挂载）
 */

/**
 * 重置 DECSCUSR 光标样式到默认（\x1b[0 q）。
 * 0 SP q = DECSCUSR 默认光标（用户配置的 block/bar/underline 由 xterm options 决定）。
 * 覆盖 TUI 退出后残留的 \x1b[2 q / \x1b[4 q / \x1b[6 q 等稳态覆盖。
 */
export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'

/**
 * 重置 Kitty 键盘协议（\x1b[<99u\x1b[=0u）。
 * 清除 TUI 推入的 CSI-u 编码标志，避免后续 Ctrl+C 等编码为 CSI-u 序列。
 */
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'

/**
 * 重置所有鼠标报告模式（\x1b[?9l / ?1000l / ?1002l / ?1003l / ?1006l / ?1016l）。
 * 清除 TUI 开启的鼠标事件捕获，防止 shell 收到鼠标移动编码。
 */
export const RESET_MOUSE_REPORTING =
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'

/**
 * 最小化重置：仅光标样式 + 光标可见。
 * 适用于所有 replay 场景，最安全，无副作用。
 */
export const CURSOR_RESET_MINIMAL = `${RESET_TERMINAL_CURSOR_STYLE}\x1b[?25h`

/**
 * 标准重置：光标 + 键盘 + 鼠标 + 焦点 + 括号粘贴。
 * 适用于冷恢复场景（新 shell 不应继承任何 TUI 模式）。
 */
export const CURSOR_RESET_STANDARD =
  `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h${RESET_MOUSE_REPORTING}\x1b[?1004l\x1b[?2004l`

/**
 * 保留焦点报告的重置：光标 + 键盘 + 光标可见。
 * 适用于活跃 agent 重新挂载场景（agent TUI 需要焦点事件来重新定位光标）。
 */
export const CURSOR_RESET_KEEP_FOCUS =
  `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h`
