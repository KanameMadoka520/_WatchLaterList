import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const inputFile = path.join(root, 'data', 'watchlater.json');
const archiveDir = path.join(root, 'data', 'tag-archives');
const backupDir = path.join(root, 'data', 'backups');
const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const targetCount = Math.floor(Number(valueAfter('--target') || 240));
const apply = args.includes('--apply');
if (!Number.isFinite(targetCount) || targetCount < 50 || targetCount > 500) {
  throw new Error('--target 必须是 50-500 之间的整数');
}

const pad = value => String(value).padStart(2, '0');
const timestamp = date => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
  + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
const unique = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];

const ALIASES = new Map(Object.entries({
  AI: '人工智能',
  'AI模型': '大模型',
  LLM: '大模型',
  'AI Agent': '智能体',
  Agent: '智能体',
  'AI智能体': '智能体',
  动漫: '动画',
  开源: '开源项目',
  开源软件: '开源项目',
  开源工具: '开源项目',
  效率: '效率工具',
  生产力工具: '效率工具',
  办公效率: '效率工具',
  编程教程: '编程学习',
  编程入门: '编程学习',
  入门教程: '教程',
  网页开发: '前端开发',
  网站制作: '前端开发',
  三维设计: '3D建模',
  短视频: '短片',
  趣味短片: '短片',
  人物访谈: '访谈',
  心理成长: '个人成长',
  自我提升: '个人成长',
  学习经验: '学习方法',
  学习路线: '学习规划',
  知识学习: '学习',
  AI应用: '人工智能',
  AI模型训练: '模型训练',
  本地模型: '本地部署',
  本地AI: '本地部署'
}));

const DOMAIN_RULES = [
  ['人工智能', /人工智能|生成式|大模型|LLM|GPT|Claude|Gemini|DeepSeek|Qwen|Kimi|智能体|机器学习|深度学习|神经网络|RAG|MCP|提示词|多模态|模型训练|模型推理|Transformer|MoE/i],
  ['编程', /编程|代码|程序员|算法|数据结构|源码|C\+\+|C语言|Java|Python|Golang|Rust|LeetCode/i],
  ['软件开发', /软件开发|工程实践|开发实践|产品开发|独立开发|软件工程|架构设计|系统设计|API|SDK/i],
  ['开发工具', /开发工具|编程工具|IDE|VSCode|JetBrains|Git|GitHub|Jupyter|终端工具|CLI|插件/i],
  ['前端开发', /前端|网页|网站|HTML|CSS|JavaScript|Vue|React|WebGPU|Web3D/i],
  ['计算机', /计算机|操作系统|Windows|Linux|硬件|CPU|GPU|CUDA|服务器|数据库|SQLite|云计算|网络技术|软路由/i],
  ['网络安全', /网络安全|漏洞|攻击|安全防护|隐私|WAF|恶意|黑客|沙盒逃逸|权限提升|拒绝服务/i],
  ['科学', /科学|物理|化学|天文|生物学|生命科学|医学|科研|学术|论文|实验/i],
  ['数学', /数学|微积分|线性代数|概率|统计学|几何|代数|拓扑/i],
  ['学习方法', /学习方法|学习规划|学习效率|高效学习|考试复习|备考|考研|高考|课程|教育|大学|研究生/i],
  ['职场', /职场|职业|就业|求职|面试|简历|实习|工作经验|项目经历/i],
  ['商业', /商业|创业|产品运营|销售|营销|经营管理|行业观察|行业资讯|电商/i],
  ['财经', /财经|金融|理财|投资|财富|基金|股票|经济|资产管理|量化/i],
  ['健康', /健康|医学科普|睡眠|助眠|身体|护理|疾病|运动|养生|生理/i],
  ['心理学', /心理|认知|情绪|人格|意识|大脑|神经科学|专注力/i],
  ['情感', /情感|恋爱|爱情|亲密关系|两性|婚姻|伴侣|人际|孤独/i],
  ['个人成长', /个人成长|人生|自我|行动力|时间管理|习惯|成长|哲学/i],
  ['游戏', /游戏|电竞|Minecraft|我的世界|鸣潮|蔚蓝档案|明日方舟|星穹铁道|终末地|异环|角色扮演|抽卡/i],
  ['音乐', /音乐|歌曲|翻唱|演唱|编曲|歌单|MV|虚拟歌手|Synthwave|Funk|Jumpstyle|音频/i],
  ['动画', /动画|动漫|MMD|Live2D|角色动画|舞蹈动画|动效/i],
  ['视频制作', /视频|短片|剪辑|后期|调色|摄影|影视|电影|混剪|拍摄/i],
  ['设计', /设计|UI|交互|视觉|产品原型|字体|Logo|排版|审美/i],
  ['3D建模', /3D|三维|建模|Blender|渲染|ComfyUI|ZBrush|场景生成/i],
  ['内容创作', /内容创作|创作经验|创作工具|二次创作|作品展示|自媒体|直播|博客/i],
  ['娱乐', /娱乐|搞笑|恶搞|玩梗|猫咪|日常|短剧|剧情|角色展示/i],
  ['科普', /科普|知识|解读|解析|原理|教程|经验分享/i],
  ['生活', /生活|家居|旅行|饮食|收纳|消费|日常|校园生活/i]
];
const FORCED_TAGS = unique(DOMAIN_RULES.map(([name]) => name).concat(['教程', '教育', '效率工具', '开源项目', '综合']));
const normalizeTag = value => ALIASES.get(String(value || '').trim()) || String(value || '').trim();

