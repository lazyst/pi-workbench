/**
 * 把 'YYYY-MM-DD HH:MM' 格式的会话时间戳转换为相对时间字符串。
 * 文件名时间戳源自 UTC（形如 2026-07-03T19-07-11-857Z），故按 UTC 解析。
 * 只使用「分钟」「小时」「天」三种单位，不带「前」字：
 *   - 不足 1 分钟 → "刚刚"
 *   - 不足 60 分钟 → "x分钟"
 *   - 不足 24 小时 → "x小时"
 *   - 超过 24 小时 → "x天"
 * 解析失败时原样返回，保证不破坏既有显示。
 */
export function formatRelativeTime(time: string | undefined): string | undefined {
  if (!time) return undefined;
  const date = parseSessionTime(time);
  if (!date) return time;
  const diffMs = Date.now() - date.getTime();
  if (diffMs <= 0) return '刚刚';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时`;
  const day = Math.floor(hour / 24);
  return `${day}天`;
}

function parseSessionTime(time: string): Date | null {
  const m = time.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // 文件名时间戳源自 UTC（...Z 后缀），按 UTC 构造以保证相对时间准确。
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
}