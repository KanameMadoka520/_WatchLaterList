import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const inputFile = path.resolve(root, process.argv[2] || 'data/watchlater.json');
const outputDir = path.resolve(root, process.argv[3] || 'data/tag-archives');

const pad = value => String(value).padStart(2, '0');
const localTimestamp = date => [
  date.getFullYear(),
  pad(date.getMonth() + 1),
  pad(date.getDate())
].join('-') + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

const escapeMarkdown = value => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll('|', '\\|')
  .replaceAll('\r', ' ')
  .replaceAll('\n', ' ');

const database = JSON.parse(await fs.readFile(inputFile, 'utf8'));
if (!Array.isArray(database.items)) throw new Error('输入文件缺少 items 数组');

const counts = new Map();
for (const item of database.items) {
  for (const rawTag of item.tags || []) {
    const name = String(rawTag).trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
}

const tags = [...counts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
  .map(([name, count], index) => ({rank: index + 1, name, count}));
const assignments = tags.reduce((total, tag) => total + tag.count, 0);
const distribution = {
  usedOnce: tags.filter(tag => tag.count === 1).length,
  usedTwice: tags.filter(tag => tag.count === 2).length,
  usedThreeToFive: tags.filter(tag => tag.count >= 3 && tag.count <= 5).length,
  usedSixToTen: tags.filter(tag => tag.count >= 6 && tag.count <= 10).length,
  usedOverTen: tags.filter(tag => tag.count > 10).length
};
const generatedAt = new Date();
const baseName = `tag-memory-${localTimestamp(generatedAt)}-${tags.length}-tags`;
const snapshot = {
  version: 1,
  schema: 'watchlater-tag-memory/v1',
  title: 'Watchlater Atlas 标签纪念册',
  generatedAt: generatedAt.toISOString(),
  source: path.relative(root, inputFile).replaceAll('\\', '/'),
  videoCount: database.items.length,
  uniqueTagCount: tags.length,
  tagAssignmentCount: assignments,
  averageTagsPerVideo: database.items.length ? assignments / database.items.length : 0,
  distribution,
  tags
};

await fs.mkdir(outputDir, {recursive: true});
const jsonText = `${JSON.stringify(snapshot, null, 2)}\n`;
const jsonFile = path.join(outputDir, `${baseName}.json`);
const markdownFile = path.join(outputDir, `${baseName}.md`);
const jsonSha256 = crypto.createHash('sha256').update(jsonText).digest('hex');
const percentage = count => tags.length ? `${(count / tags.length * 100).toFixed(1)}%` : '0.0%';
const markdown = [
  '# Watchlater Atlas 标签纪念册',
  '',
  `> 生成时间：${generatedAt.toLocaleString('zh-CN')}`,
  '',
  `这份快照记录了当时资料库中的 **${tags.length} 个唯一标签**。以后无论标签体系如何归核、压缩或重建，这些名称和使用次数都可以在这里找到。`,
  '',
  '## 当时的资料库',
  '',
  '| 指标 | 数值 |',
  '| --- | ---: |',
  `| 视频数量 | ${database.items.length} |`,
  `| 唯一标签 | ${tags.length} |`,
  `| 标签使用总次数 | ${assignments} |`,
  `| 平均每个视频标签数 | ${snapshot.averageTagsPerVideo.toFixed(2)} |`,
  `| 只使用 1 次 | ${distribution.usedOnce}（${percentage(distribution.usedOnce)}） |`,
  `| 只使用 2 次 | ${distribution.usedTwice}（${percentage(distribution.usedTwice)}） |`,
  `| 使用 3-5 次 | ${distribution.usedThreeToFive}（${percentage(distribution.usedThreeToFive)}） |`,
  `| 使用 6-10 次 | ${distribution.usedSixToTen}（${percentage(distribution.usedSixToTen)}） |`,
  `| 使用超过 10 次 | ${distribution.usedOverTen}（${percentage(distribution.usedOverTen)}） |`,
  '',
  '## 全部标签',
  '',
  '| 排名 | 标签 | 使用次数 | 占视频比例 |',
  '| ---: | --- | ---: | ---: |',
  ...tags.map(tag => `| ${tag.rank} | ${escapeMarkdown(tag.name)} | ${tag.count} | ${database.items.length ? (tag.count / database.items.length * 100).toFixed(2) : '0.00'}% |`),
  '',
  '## 完整性',
  '',
  `- JSON SHA-256：\`${jsonSha256}\``,
  `- 数据源：\`${path.relative(root, inputFile).replaceAll('\\', '/')}\``,
  '- 快照只包含标签统计，不包含 API Key、Cookie、封面或视频文件。',
  ''
].join('\n');

await Promise.all([
  fs.writeFile(jsonFile, jsonText, 'utf8'),
  fs.writeFile(markdownFile, markdown, 'utf8')
]);

console.log(JSON.stringify({
  jsonFile,
  markdownFile,
  videoCount: database.items.length,
  uniqueTagCount: tags.length,
  tagAssignmentCount: assignments,
  jsonSha256
}, null, 2));
