// 从 CHANGELOG.md 提取指定版本的 release notes
// 用法：node scripts/extract-release-notes.mjs <tag>  (tag 形如 v1.3.0)
// 输出到 release_notes.md（不含版本标题行）
import fs from 'node:fs';

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('Usage: node scripts/extract-release-notes.mjs <tag>');
  process.exit(1);
}

const lines = fs.readFileSync('CHANGELOG.md', 'utf8').split('\n');
const out = [];
let capturing = false;
for (const line of lines) {
  // 匹配形如 "## v1.3.0" 或 "## v1.3.0 (date)" 的版本标题
  if (/^## v\d+\.\d+\.\d+/.test(line)) {
    capturing = line.startsWith('## ' + tag + ' ') || line === '## ' + tag;
  }
  if (capturing) out.push(line);
}

if (out.length === 0) {
  console.error(`Version ${tag} not found in CHANGELOG.md`);
  process.exit(2);
}

// 去掉第一行（## vX.Y.Z 标题），release 的 name 字段会单独提供标题
fs.writeFileSync('release_notes.md', out.slice(1).join('\n').trim() + '\n');
console.log(`Extracted ${out.length - 1} lines for ${tag}`);