const database = JSON.parse(await fs.readFile(inputFile, 'utf8'));
if (!Array.isArray(database.items)) throw new Error('data/watchlater.json 缺少 items 数组');
const beforeText = `${JSON.stringify(database, null, 2)}\n`;
const sourceCounts = new Map();
for (const item of database.items) {
  for (const tag of unique(item.tags || [])) sourceCounts.set(tag, (sourceCounts.get(tag) || 0) + 1);
}

const normalizedCounts = new Map();
for (const [source, count] of sourceCounts) {
  const normalized = normalizeTag(source);
  normalizedCounts.set(normalized, (normalizedCounts.get(normalized) || 0) + count);
}
for (const name of FORCED_TAGS) if (!normalizedCounts.has(name)) normalizedCounts.set(name, 0);
const ranked = [...normalizedCounts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
const forcedSet = new Set(FORCED_TAGS);
const canonicalNames = unique([
  ...FORCED_TAGS,
  ...ranked.filter(([name]) => !forcedSet.has(name)).map(([name]) => name)
]).slice(0, targetCount);
const canonicalSet = new Set(canonicalNames);
const canonicalRank = new Map(canonicalNames.map((name, index) => [name, index]));

const canonicalMatches = source => {
  const normalized = normalizeTag(source);
  if (canonicalSet.has(normalized)) return [normalized];
  const matches = canonicalNames
    .filter(name => name.length >= 2 && (normalized.includes(name) || (normalized.length >= 3 && name.includes(normalized))))
    .sort((left, right) => right.length - left.length || canonicalRank.get(left) - canonicalRank.get(right));
  if (matches.length) return matches.slice(0, 2);
  return DOMAIN_RULES.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name).filter(name => canonicalSet.has(name)).slice(0, 2);
};

const compressedAt = new Date();
const compressedItems = database.items.map(item => {
  const originalTags = unique(item.tags || []);
  const scores = new Map();
  const add = (name, score) => {
    if (!canonicalSet.has(name)) return;
    scores.set(name, Math.max(scores.get(name) || 0, score));
  };
  for (const source of originalTags) {
    const normalized = normalizeTag(source);
    if (canonicalSet.has(normalized)) add(normalized, 10000 + (normalizedCounts.get(normalized) || 0));
    else for (const target of canonicalMatches(source)) add(target, 4000 + (normalizedCounts.get(target) || 0));
  }
  const supportingFields = [item.category, ...(item.topics || []), ...(item.collections || [])];
  for (const source of supportingFields) {
    const normalized = normalizeTag(source);
    if (canonicalSet.has(normalized)) add(normalized, 2000 + (normalizedCounts.get(normalized) || 0));
    else for (const target of canonicalMatches(source)) add(target, 900 + (normalizedCounts.get(target) || 0));
  }
  const context = unique([...originalTags, ...supportingFields, item.title]).join(' ');
  for (const [name, pattern] of DOMAIN_RULES) if (pattern.test(context)) add(name, 500 + (normalizedCounts.get(name) || 0));
  if (!scores.size) add('综合', 1);
  const tags = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || canonicalRank.get(left[0]) - canonicalRank.get(right[0]))
    .slice(0, 5)
    .map(([name]) => name);
  return {
    ...item,
    tags,
    keywords: unique([...(item.keywords || []), ...originalTags]),
    ai: {
      ...(item.ai || {}),
      tagCompressionAt: compressedAt.toISOString(),
      tagCompressionVersion: 'frequency-domain-v1',
      tagCompressionOriginalCount: originalTags.length
    }
  };
});

