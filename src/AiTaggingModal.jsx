import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Bot, GitMerge, KeyRound, Layers3, Pause, Play, Save, Sparkles, Square, Tags, X} from 'lucide-react';
import {HelpButton, HelpDialog} from './HelpDialog';

const STORAGE_KEY = 'watchlater.ai.config';
const LOCAL_AI_PROXY = 'http://localhost:4175/api/ai-proxy';
const defaultConfig = {
  protocol: 'responses',
  endpoint: 'https://api.openai.com/v1/responses',
  apiKey: '',
  model: 'gpt-5.6-luna',
  batchSize: 20,
  concurrency: 1,
  consolidationThreshold: 1000,
  consolidationChunkSize: 500,
  consolidationAnchorSize: 240,
  consolidationStrength: 'aggressive',
  unificationTarget: 200,
  unificationChunkSize: 500,
  unificationConcurrency: 2,
  unificationStrength: 'balanced',
  scope: 'unprocessed',
  instructions: '优先复用已有标签；每个视频给出 2-6 个简洁中文标签，并给出一个主分类和最多 3 个主题。'
};

const AI_HELP = {
  batch: {
    title: '每批视频数怎么理解？',
    paragraphs: ['这个数字是一条 API 请求里放多少个视频。填写 20，就是一次发送 20 个视频的文字元数据，并一次取回 20 组分类结果。'],
    bullets: ['不是连续发 20 次请求。', '不是抓取 20 个相关推荐。', '批次越大，单次上下文越大；批次越小，规则和 Schema 会重复发送更多次。']
  },
  concurrency: {
    title: '并发请求数怎么理解？',
    paragraphs: ['并发决定同一时间运行多少个完整请求。每批 20、并发 3，表示最多同时处理 60 个视频。'],
    bullets: ['并发过高可能触发 429、RPM、TPM 或连接数限制。', '受控词表锁定后，各批次使用同一套主标签，不需要互相等待新标签。']
  },
  target: {
    title: '最终标签目标是什么？',
    paragraphs: ['统一规格会强制模型最终给出准确数量的主标签。例如填写 200，最终提案必须恰好有 200 个 canonicalTags，否则本地校验不通过，也不会写入数据库。'],
    bullets: ['目标不能大于当前标签数，因为归合不会凭空创造分类。', '原始标签不会删除，会并入对应视频的 keywords。', '提案生成后还要人工确认，确认前不会修改资料库。']
  },
  hierarchy: {
    title: '分层收敛为什么能处理上千标签？',
    paragraphs: ['程序不会把上千标签一次塞进模型。它把词表切片，每轮把超出目标的部分大约减半；同一轮的切片可以并发，下一轮再处理上一轮产生的候选词。'],
    bullets: ['当候选词降到单请求安全范围后，最后一次请求会看到全部候选词。', '终局请求强制输出准确目标数，解决各切片之间命名不一致的问题。', '每一片都要求 100% 来源映射；任一片失败，整项任务不应用。']
  },
  mergeScale: {
    title: '目标归合的三种归并尺度',
    paragraphs: ['三种尺度都会遵守最终标签数量，区别是遇到边界概念时倾向保留多细。'],
    bullets: ['保守分层：尽量保留具体类别，只在达到目标所必需时向上归并。', '均衡归类：保留稳定的中层概念，优先合并同义、近义和过细子类，适合多数资料库。', '强力收敛：更偏向宽泛导航入口，适合希望主标签非常少、主要依靠关键词搜索的资料库。']
  },
  synonym: {
    title: '同义判定的三种方式',
    paragraphs: ['同义清洗不负责达到目标数量，只处理命名关系。下面三档决定“多相近才允许改成同一个名字”。'],
    bullets: ['严格同义：只处理缩写、全称、中英文、大小写、空格和明确同义词，误合并风险最低。', '同义与无损近义：允许合并替换后基本不改变检索意图的近义名称。', '含安全上下位归并：还允许把明显过细、可以无损归入上位概念的名称合并，压缩更明显但需要更多人工检查。']
  },
  api: {
    title: 'API 配置保存在哪里？',
    paragraphs: ['API Key 和模型配置只保存在当前站点的 localStorage。请求由本机 4175 服务转发，Key 不写入视频 JSON、数据库备份或服务日志。'],
    bullets: ['清空“浏览器缓存视频”不会清除 API 配置。', '共享电脑建议使用短期或限额 Key，任务结束后手动清除站点数据。']
  }
};

const loadConfig = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!stored.protocol && stored.endpoint) {
      stored.protocol = stored.endpoint.includes('/responses') ? 'responses' : 'chat-completions';
    }
    return {...defaultConfig, ...stored};
  } catch {
    return defaultConfig;
  }
};

const cleanJson = value => value.trim()
  .replace(/^```(?:json)?\s*/i, '')
  .replace(/\s*```$/, '');

const clampBatchSize = value => Math.max(5, Math.min(40, Number(value) || 20));
const positiveInteger = (value, fallback = 1) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
};
const normalizeConcurrency = value => positiveInteger(value, 1);
const normalizeConsolidationThreshold = value => positiveInteger(value, 1000);
const normalizeConsolidationChunkSize = value => positiveInteger(value, 500);
const normalizeConsolidationAnchorSize = value => positiveInteger(value, 240);
const normalizeUnificationTarget = value => Math.max(20, Math.min(500, positiveInteger(value, 200)));
const normalizeUnificationChunkSize = value => Math.max(50, Math.min(1000, positiveInteger(value, 500)));
const cleanList = (value, limit) => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim())
  .filter(Boolean))].slice(0, limit);
const statusLabels = {
  idle: '尚未开始', running: '处理中', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', stopped: '已停止', review: '等待确认', applying: '正在应用', completed: '已完成', failed: '失败'
};
const modeLabels = {classify: '批量打标签', consolidate: '同义清洗', unify: '统一规格'};
const formatBytes = bytes => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
  : `${(bytes / 1024).toFixed(1)} KB`;
const formatDuration = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
};
const formatNumber = value => new Intl.NumberFormat('zh-CN').format(value || 0);

const responseSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {type: 'string'},
          tags: {type: 'array', items: {type: 'string'}},
          keywords: {type: 'array', items: {type: 'string'}},
          category: {type: 'string'},
          topics: {type: 'array', items: {type: 'string'}},
          collections: {type: 'array', items: {type: 'string'}},
          reason: {type: 'string'}
        },
        required: ['id', 'tags', 'keywords', 'category', 'topics', 'collections', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
};

const mappingSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      from: {type: 'string'},
      to: {type: 'string'},
      reason: {type: 'string'}
    },
    required: ['from', 'to', 'reason'],
    additionalProperties: false
  }
};

const consolidationSchema = {
  type: 'object',
  properties: {
    tagMappings: mappingSchema,
    summary: {type: 'string'}
  },
  required: ['tagMappings', 'summary'],
  additionalProperties: false
};

const taxonomyReductionSchema = {
  type: 'object',
  properties: {
    canonicalTags: {type: 'array', items: {type: 'string'}},
    tagMappings: mappingSchema,
    summary: {type: 'string'}
  },
  required: ['canonicalTags', 'tagMappings', 'summary'],
  additionalProperties: false
};