const finalCounts = new Map();
for (const item of compressedItems) for (const tag of item.tags) finalCounts.set(tag, (finalCounts.get(tag) || 0) + 1);
const missingKeywords = [];
for (let index = 0; index < database.items.length; index++) {
  const before = unique(database.items[index].tags || []);
  const afterKeywords = new Set(compressedItems[index].keywords || []);
  for (const tag of before) if (!afterKeywords.has(tag)) missingKeywords.push({id: database.items[index].id, tag});
}
const invalidTags = compressedItems.flatMap(item => item.tags.filter(tag => !canonicalSet.has(tag)).map(tag => ({id: item.id, tag})));
const emptyVideos = compressedItems.filter(item => !item.tags.length).map(item => item.id);
if (finalCounts.size > targetCount || missingKeywords.length || invalidTags.length || emptyVideos.length) {
  throw new Error(`压缩验证失败：final=${finalCounts.size}, missingKeywords=${missingKeywords.length}, invalid=${invalidTags.length}, empty=${emptyVideos.length}`);
}

const sourceMappings = [...sourceCounts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
  .map(([source, count]) => ({
    source,
    count,
    targets: canonicalMatches(source),
    disposition: canonicalMatches(source).length ? 'canonical_and_keyword' : 'keyword_only'
  }));
const outputDatabase = {
  ...database,
  updatedAt: compressedAt.toISOString(),
  taxonomy: {
    version: 'watchlater-controlled-tags/v1',
    strategy: 'frequency-domain-v1',
    generatedAt: compressedAt.toISOString(),
    requestedTargetCount: targetCount,
    sourceUniqueTagCount: sourceCounts.size,
    finalUniqueTagCount: finalCounts.size,
    canonicalTags: canonicalNames.map(name => ({
      name,
      sourceUsageCount: normalizedCounts.get(name) || 0,
      finalVideoCount: finalCounts.get(name) || 0
    })),
    sourceMappings
  },
  items: compressedItems
};
const report = {
  schema: 'watchlater-tag-compression-report/v1',
  generatedAt: compressedAt.toISOString(),
  applied: apply,
  strategy: 'frequency-domain-v1',
  requestedTargetCount: targetCount,
  videoCount: database.items.length,
  beforeUniqueTags: sourceCounts.size,
  afterUniqueTags: finalCounts.size,
  reducedBy: sourceCounts.size - finalCounts.size,
  keywordCoverage: missingKeywords.length ? 0 : 1,
  videosWithoutTags: emptyVideos.length,
  canonicalTags: [...finalCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')),
  sourceMappings
};

await fs.mkdir(archiveDir, {recursive: true});
const stamp = timestamp(compressedAt);
const reportFile = path.join(archiveDir, `tag-compression-${stamp}-${sourceCounts.size}-to-${finalCounts.size}.json`);
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
let backupFile = '';
if (apply) {
  await fs.mkdir(backupDir, {recursive: true});
  backupFile = path.join(backupDir, `watchlater-before-tag-compression-${stamp}.json`);
  await fs.writeFile(backupFile, beforeText, 'utf8');
  const temporary = `${inputFile}.compression.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(outputDatabase, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, inputFile);
}

console.log(JSON.stringify({
  applied: apply,
  strategy: report.strategy,
  videoCount: report.videoCount,
  beforeUniqueTags: report.beforeUniqueTags,
  afterUniqueTags: report.afterUniqueTags,
  reducedBy: report.reducedBy,
  reportFile,
  backupFile: backupFile || null
}, null, 2));