const responseOutputText = envelope => {
  if (typeof envelope.output_text === 'string') return envelope.output_text;
  for (const output of envelope.output || []) {
    for (const part of output.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
};

const emptyUsage = () => ({inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0});
const normalizeUsage = usage => ({
  inputTokens: Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0,
  cachedInputTokens: Number(usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0,
  outputTokens: Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0,
  reasoningTokens: Number(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
  totalTokens: Number(usage?.total_tokens ?? 0) || 0
});
const addUsage = (left, right) => ({
  inputTokens: left.inputTokens + right.inputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  totalTokens: left.totalTokens + right.totalTokens
});

const parseSseBlock = block => {
  let eventName = '';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const rawData = dataLines.join('\n');
  if (!rawData || rawData === '[DONE]') return null;
  try {
    const data = JSON.parse(rawData);
    return {eventName: eventName || data.type || '', data};
  } catch {
    return {eventName, data: null};
  }
};

const readAiResponse = async (response, isResponses, onProgress) => {
  const contentType = response.headers.get('content-type') || '';
  const jsonContent = contentType.includes('application/json') || contentType.includes('+json');
  const isSse = isResponses && response.body && (contentType.includes('text/event-stream') || !jsonContent);
  if (!isSse) {
    const raw = await response.text();
    onProgress?.({bytes: new TextEncoder().encode(raw).byteLength, events: 0, activityAt: new Date().toISOString()});
    if (!response.ok) throw new Error(`API HTTP ${response.status}：${raw.slice(0, 300)}`);
    const envelope = JSON.parse(raw);
    return {
      content: isResponses ? responseOutputText(envelope) : envelope.choices?.[0]?.message?.content,
      usage: normalizeUsage(envelope.usage),
      streamed: false
    };
  }

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`API HTTP ${response.status}：${raw.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let completedEnvelope = null;
  let finalUsage = emptyUsage();
  let pendingBytes = 0;
  let pendingEvents = 0;
  let lastReportAt = 0;
  const report = force => {
    const now = Date.now();
    if (!force && now - lastReportAt < 200 && pendingEvents < 12 && pendingBytes < 16384) return;
    if (!pendingBytes && !pendingEvents && !force) return;
    onProgress?.({bytes: pendingBytes, events: pendingEvents, activityAt: new Date(now).toISOString()});
    pendingBytes = 0;
    pendingEvents = 0;
    lastReportAt = now;
  };
  const handleBlock = block => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    pendingEvents++;
    const {eventName, data} = parsed;
    if (!data) return;
    const type = data.type || eventName;
    if (type === 'response.output_text.delta' && typeof data.delta === 'string') content += data.delta;
    if (type === 'response.output_text.done' && !content && typeof data.text === 'string') content = data.text;
    if (type === 'response.completed') {
      completedEnvelope = data.response || data;
      finalUsage = normalizeUsage(completedEnvelope.usage || data.usage);
    }
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      const detail = data.response?.error?.message || data.error?.message || data.message || type;
      throw new Error(`Responses 流失败：${detail}`);
    }
  };

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      pendingBytes += value.byteLength;
      buffer += decoder.decode(value, {stream: true});
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) handleBlock(block);
      report(false);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
    report(true);
  } finally {
    reader.releaseLock();
  }
  if (!content && completedEnvelope) content = responseOutputText(completedEnvelope);
  return {content, usage: finalUsage, streamed: true};
};

const tagCountsOf = items => {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags || []) {
      const name = String(tag).trim();
      if (name && name !== '全部') counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return counts;
};

const sortedTagEntries = (counts, limit) => [...counts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
  .slice(0, limit)
  .map(([name, count]) => ({name, count}));

const globalVocabularyOf = items => sortedTagEntries(tagCountsOf(items), Number.MAX_SAFE_INTEGER);

const resolveMappedTag = (value, mappings) => {
  let current = value;
  const seen = new Set([current]);
  while (mappings.has(current)) {
    const next = mappings.get(current);
    if (!next || next === current || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
};

const canonicalAnchorsOf = (vocabulary, mappings, limit) => {
  const counts = new Map();
  for (const entry of vocabulary) {
    const name = resolveMappedTag(entry.name, mappings);
    counts.set(name, (counts.get(name) || 0) + entry.count);
  }
  return sortedTagEntries(counts, limit);
};

const consolidationChunksOf = (vocabulary, threshold, chunkSize) => {
  if (vocabulary.length <= threshold) return [vocabulary];
  const chunks = [];
  for (let index = 0; index < vocabulary.length; index += chunkSize) chunks.push(vocabulary.slice(index, index + chunkSize));
  return chunks;
};

const allocateQuotas = (lengths, desiredTotal) => {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const quotas = lengths.map(length => Math.max(1, Math.min(length, Math.floor(length * desiredTotal / total))));
  let assigned = quotas.reduce((sum, value) => sum + value, 0);
  const fractions = lengths.map((length, index) => ({
    index,
    fraction: length * desiredTotal / total - Math.floor(length * desiredTotal / total)
  })).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  while (assigned < desiredTotal) {
    const candidate = fractions.find(({index}) => quotas[index] < lengths[index]);
    if (!candidate) break;
    quotas[candidate.index]++;
    assigned++;
    fractions.push(fractions.shift());
  }
  while (assigned > desiredTotal) {
    const candidate = [...fractions].reverse().find(({index}) => quotas[index] > 1);
    if (!candidate) break;
    quotas[candidate.index]--;
    assigned--;
  }
  return quotas;
};

const unificationRoundsOf = (vocabularySize, targetCount, chunkSize) => {
  if (vocabularySize < targetCount) return [];
  const rounds = [];
  let remaining = vocabularySize;
  const finalInputLimit = Math.max(chunkSize, targetCount + 50);
  while (remaining > finalInputLimit) {
    const chunkLengths = [];
    for (let index = 0; index < remaining; index += chunkSize) chunkLengths.push(Math.min(chunkSize, remaining - index));
    const desiredTotal = Math.max(targetCount + 1, Math.ceil(remaining / 2));
    const quotas = allocateQuotas(chunkLengths, desiredTotal);
    rounds.push({inputCount: remaining, outputCount: desiredTotal, chunkLengths, quotas, final: false});
    remaining = desiredTotal;
  }
  rounds.push({inputCount: remaining, outputCount: targetCount, chunkLengths: [remaining], quotas: [targetCount], final: true});
  return rounds;
};

const mapConcurrent = async (values, limit, mapper) => {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, values.length || 1)}, worker));
  return results;
};

export function AiTaggingModal({open, allItems, filteredItems, taxonomy, onApplyBatch, onApplyConsolidation, onApplyTaxonomy, onClose, storageLabel}) {
  const [config, setConfig] = useState(loadConfig);
  const [activeTab, setActiveTab] = useState('classify');
  const [helpTopic, setHelpTopic] = useState('');
  const [pendingPlan, setPendingPlan] = useState(null);
  const [task, setTask] = useState({
    mode: 'classify', status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0,
    batch: 0, batches: 0, currentBatches: [], currentIds: [], vocabularySize: 0,
    streamEvents: 0, responseBytes: 0, lastActivityAt: '', startedAt: '', finishedAt: '', usage: emptyUsage(),
    lastMessage: '', lastError: ''
  });
  const [clock, setClock] = useState(Date.now());
  const queueRef = useRef([]);
  const cursorRef = useRef(0);
  const runningRef = useRef(false);
  const pauseRef = useRef(false);
  const stopRef = useRef(false);
  const abortRefs = useRef(new Set());
  const activeConfigRef = useRef(null);
  const tagCountsRef = useRef(new Map());
  const schemaModeRef = useRef('strict');

  const candidates = useMemo(() => {
    if (config.scope === 'filtered') return filteredItems;
    if (config.scope === 'all') return allItems;
    return allItems.filter(item => !item.ai?.processedAt);
  }, [allItems, filteredItems, config.scope]);
  const currentVocabularySize = useMemo(() => tagCountsOf(allItems).size, [allItems]);
  const currentGlobalVocabulary = useMemo(() => globalVocabularyOf(allItems), [allItems]);
  const lockedCanonicalTags = useMemo(() => (taxonomy?.canonicalTags || [])
    .map(entry => typeof entry === 'string' ? entry : entry?.name)
    .filter(Boolean), [taxonomy]);

  useEffect(() => {
    if (!['running', 'pausing', 'stopping', 'applying'].includes(task.status)) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);

  if (!open) return null;

  const saveConfig = next => {
    const {globalBatchSize: _legacyBatchSize, globalTagStrategy: _legacyTagStrategy, ...current} = next;
    const normalized = {
      ...current,
      batchSize: clampBatchSize(current.batchSize),
      concurrency: normalizeConcurrency(current.concurrency),
      consolidationThreshold: normalizeConsolidationThreshold(current.consolidationThreshold),
      consolidationChunkSize: normalizeConsolidationChunkSize(current.consolidationChunkSize),
      consolidationAnchorSize: normalizeConsolidationAnchorSize(current.consolidationAnchorSize),
      consolidationStrength: ['conservative', 'balanced', 'aggressive'].includes(current.consolidationStrength)
        ? current.consolidationStrength
        : 'aggressive',
      unificationTarget: normalizeUnificationTarget(current.unificationTarget),
      unificationChunkSize: normalizeUnificationChunkSize(current.unificationChunkSize),
      unificationConcurrency: normalizeConcurrency(current.unificationConcurrency),
      unificationStrength: ['conservative', 'balanced', 'aggressive'].includes(current.unificationStrength)
        ? current.unificationStrength
        : 'balanced'
    };
    setConfig(normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  };

  const updateKnownTags = results => {
    for (const result of results) {
      for (const tag of result.tags || []) {
        tagCountsRef.current.set(tag, (tagCountsRef.current.get(tag) || 0) + 1);
      }
    }
  };

  const reportStreamProgress = progress => {
    setTask(current => ({
      ...current,
      streamEvents: current.streamEvents + (progress.events || 0),
      responseBytes: current.responseBytes + (progress.bytes || 0),
      lastActivityAt: progress.activityAt || current.lastActivityAt
    }));
  };

  const reportUsage = usage => {
    setTask(current => ({...current, usage: addUsage(current.usage || emptyUsage(), usage || emptyUsage())}));
  };

  const requestBatch = async (batch, activeConfig, signal) => {
    const knownTags = lockedCanonicalTags.length
      ? lockedCanonicalTags
      : sortedTagEntries(tagCountsRef.current, 160).map(entry => entry.name);
    const payloadItems = batch.map(item => ({
      id: item.id,
      title: item.title,
      author: item.author || '',
      description: item.description || '',
      currentTags: item.tags || [],
      currentKeywords: item.keywords || [],
      currentCategory: item.category || '',
      note: item.note || ''
    }));
    const prompt = [
      '你是视频资料库分类器。必须只返回 JSON，不要 Markdown。',
      `已有标签词表（任务运行中持续更新）：${JSON.stringify(knownTags)}`,
      lockedCanonicalTags.length
        ? '当前资料库已经锁定受控词表。tags 只能从已有标签词表中选择；更具体的人名、作品名、软件名、技术名和长尾描述必须放入 keywords，禁止创造新主标签。'
        : '当前资料库尚未锁定受控词表，可以生成新的简洁标签。',
      `附加规则：${activeConfig.instructions}`,
      '每个 items 元素代表相互独立的视频。只能依据该元素自身字段分类，不得借用同一批其他视频的内容推断或复制标签。',
      '返回格式：{"items":[{"id":"BV号","tags":["受控标签"],"keywords":["详细关键词"],"category":"主分类","topics":["主题"],"collections":["建议收藏夹"],"reason":"一句简短依据"}]}。',
      '不得遗漏输入 id，不得修改 id；标签去重，不要把播放量、作者名或“视频”当作标签。',
      `待处理数据：${JSON.stringify(payloadItems)}`
    ].join('\n');
    const isResponses = activeConfig.protocol === 'responses';
    const strictSchema = isResponses && schemaModeRef.current === 'strict';
    const body = isResponses ? {
      model: activeConfig.model,
      instructions: '你负责为中文视频资料库生成稳定、可复用的结构化分类元数据。',
      input: prompt,
      store: false,
      stream: true,
      text: {
        format: strictSchema ? {
          type: 'json_schema',
          name: 'watchlater_video_tags',
          strict: true,
          schema: responseSchema
        } : {type: 'json_object'}
      }
    } : {
      model: activeConfig.model,
      temperature: 0.1,
      response_format: {type: 'json_object'},
      messages: [
        {role: 'system', content: '你负责为中文视频资料库生成稳定、可复用的结构化分类元数据。'},
        {role: 'user', content: prompt}
      ]
    };
    const send = () => fetch(LOCAL_AI_PROXY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        endpoint: activeConfig.endpoint,
        apiKey: activeConfig.apiKey,
        body
      }),
      signal
    });
    let response = await send();
    if ([400, 422].includes(response.status)) {
      if (isResponses && strictSchema) {
        schemaModeRef.current = 'json_object';
        body.text = {format: {type: 'json_object'}};
      } else if (!isResponses) delete body.response_format;
      response = await send();
    }
    const result = await readAiResponse(response, isResponses, reportStreamProgress);
    reportUsage(result.usage);
    const content = result.content;
    if (!content) throw new Error(isResponses
      ? 'Responses API 响应中没有 output_text 内容'
      : 'Chat Completions 响应中没有 choices[0].message.content');
    const parsed = JSON.parse(cleanJson(content));
    const allowed = new Set(batch.map(item => item.id));
    const lockedSet = lockedCanonicalTags.length ? new Set(lockedCanonicalTags) : null;
    const results = (parsed.items || []).filter(item => allowed.has(item.id)).map(item => ({
      id: item.id,
      tags: cleanList(item.tags, 8).filter(tag => !lockedSet || lockedSet.has(tag)),
      keywords: cleanList(item.keywords, 12),
      category: String(item.category || '').trim(),
      topics: cleanList(item.topics, 5),
      collections: cleanList(item.collections, 5),
      reason: String(item.reason || '').trim()
    }));
    if (!results.length) throw new Error('模型返回了 JSON，但没有可匹配当前批次 BV 号的结果');
    return results;
  };

  const requestConsolidation = async (vocabulary, anchors, activeConfig, signal, chunkNumber, chunkCount) => {
    const strengthRule = {
      conservative: '只合并确定无疑的同义词、缩写、语言和格式变体。',
      balanced: '在明确同义之外，也合并不会损失检索意图的冗余近义名称。',
      aggressive: '除明确同义外，也允许把可安全替换且不损失检索意图的上下位冗余和重复复合名称归到已有规范名。'
    }[activeConfig.consolidationStrength];
    const prompt = [
      '你是视频资料库的全局命名归核器。必须只返回 JSON，不要 Markdown。',
      `这是最终归核的第 ${chunkNumber}/${chunkCount} 片。你不会收到视频内容，只需要统一已经产生的标签名称。`,
      strengthRule,
      '把大小写、语言差异、缩写、字符损坏、明确同义和可安全替换的冗余名称映射到同一个规范名称；优先保留使用次数高、含义清楚、便于中文检索的已有名称。',
      '不要合并只是相关但检索意图不同的概念。只返回确实需要改变的映射，不要返回 from 与 to 相同的自映射；未返回的标签会在本地原样保留。',
      'from 只能来自“本片待归核词汇”；“跨片规范锚点”只能帮助保持命名一致，可以作为 to，但不能作为 from。',
      lockedCanonicalTags.length
        ? '受控词表已经锁定，to 必须是现有规范标签，禁止创造新名称；已经属于受控词表的 from 不得再映射到其他规范标签。本任务只收编词表外历史别名，不负责压缩到目标数量。'
        : '受控词表尚未锁定，优先使用已有高频名称。',
      '返回格式：{"tagMappings":[{"from":"旧标签","to":"规范标签","reason":"依据"}],"summary":"归核摘要"}。',
      `跨片规范锚点及累计次数：${JSON.stringify(anchors)}`,
      `本片待归核词汇及使用次数：${JSON.stringify(vocabulary)}`
    ].join('\n');
    const isResponses = activeConfig.protocol === 'responses';
    const strictSchema = isResponses && schemaModeRef.current === 'strict';
    const body = isResponses ? {
      model: activeConfig.model,
      instructions: '你负责把视频资料库已经产生的分类词汇统一成稳定、可复用的全局命名体系。',
      input: prompt,
      store: false,
      stream: true,
      text: {
        format: strictSchema ? {
          type: 'json_schema',
          name: 'watchlater_vocabulary_consolidation',
          strict: true,
          schema: consolidationSchema
        } : {type: 'json_object'}
      }
    } : {
      model: activeConfig.model,
      temperature: 0.1,
      response_format: {type: 'json_object'},
      messages: [
        {role: 'system', content: '你负责把视频资料库已经产生的分类词汇统一成稳定、可复用的全局命名体系。'},
        {role: 'user', content: prompt}
      ]
    };
    const send = () => fetch(LOCAL_AI_PROXY, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({endpoint: activeConfig.endpoint, apiKey: activeConfig.apiKey, body}),
      signal
    });
    let response = await send();
    if ([400, 422].includes(response.status)) {
      if (isResponses && strictSchema) {
        schemaModeRef.current = 'json_object';
        body.text = {format: {type: 'json_object'}};
      } else if (!isResponses) delete body.response_format;
      response = await send();
    }
    const result = await readAiResponse(response, isResponses, reportStreamProgress);
    reportUsage(result.usage);
    const content = result.content;
    if (!content) throw new Error(isResponses
      ? 'Responses API 响应中没有 output_text 内容'
      : 'Chat Completions 响应中没有 choices[0].message.content');
    const parsed = JSON.parse(cleanJson(content));
    const cleanMappings = (value, entries) => {
      const allowed = new Set(entries.map(entry => entry.name));
      const allowedTargets = lockedCanonicalTags.length ? new Set(lockedCanonicalTags) : null;
      const seen = new Set();
      const mappings = [];
      for (const mapping of Array.isArray(value) ? value : []) {
        const from = String(mapping?.from || '').trim();
        const to = String(mapping?.to || '').trim().slice(0, 80);
        if (!allowed.has(from) || !to || seen.has(from) || (allowedTargets && (!allowedTargets.has(to) || allowedTargets.has(from)))) continue;
        seen.add(from);
        mappings.push({from, to, reason: String(mapping.reason || '').trim()});
      }
      return mappings;
    };
    const plan = {
      tagMappings: cleanMappings(parsed.tagMappings, vocabulary).filter(mapping => mapping.from !== mapping.to),
      summary: String(parsed.summary || '').trim()
    };
    return plan;
  };

  const requestTaxonomyChunk = async (entries, targetCount, activeConfig, signal, roundNumber, roundCount, chunkNumber, chunkCount) => {
    const strengthRule = {
      conservative: '尽量保留有独立检索价值的具体类别；只有为了达到数量目标时，才向稳定的上位概念归并。',
      balanced: '在信息区分度和标签总量之间取平衡；同义词、近义词和过细子类优先归到稳定的中层概念。',
      aggressive: '优先形成更少、更宽的导航入口；相关子主题可以归到通用上位概念，但不能把语义完全无关的内容硬合并。'
    }[activeConfig.unificationStrength];
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = [
        '你是视频资料库的受控标签体系设计器。必须只返回 JSON，不要 Markdown。',
        `当前是第 ${roundNumber}/${roundCount} 轮、第 ${chunkNumber}/${chunkCount} 片。`,
        `必须把本片 ${entries.length} 个来源标签归并为恰好 ${targetCount} 个规范标签，不能多也不能少。`,
        strengthRule,
        '每个来源标签都必须在 tagMappings 中出现且只出现一次；from 必须原样来自输入，to 必须存在于 canonicalTags。',
        'canonicalTags 应使用简洁、稳定、适合中文资料库导航的名称。允许创建更合适的规范名称，但不要使用“其他1”“分类A”之类占位名称。',
        '同义、缩写、语言差异、字符损坏、近义和过细子类可以合并；语义无关的标签不得因为数量目标被随意放进同一类。',
        '使用次数 count 越高，越应优先保留其独立导航价值。低频专有名词可以归入相关领域规范标签，原词会由本地程序保存在 keywords 中。',
        attempt > 1 ? '上一次返回没有通过数量或全量映射校验。本次必须严格满足准确数量和 100% 来源映射。' : '',
        '返回格式：{"canonicalTags":["规范标签"],"tagMappings":[{"from":"来源标签","to":"规范标签","reason":"简短依据"}],"summary":"本片归并摘要"}。',
        `来源标签及使用次数：${JSON.stringify(entries)}`
      ].filter(Boolean).join('\n');
      const isResponses = activeConfig.protocol === 'responses';
      const strictSchema = isResponses && schemaModeRef.current === 'strict';
      const body = isResponses ? {
        model: activeConfig.model,
        instructions: '你负责把高基数视频标签逐层压缩成指定数量的受控分类词表，并提供完整可验证映射。',
        input: prompt,
        store: false,
        stream: true,
        text: {
          format: strictSchema ? {
            type: 'json_schema',
            name: 'watchlater_taxonomy_reduction',
            strict: true,
            schema: taxonomyReductionSchema
          } : {type: 'json_object'}
        }
      } : {
        model: activeConfig.model,
        temperature: 0.1,
        response_format: {type: 'json_object'},
        messages: [
          {role: 'system', content: '你负责把高基数视频标签逐层压缩成指定数量的受控分类词表，并提供完整可验证映射。'},
          {role: 'user', content: prompt}
        ]
      };
      const send = () => fetch(LOCAL_AI_PROXY, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({endpoint: activeConfig.endpoint, apiKey: activeConfig.apiKey, body}),
        signal
      });
      try {
        let response = await send();
        if ([400, 422].includes(response.status)) {
          if (isResponses && strictSchema) {
            schemaModeRef.current = 'json_object';
            body.text = {format: {type: 'json_object'}};
          } else if (!isResponses) delete body.response_format;
          response = await send();
        }
        const result = await readAiResponse(response, isResponses, reportStreamProgress);
        reportUsage(result.usage);
        if (!result.content) throw new Error('API 响应中没有结构化正文');
        const parsed = JSON.parse(cleanJson(result.content));
        const canonicalTags = [...new Set((parsed.canonicalTags || []).map(value => String(value).trim()).filter(Boolean))];
        const allowedSources = new Set(entries.map(entry => entry.name));
        const canonicalSet = new Set(canonicalTags);
        const seenSources = new Set();
        const mappings = [];
        for (const mapping of Array.isArray(parsed.tagMappings) ? parsed.tagMappings : []) {
          const from = String(mapping?.from || '').trim();
          const to = String(mapping?.to || '').trim();
          if (!allowedSources.has(from) || !canonicalSet.has(to) || seenSources.has(from)) continue;
          seenSources.add(from);
          mappings.push({from, to, reason: String(mapping.reason || '').trim()});
        }
        const unusedCanonical = canonicalTags.filter(name => !mappings.some(mapping => mapping.to === name));
        if (canonicalTags.length !== targetCount || mappings.length !== entries.length || unusedCanonical.length) {
          throw new Error(`结构校验失败：规范标签 ${canonicalTags.length}/${targetCount}，来源映射 ${mappings.length}/${entries.length}，未使用规范标签 ${unusedCanonical.length}`);
        }
        return {canonicalTags, tagMappings: mappings, summary: String(parsed.summary || '').trim()};
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('统一规格请求失败');
  };

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    pauseRef.current = false;
    setTask(current => ({...current, status: 'running', lastError: ''}));
    const activeConfig = activeConfigRef.current;
    const batchSize = activeConfig.batchSize;
    const concurrency = activeConfig.concurrency;
    try {
      while (cursorRef.current < queueRef.current.length) {
        if (pauseRef.current || stopRef.current) break;
        const jobs = [];
        for (let index = 0; index < concurrency && cursorRef.current < queueRef.current.length; index++) {
          const start = cursorRef.current;
          const batch = queueRef.current.slice(start, start + batchSize);
          const batchNumber = Math.floor(start / batchSize) + 1;
          cursorRef.current += batch.length;
          jobs.push({batch, batchNumber});
        }
        setTask(current => ({
          ...current,
          status: 'running',
          currentBatches: jobs.map(job => job.batchNumber),
          currentIds: jobs.flatMap(job => job.batch.map(item => item.id))
        }));

        const outcomes = await Promise.all(jobs.map(async job => {
          const controller = new AbortController();
          abortRefs.current.add(controller);
          try {
            const results = await requestBatch(job.batch, activeConfig, controller.signal);
            return {...job, results};
          } catch (error) {
            return {...job, error};
          } finally {
            abortRefs.current.delete(controller);
          }
        }));

        let completed = 0;
        let succeeded = 0;
        let failed = 0;
        let settledBatches = 0;
        let lastMessage = '';
        let lastError = '';
        for (const outcome of outcomes) {
          if (outcome.error?.name === 'AbortError' && stopRef.current) continue;
          completed += outcome.batch.length;
          settledBatches++;
          if (outcome.error) {
            failed += outcome.batch.length;
            lastError = `第 ${outcome.batchNumber} 批失败：${outcome.error.message}`;
            continue;
          }
          try {
            await onApplyBatch(outcome.results, activeConfig.model);
            updateKnownTags(outcome.results);
            const matched = new Set(outcome.results.map(item => item.id));
            succeeded += outcome.results.length;
            failed += outcome.batch.filter(item => !matched.has(item.id)).length;
            lastMessage = `第 ${outcome.batchNumber} 批已保存 ${outcome.results.length} 条到${storageLabel}`;
          } catch (error) {
            failed += outcome.batch.length;
            lastError = `第 ${outcome.batchNumber} 批保存失败：${error.message}`;
          }
        }
        setTask(current => ({
          ...current,
          completed: current.completed + completed,
          succeeded: current.succeeded + succeeded,
          failed: current.failed + failed,
          batch: current.batch + settledBatches,
          vocabularySize: tagCountsRef.current.size,
          currentBatches: [],
          currentIds: [],
          lastMessage: lastMessage || current.lastMessage,
          lastError
        }));
      }
      setTask(current => ({
        ...current,
        status: stopRef.current ? 'stopped' : pauseRef.current ? 'paused' : 'completed',
        finishedAt: pauseRef.current ? '' : new Date().toISOString(),
        currentBatches: [],
        currentIds: [],
        lastMessage: !stopRef.current && !pauseRef.current
          ? current.succeeded
            ? '批量打标签已完成。受控词表模式不会产生新主标签；如仍有历史同义名称，可执行一次“同义清洗”。'
            : '批量打标签已结束，但没有成功保存任何结果。请先检查错误，不要立即执行同义清洗。'
          : current.lastMessage
      }));
    } finally {
      abortRefs.current.clear();
      runningRef.current = false;
    }
  };

  const startClassification = () => {
    const activeConfig = saveConfig(config);
    if (!activeConfig.endpoint || !activeConfig.model || !activeConfig.apiKey) {
      setTask(current => ({...current, status: 'failed', lastError: '请填写 API 地址、模型和 API Key'}));
      return;
    }
    queueRef.current = [...candidates];
    cursorRef.current = 0;
    activeConfigRef.current = activeConfig;
    tagCountsRef.current = tagCountsOf(allItems);
    schemaModeRef.current = 'strict';
    pauseRef.current = false;
    stopRef.current = false;
    const batches = Math.ceil(queueRef.current.length / activeConfig.batchSize);
    const startedAt = new Date().toISOString();
    setTask({
      mode: 'classify',
      status: queueRef.current.length ? 'running' : 'completed',
      total: queueRef.current.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      batch: 0,
      batches,
      currentBatches: [],
      currentIds: [],
      vocabularySize: tagCountsRef.current.size,
      streamEvents: 0,
      responseBytes: 0,
      lastActivityAt: '',
      startedAt,
      finishedAt: queueRef.current.length ? '' : startedAt,
      usage: emptyUsage(),
      lastMessage: queueRef.current.length
        ? `已建立 ${batches} 个批次，并发 ${activeConfig.concurrency}`
        : '当前范围没有需要处理的视频',
      lastError: ''
    });
    if (queueRef.current.length) void run();
  };

  const startConsolidation = async () => {
    if (runningRef.current) return;
    const activeConfig = saveConfig(config);
    if (!activeConfig.endpoint || !activeConfig.model || !activeConfig.apiKey) {
      setTask(current => ({...current, status: 'failed', lastError: '请填写 API 地址、模型和 API Key'}));
      return;
    }
    const vocabulary = globalVocabularyOf(allItems);
    const vocabularySize = vocabulary.length;
    if (!vocabularySize) {
      setTask(current => ({...current, mode: 'consolidate', status: 'failed', lastError: '当前资料库还没有可归核的标签或分类词汇'}));
      return;
    }
    runningRef.current = true;
    stopRef.current = false;
    activeConfigRef.current = activeConfig;
    schemaModeRef.current = 'strict';
    const controller = new AbortController();
    abortRefs.current.add(controller);
    const chunks = consolidationChunksOf(
      vocabulary,
      activeConfig.consolidationThreshold,
      activeConfig.consolidationChunkSize
    );
    const startedAt = new Date().toISOString();
    setTask({
      mode: 'consolidate', status: 'running', total: vocabularySize, completed: 0,
      succeeded: 0, failed: 0, batch: 0, batches: chunks.length, currentBatches: [1], currentIds: [],
      vocabularySize,
      streamEvents: 0, responseBytes: 0, lastActivityAt: '', startedAt, finishedAt: '', usage: emptyUsage(),
      lastMessage: chunks.length === 1
        ? `正在归核 ${vocabularySize} 个全库词汇`
        : `已切成 ${chunks.length} 片，将按顺序归核；每片最多 ${activeConfig.consolidationChunkSize} 个来源词`,
      lastError: ''
    });
    let processed = 0;
    try {
      const combinedMappings = [];
      const mappingMap = new Map();
      const summaries = [];
      for (let index = 0; index < chunks.length; index++) {
        if (stopRef.current) throw new DOMException('任务已停止', 'AbortError');
        const chunk = chunks[index];
        const sourceNames = new Set(chunk.map(entry => entry.name));
        const anchors = index === 0 ? [] : canonicalAnchorsOf(
          vocabulary,
          mappingMap,
          activeConfig.consolidationAnchorSize
        ).filter(entry => !sourceNames.has(entry.name));
        setTask(current => ({
          ...current,
          currentBatches: [index + 1],
          lastMessage: `正在流式归核第 ${index + 1}/${chunks.length} 片：${chunk.length} 个来源词，${anchors.length} 个跨片规范锚点`
        }));
        const plan = await requestConsolidation(
          chunk,
          anchors,
          activeConfig,
          controller.signal,
          index + 1,
          chunks.length
        );
        if (stopRef.current) throw new DOMException('任务已停止', 'AbortError');
        for (const mapping of plan.tagMappings) {
          mappingMap.set(mapping.from, mapping.to);
          combinedMappings.push(mapping);
        }
        if (plan.summary) summaries.push(`第 ${index + 1} 片：${plan.summary}`);
        processed += chunk.length;
        setTask(current => ({
          ...current,
          completed: processed,
          succeeded: processed,
          batch: index + 1,
          currentBatches: [],
          lastMessage: `第 ${index + 1}/${chunks.length} 片完成，累计获得 ${combinedMappings.length} 条候选映射；全部完成前不会修改本地资料库`
        }));
      }
      const result = await onApplyConsolidation({
        tagMappings: combinedMappings,
        summary: summaries.join('\n')
      }, activeConfig.model);
      setTask(current => ({
        ...current,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        completed: vocabularySize,
        succeeded: vocabularySize,
        batch: chunks.length,
        currentBatches: [],
        vocabularySize: result.finalVocabularySize,
        lastMessage: `同义清洗完成：词表 ${vocabularySize} -> ${result.finalVocabularySize}，应用 ${result.mappingCount} 条映射，更新 ${result.changedItems} 个视频，已保存到${storageLabel}`,
        lastError: ''
      }));
    } catch (error) {
      if (error.name === 'AbortError' && stopRef.current) {
        setTask(current => ({...current, status: 'stopped', finishedAt: new Date().toISOString(), currentBatches: [], lastMessage: '同义清洗已停止，未应用映射'}));
      } else {
        setTask(current => ({...current, status: 'failed', finishedAt: new Date().toISOString(), failed: vocabularySize - processed, currentBatches: [], lastError: `同义清洗失败：${error.message}`}));
      }
    } finally {
      abortRefs.current.delete(controller);
      runningRef.current = false;
    }
  };

  const startUnification = async () => {
    if (runningRef.current) return;
    const activeConfig = saveConfig(config);
    if (!activeConfig.endpoint || !activeConfig.model || !activeConfig.apiKey) {
      setTask(current => ({...current, mode: 'unify', status: 'failed', lastError: '请填写 API 地址、模型和 API Key'}));
      return;
    }
    const vocabulary = globalVocabularyOf(allItems);
    const targetCount = activeConfig.unificationTarget;
    if (!vocabulary.length) {
      setTask(current => ({...current, mode: 'unify', status: 'failed', lastError: '当前资料库没有可统一的主标签'}));
      return;
    }
    if (vocabulary.length < targetCount) {
      setTask(current => ({...current, mode: 'unify', status: 'failed', lastError: `目标 ${targetCount} 大于当前 ${vocabulary.length} 个标签；统一规格只做归并，不凭空创造分类` }));
      return;
    }

    const initialRounds = unificationRoundsOf(vocabulary.length, targetCount, activeConfig.unificationChunkSize);
    const estimatedRequests = initialRounds.reduce((sum, round) => sum + round.chunkLengths.length, 0);
    runningRef.current = true;
    stopRef.current = false;
    activeConfigRef.current = activeConfig;
    schemaModeRef.current = 'strict';
    setPendingPlan(null);
    const startedAt = new Date().toISOString();
    setTask({
      mode: 'unify', status: 'running', total: estimatedRequests, completed: 0,
      succeeded: 0, failed: 0, batch: 0, batches: estimatedRequests, currentBatches: [], currentIds: [],
      vocabularySize: vocabulary.length, streamEvents: 0, responseBytes: 0, lastActivityAt: '',
      startedAt, finishedAt: '', usage: emptyUsage(),
      lastMessage: `计划把 ${vocabulary.length} 个主标签分层收敛到准确的 ${targetCount} 个；结果生成后先预览，不会直接写库`,
      lastError: ''
    });

    const originalToCurrent = new Map(vocabulary.map(entry => [entry.name, entry.name]));
    let working = vocabulary;
    let processedRequests = 0;
    let roundNumber = 0;
    let completedFinalRound = false;
    const roundAudit = [];
    const summaries = [];
    try {
      while (!completedFinalRound) {
        if (stopRef.current) throw new DOMException('任务已停止', 'AbortError');
        if (roundNumber >= 12) throw new Error('统一规格超过 12 轮仍未收敛，请减小每片词汇数或提高目标数量');
        roundNumber++;
        const finalInputLimit = Math.max(activeConfig.unificationChunkSize, targetCount + 50);
        const finalRound = working.length <= finalInputLimit;
        const chunks = finalRound
          ? [working]
          : Array.from({length: Math.ceil(working.length / activeConfig.unificationChunkSize)}, (_, index) =>
            working.slice(index * activeConfig.unificationChunkSize, (index + 1) * activeConfig.unificationChunkSize));
        const desiredTotal = finalRound ? targetCount : Math.max(targetCount + 1, Math.ceil(working.length / 2));
        const quotas = allocateQuotas(chunks.map(chunk => chunk.length), desiredTotal);
        const estimatedRoundCount = Math.max(roundNumber, unificationRoundsOf(working.length, targetCount, activeConfig.unificationChunkSize).length + roundNumber - 1);
        setTask(current => ({
          ...current,
          currentBatches: chunks.map((_, index) => `R${roundNumber}-${index + 1}`),
          lastMessage: finalRound
            ? `第 ${roundNumber} 轮为全局终局：${working.length} -> ${targetCount}，一次请求统一全部候选词`
            : `第 ${roundNumber} 轮：${working.length} -> 约 ${desiredTotal}，${chunks.length} 片、并发 ${activeConfig.unificationConcurrency}`
        }));

        const plans = await mapConcurrent(chunks, activeConfig.unificationConcurrency, async (chunk, index) => {
          const controller = new AbortController();
          abortRefs.current.add(controller);
          try {
            const plan = await requestTaxonomyChunk(
              chunk,
              quotas[index],
              activeConfig,
              controller.signal,
              roundNumber,
              estimatedRoundCount,
              index + 1,
              chunks.length
            );
            processedRequests++;
            setTask(current => ({
              ...current,
              completed: processedRequests,
              succeeded: processedRequests,
              batch: processedRequests,
              lastMessage: `第 ${roundNumber} 轮第 ${index + 1}/${chunks.length} 片通过校验：${chunk.length} -> ${plan.canonicalTags.length}`
            }));
            return plan;
          } finally {
            abortRefs.current.delete(controller);
          }
        });

        const roundMap = new Map();
        const nextCounts = new Map();
        for (let index = 0; index < chunks.length; index++) {
          const entryCounts = new Map(chunks[index].map(entry => [entry.name, entry.count]));
          const plan = plans[index];
          for (const mapping of plan.tagMappings) {
            roundMap.set(mapping.from, mapping.to);
            nextCounts.set(mapping.to, (nextCounts.get(mapping.to) || 0) + (entryCounts.get(mapping.from) || 0));
          }
          if (plan.summary) summaries.push(`第 ${roundNumber} 轮第 ${index + 1} 片：${plan.summary}`);
        }
        for (const [source, current] of originalToCurrent) {
          const next = roundMap.get(current);
          if (!next) throw new Error(`第 ${roundNumber} 轮遗漏候选词映射：${current}`);
          originalToCurrent.set(source, next);
        }
        const previousCount = working.length;
        working = sortedTagEntries(nextCounts, Number.MAX_SAFE_INTEGER);
        if (working.length < targetCount) throw new Error(`第 ${roundNumber} 轮跨片名称重复导致过度压缩：只剩 ${working.length} 个，低于目标 ${targetCount}`);
        if (working.length >= previousCount && previousCount > targetCount) throw new Error(`第 ${roundNumber} 轮没有收敛：${previousCount} -> ${working.length}`);
        roundAudit.push({round: roundNumber, inputCount: previousCount, outputCount: working.length, requests: chunks.length});

        const remainingPlan = unificationRoundsOf(working.length, targetCount, activeConfig.unificationChunkSize);
        completedFinalRound = finalRound && working.length === targetCount;
        const remainingRequests = completedFinalRound
          ? 0
          : remainingPlan.reduce((sum, round) => sum + round.chunkLengths.length, 0);
        setTask(current => ({
          ...current,
          total: processedRequests + remainingRequests,
          batches: processedRequests + remainingRequests,
          vocabularySize: working.length,
          currentBatches: [],
          lastMessage: `第 ${roundNumber} 轮完成：${previousCount} -> ${working.length}；${completedFinalRound ? '终局全量审视通过，正在生成预览' : working.length === targetCount ? '已达到数量目标，仍需 1 次终局全量审视' : `预计还需 ${remainingRequests} 个请求`}`
        }));
      }

      const finalCanonical = working.map(entry => entry.name);
      const finalSet = new Set(finalCanonical);
      const sourceMappings = vocabulary.map(entry => ({
        source: entry.name,
        count: entry.count,
        target: originalToCurrent.get(entry.name)
      }));
      if (finalSet.size !== targetCount || sourceMappings.some(mapping => !finalSet.has(mapping.target))) {
        throw new Error('最终规范词表或来源映射没有通过本地闭包校验');
      }
      const plan = {
        requestedTargetCount: targetCount,
        sourceUniqueTagCount: vocabulary.length,
        canonicalTags: working,
        sourceMappings,
        rounds: roundAudit,
        summary: summaries.join('\n')
      };
      setPendingPlan(plan);
      setTask(current => ({
        ...current,
        status: 'review',
        finishedAt: new Date().toISOString(),
        completed: processedRequests,
        succeeded: processedRequests,
        total: processedRequests,
        batches: processedRequests,
        batch: processedRequests,
        vocabularySize: finalCanonical.length,
        currentBatches: [],
        lastMessage: `统一规格提案已生成：${vocabulary.length} -> ${finalCanonical.length}。请检查预览，确认后才会备份并写入${storageLabel}`,
        lastError: ''
      }));
    } catch (error) {
      for (const controller of abortRefs.current) controller.abort();
      const stopped = error.name === 'AbortError' && stopRef.current;
      setTask(current => ({
        ...current,
        status: stopped ? 'stopped' : 'failed',
        finishedAt: new Date().toISOString(),
        failed: stopped ? 0 : 1,
        currentBatches: [],
        lastMessage: stopped ? '统一规格已停止；没有修改任何视频或 taxonomy' : current.lastMessage,
        lastError: stopped ? '' : `统一规格失败：${error.message}`
      }));
    } finally {
      abortRefs.current.clear();
      runningRef.current = false;
    }
  };

  const applyPendingTaxonomy = async () => {
    if (!pendingPlan || runningRef.current) return;
    runningRef.current = true;
    setTask(current => ({...current, status: 'applying', finishedAt: '', lastMessage: '正在创建备份并应用统一规格...', lastError: ''}));
    try {
      const result = await onApplyTaxonomy(pendingPlan, config.model);
      setPendingPlan(null);
      setTask(current => ({
        ...current,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        vocabularySize: result.finalVocabularySize,
        lastMessage: `统一规格已应用：最终 ${result.finalVocabularySize} 个主标签，更新 ${result.changedItems} 条视频${result.backupFile ? `；备份：${result.backupFile}` : '；应用前快照已下载'}`,
        lastError: ''
      }));
    } catch (error) {
      setTask(current => ({...current, status: 'failed', finishedAt: new Date().toISOString(), lastError: `应用统一规格失败：${error.message}`}));
    } finally {
      runningRef.current = false;
    }
  };

  const pause = () => {
    pauseRef.current = true;
    setTask(current => ({...current, status: 'pausing', lastMessage: '当前并发波次完成后暂停'}));
  };
  const resume = () => {
    pauseRef.current = false;
    void run();
  };
  const stop = () => {
    stopRef.current = true;
    pauseRef.current = false;
    for (const controller of abortRefs.current) controller.abort();
    setTask(current => ({
      ...current,
      status: 'stopping',
      lastMessage: current.mode === 'classify'
        ? '正在停止，已保存的批次会保留'
        : '正在停止；统一任务尚未整体完成，不会应用任何映射'
    }));
  };

  const percent = task.total ? Math.round(task.completed / task.total * 1000) / 10 : 0;
  const active = ['running', 'pausing', 'stopping', 'applying'].includes(task.status);
  const shownIds = task.currentIds.slice(0, 12);
  const hiddenIds = Math.max(0, task.currentIds.length - shownIds.length);
  const globalTermCount = currentGlobalVocabulary.length;
  const unprocessedCount = allItems.filter(item => !item.ai?.processedAt).length;
  const previewThreshold = normalizeConsolidationThreshold(config.consolidationThreshold);
  const previewChunkSize = normalizeConsolidationChunkSize(config.consolidationChunkSize);
  const consolidationRequestCount = globalTermCount
    ? consolidationChunksOf(currentGlobalVocabulary, previewThreshold, previewChunkSize).length
    : 0;
  const elapsedUntil = task.finishedAt ? Date.parse(task.finishedAt) : clock;
  const elapsedMs = task.startedAt ? Math.max(0, elapsedUntil - Date.parse(task.startedAt)) : 0;
  const usage = task.usage || emptyUsage();
  const targetPreview = normalizeUnificationTarget(config.unificationTarget);
  const chunkPreview = normalizeUnificationChunkSize(config.unificationChunkSize);
  const unificationRounds = globalTermCount >= targetPreview
    ? unificationRoundsOf(globalTermCount, targetPreview, chunkPreview)
    : [];
  const unificationRequestCount = unificationRounds.reduce((sum, round) => sum + round.chunkLengths.length, 0);
  const help = AI_HELP[helpTopic];

  return <div className="overlay"><div className="modal ai-modal">
    <div className="modal-head"><div><h2><Bot size={20}/>AI 分类任务</h2><p>批量补标签与全库统一规格分开运行，配置和进度都可见。</p></div><button title="关闭" disabled={active} onClick={onClose}><X size={18}/></button></div>

    <div className="ai-api-panel">
      <div className="ai-section-title"><KeyRound size={17}/><div><strong>API 配置</strong><span>两种任务共用同一个 API、模型和 Key。</span></div><HelpButton label="API 配置" onClick={() => setHelpTopic('api')}/></div>
      <div className="ai-api-grid">
        <label>API 协议<select disabled={active} value={config.protocol} onChange={event => {
          const protocol = event.target.value;
          const knownEndpoint = config.endpoint === 'https://api.openai.com/v1/responses' || config.endpoint === 'https://api.openai.com/v1/chat/completions';
          setConfig({...config, protocol, endpoint: knownEndpoint
            ? protocol === 'responses' ? 'https://api.openai.com/v1/responses' : 'https://api.openai.com/v1/chat/completions'
            : config.endpoint});
        }}><option value="responses">Responses API（推荐）</option><option value="chat-completions">Chat Completions（兼容）</option></select></label>
        <label>模型<input disabled={active} value={config.model} onChange={event => setConfig({...config, model: event.target.value.trim()})}/></label>
        <label className="wide">API 地址<input disabled={active} value={config.endpoint} onChange={event => setConfig({...config, endpoint: event.target.value.trim()})}/></label>
        <label className="wide">API Key<input disabled={active} type="password" autoComplete="off" value={config.apiKey} onChange={event => setConfig({...config, apiKey: event.target.value})}/></label>
      </div>
    </div>

    <div className="ai-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={activeTab === 'classify'} className={activeTab === 'classify' ? 'active' : ''} disabled={active} onClick={() => setActiveTab('classify')}><Tags size={17}/><span><strong>批量打标签</strong><small>逐批处理视频元数据</small></span></button>
      <button type="button" role="tab" aria-selected={activeTab === 'unify'} className={activeTab === 'unify' ? 'active' : ''} disabled={active} onClick={() => setActiveTab('unify')}><Layers3 size={17}/><span><strong>统一规格</strong><small>把全库主标签归合到目标数量</small></span></button>
    </div>

    {activeTab === 'classify' && <section className="ai-tab-page" role="tabpanel">
      <div className="ai-form">
        <label><span className="ai-label-row">每批视频数<HelpButton label="每批视频数" onClick={() => setHelpTopic('batch')}/></span><input disabled={active} type="number" min="5" max="40" value={config.batchSize} onChange={event => setConfig({...config, batchSize: event.target.value})}/></label>
        <label><span className="ai-label-row">并发请求数<HelpButton label="并发请求数" onClick={() => setHelpTopic('concurrency')}/></span><input disabled={active} type="number" min="1" value={config.concurrency} onChange={event => setConfig({...config, concurrency: event.target.value})}/></label>
        <label>处理范围<select disabled={active} value={config.scope} onChange={event => setConfig({...config, scope: event.target.value})}>
          <option value="unprocessed">尚未由 AI 处理（{unprocessedCount}）</option>
          <option value="filtered">当前筛选结果（{filteredItems.length}）</option>
          <option value="all">全部视频（{allItems.length}）</option>
        </select></label>
        <div className="ai-vocabulary-note"><strong>当前主标签：{currentVocabularySize} 个</strong><span>{lockedCanonicalTags.length ? `taxonomy 已锁定为 ${lockedCanonicalTags.length} 个规范标签；所有批次使用同一词表。` : '尚未锁定 taxonomy；成功批次产生的新标签会加入后续波次。'}</span></div>
        <label className="wide">分类规则<textarea disabled={active} rows="3" value={config.instructions} onChange={event => setConfig({...config, instructions: event.target.value})}/></label>
      </div>
    </section>}

    {activeTab === 'unify' && <section className="ai-tab-page" role="tabpanel">
      <div className="ai-unification-panel">
        <div className="ai-section-title"><Sparkles size={17}/><div><strong>目标数量归合</strong><span>分层切片生成完整映射，终局请求强制得到准确数量；先预览，后应用。</span></div><HelpButton label="分层收敛" onClick={() => setHelpTopic('hierarchy')}/></div>
        <div className="ai-unification-controls">
          <label><span className="ai-label-row">最终主标签数<HelpButton label="最终标签目标" onClick={() => setHelpTopic('target')}/></span><input disabled={active} type="number" min="20" max="500" value={config.unificationTarget} onChange={event => setConfig({...config, unificationTarget: event.target.value})}/></label>
          <label>每片词汇数<input disabled={active} type="number" min="50" max="1000" value={config.unificationChunkSize} onChange={event => setConfig({...config, unificationChunkSize: event.target.value})}/></label>
          <label>同轮并发数<input disabled={active} type="number" min="1" value={config.unificationConcurrency} onChange={event => setConfig({...config, unificationConcurrency: event.target.value})}/></label>
          <label><span className="ai-label-row">归并尺度<HelpButton label="归并尺度" onClick={() => setHelpTopic('mergeScale')}/></span><select disabled={active} value={config.unificationStrength} onChange={event => setConfig({...config, unificationStrength: event.target.value})}><option value="conservative">保守分层</option><option value="balanced">均衡归类</option><option value="aggressive">强力收敛</option></select></label>
        </div>
        <div className="ai-global-stats"><span>当前 {globalTermCount} 个</span><span>目标 {targetPreview} 个</span><span>预计 {unificationRounds.length} 轮</span><span>约 {unificationRequestCount} 个请求</span><span>终局全量审视</span></div>
        {globalTermCount < targetPreview && <p className="ai-global-warning">目标数量大于当前标签数。统一规格只做归并，请把目标调到 {globalTermCount} 或更小。</p>}
        {unificationRounds.length > 0 && <div className="ai-round-preview">{unificationRounds.map((round, index) => <span key={`${round.inputCount}-${index}`}>第 {index + 1} 轮：{round.inputCount} → {round.outputCount} · {round.chunkLengths.length} 请求</span>)}</div>}
      </div>

      <div className="ai-synonym-panel">
        <div className="ai-section-title"><GitMerge size={17}/><div><strong>仅做同义清洗</strong><span>不改变数量目标，只统一缩写、语言、格式和可安全替换的名称。</span></div><HelpButton label="同义判定" onClick={() => setHelpTopic('synonym')}/></div>
        <div className="ai-global-controls">
          <label>切片阈值<input disabled={active} type="number" min="1" value={config.consolidationThreshold} onChange={event => setConfig({...config, consolidationThreshold: event.target.value})}/></label>
          <label>每片词汇数<input disabled={active} type="number" min="1" value={config.consolidationChunkSize} onChange={event => setConfig({...config, consolidationChunkSize: event.target.value})}/></label>
          <label>规范锚点数<input disabled={active} type="number" min="1" value={config.consolidationAnchorSize} onChange={event => setConfig({...config, consolidationAnchorSize: event.target.value})}/></label>
          <label>同义判定<select disabled={active} value={config.consolidationStrength} onChange={event => setConfig({...config, consolidationStrength: event.target.value})}><option value="conservative">严格同义</option><option value="balanced">同义与无损近义</option><option value="aggressive">含安全上下位归并</option></select></label>
        </div>
        <div className="ai-global-stats"><span>唯一标签 {globalTermCount}</span><span>预计请求 {consolidationRequestCount}</span><span>严格顺序执行</span><span>不发送视频详情</span></div>
      </div>
    </section>}

    {pendingPlan && <section className="taxonomy-preview">
      <div className="taxonomy-preview-head"><div><strong>统一规格提案</strong><span>{pendingPlan.sourceUniqueTagCount} → {pendingPlan.requestedTargetCount}，尚未写入数据库</span></div><span>{pendingPlan.sourceMappings.length} 条来源映射已闭包验证</span></div>
      <div className="taxonomy-rounds">{pendingPlan.rounds.map(round => <span key={round.round}>第 {round.round} 轮 {round.inputCount} → {round.outputCount} · {round.requests} 请求</span>)}</div>
      <div className="taxonomy-tags">{pendingPlan.canonicalTags.slice(0, 80).map(entry => <span key={entry.name}>{entry.name}<small>{entry.count}</small></span>)}{pendingPlan.canonicalTags.length > 80 && <span>另有 {pendingPlan.canonicalTags.length - 80} 个</span>}</div>
    </section>}

    <div className={`ai-task status-${task.status}`}>
      <div className="ai-task-head"><strong>{modeLabels[task.mode]} · {statusLabels[task.status] || task.status}</strong><span>词表 {task.vocabularySize || currentVocabularySize} 个 · {task.mode === 'classify' ? `并发 ${activeConfigRef.current?.concurrency || normalizeConcurrency(config.concurrency)}` : `请求 ${task.completed}/${task.total}`}</span></div>
      <div className="progress-track"><div style={{width: `${percent}%`}}/></div>
      <div className="ai-metrics"><span>{task.completed}/{task.total}</span><span>成功 {task.succeeded}</span><span>失败 {task.failed}</span><span>进度 {task.batch}/{task.batches}</span><span>{percent}%</span></div>
      <div className="ai-stream-metrics">
        <span>耗时 <strong>{formatDuration(elapsedMs)}</strong></span><span>流事件 <strong>{formatNumber(task.streamEvents)}</strong></span><span>已接收 <strong>{formatBytes(task.responseBytes)}</strong></span><span>输入 Token <strong>{formatNumber(usage.inputTokens)}</strong></span><span>输出 Token <strong>{formatNumber(usage.outputTokens)}</strong></span><span>推理 Token <strong>{formatNumber(usage.reasoningTokens)}</strong></span><span>缓存输入 <strong>{formatNumber(usage.cachedInputTokens)}</strong></span><span>总 Token <strong>{formatNumber(usage.totalTokens)}</strong></span>
      </div>
      <p>Responses 使用 SSE 流式传输；本地转发会发送心跳。Token 用量在请求完成事件返回后累计。{task.lastActivityAt ? ` 最近活动：${new Date(task.lastActivityAt).toLocaleTimeString('zh-CN')}` : ''}</p>
      {task.currentBatches.length > 0 && <p>正在请求：{task.currentBatches.join('、')}</p>}
      {shownIds.length > 0 && <p>当前 BV：{shownIds.join('、')}{hiddenIds ? `，另有 ${hiddenIds} 条` : ''}</p>}
      {task.lastMessage && <p className="success">{task.lastMessage}</p>}
      {task.lastError && <p className="error">{task.lastError}</p>}
      <p>保存位置：{storageLabel}；{task.mode === 'classify' ? '成功批次立即保存。' : task.mode === 'unify' ? '提案确认前不写库，确认后创建备份并整库保存一次。' : '所有分片成功后整库保存一次。'}</p>
    </div>

    <div className="modal-actions ai-actions">
      {!active && task.status !== 'paused' && <button className="button" onClick={() => saveConfig(config)}><Save size={16}/>保存配置</button>}
      {activeTab === 'classify' && !active && task.status !== 'paused' && <button className="button primary" onClick={startClassification}><Bot size={16}/>开始批量打标签</button>}
      {activeTab === 'unify' && !active && task.status !== 'paused' && !pendingPlan && <button className="button primary" disabled={globalTermCount < targetPreview} onClick={startUnification}><Layers3 size={16}/>生成目标规格提案</button>}
      {activeTab === 'unify' && !active && task.status !== 'paused' && !pendingPlan && <button className="button" onClick={startConsolidation}><GitMerge size={16}/>仅清洗同义名称</button>}
      {pendingPlan && !active && <button className="button" onClick={() => { setPendingPlan(null); setTask(current => ({...current, status: 'idle', lastMessage: '统一规格提案已放弃，资料库没有修改'})); }}>放弃提案</button>}
      {pendingPlan && !active && <button className="button primary" onClick={applyPendingTaxonomy}><Sparkles size={16}/>备份并应用</button>}
      {task.status === 'running' && task.mode === 'classify' && <button className="button" onClick={pause}><Pause size={16}/>暂停</button>}
      {task.status === 'paused' && <button className="button primary" onClick={resume}><Play size={16}/>继续{modeLabels[task.mode]}</button>}
      {['running', 'pausing', 'paused'].includes(task.status) && <button className="button" onClick={stop}><Square size={15}/>停止</button>}
    </div>

    {help && <HelpDialog title={help.title} onClose={() => setHelpTopic('')}>
      {help.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      {help.bullets?.length > 0 && <ul>{help.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}</ul>}
    </HelpDialog>}
  </div></div>;
}
