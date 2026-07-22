import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Bot, CircleHelp, GitMerge, KeyRound, Pause, Play, Save, Square, X} from 'lucide-react';

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
  scope: 'unprocessed',
  instructions: '优先复用已有标签；每个视频给出 2-6 个简洁中文标签，并给出一个主分类和最多 3 个主题。'
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
const cleanList = (value, limit) => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim())
  .filter(Boolean))].slice(0, limit);
const statusLabels = {
  idle: '尚未开始', running: '处理中', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', stopped: '已停止', completed: '已完成', failed: '失败'
};
const modeLabels = {classify: '增量分类', consolidate: '同义归核'};
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

export function AiTaggingModal({open, allItems, filteredItems, taxonomy, onApplyBatch, onApplyConsolidation, onClose, storageLabel}) {
  const [config, setConfig] = useState(loadConfig);
  const [helpTopic, setHelpTopic] = useState('');
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
    if (!['running', 'pausing', 'stopping'].includes(task.status)) return undefined;
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
        : 'aggressive'
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
            ? '增量分类已完成。受控词表模式不会产生新主标签；如仍有历史同义名称，可执行一次“同义归核”。'
            : '增量分类已结束，但没有成功保存任何结果。请先检查错误，不要立即执行同义归核。'
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
        lastMessage: `同义归核完成：词表 ${vocabularySize} -> ${result.finalVocabularySize}，应用 ${result.mappingCount} 条映射，更新 ${result.changedItems} 个视频，已保存到${storageLabel}`,
        lastError: ''
      }));
    } catch (error) {
      if (error.name === 'AbortError' && stopRef.current) {
        setTask(current => ({...current, status: 'stopped', finishedAt: new Date().toISOString(), currentBatches: [], lastMessage: '同义归核已停止，未应用映射'}));
      } else {
        setTask(current => ({...current, status: 'failed', finishedAt: new Date().toISOString(), failed: vocabularySize - processed, currentBatches: [], lastError: `同义归核失败：${error.message}`}));
      }
    } finally {
      abortRefs.current.delete(controller);
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
      lastMessage: current.mode === 'consolidate'
        ? '正在停止；归核尚未整体完成，不会应用任何映射'
        : '正在停止，已保存的批次会保留'
    }));
  };

  const percent = task.total ? Math.round(task.completed / task.total * 1000) / 10 : 0;
  const active = ['running', 'pausing', 'stopping'].includes(task.status);
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

  return <div className="overlay"><div className="modal ai-modal">
    <div className="modal-head"><div><h2><Bot size={20}/>AI 分类任务</h2><p>锁定词表时，AI 只选择已有主标签，并把具体名称写入可搜索关键词。</p></div><button title="关闭" disabled={active} onClick={onClose}><X size={18}/></button></div>
    <div className="ai-key-note"><KeyRound size={17}/><span>请求通过本机 4175 服务转发。API Key 保存于 localStorage 的 <code>{STORAGE_KEY}</code>，不会写入导出 JSON、本地数据库或服务日志。共享电脑不建议保存长期密钥。</span></div>
    <div className="ai-form">
      <label>API 协议<select disabled={active} value={config.protocol} onChange={event => {
        const protocol = event.target.value;
        const knownEndpoint = config.endpoint === 'https://api.openai.com/v1/responses' || config.endpoint === 'https://api.openai.com/v1/chat/completions';
        setConfig({
          ...config,
          protocol,
          endpoint: knownEndpoint
            ? protocol === 'responses' ? 'https://api.openai.com/v1/responses' : 'https://api.openai.com/v1/chat/completions'
            : config.endpoint
        });
      }}><option value="responses">Responses API（推荐）</option><option value="chat-completions">Chat Completions（兼容）</option></select></label>
      <label className="wide">API 地址<input disabled={active} value={config.endpoint} onChange={event => setConfig({...config, endpoint: event.target.value.trim()})}/></label>
      <label>模型<input disabled={active} value={config.model} onChange={event => setConfig({...config, model: event.target.value.trim()})}/></label>
      <label className="wide">API Key<input disabled={active} type="password" autoComplete="off" value={config.apiKey} onChange={event => setConfig({...config, apiKey: event.target.value})}/></label>

      <label><span className="ai-label-row">每批视频数<button type="button" className="ai-help-button" title="解释每批视频数" onClick={() => setHelpTopic(helpTopic === 'batch' ? '' : 'batch')}><CircleHelp size={15}/></button></span><input disabled={active} type="number" min="5" max="40" value={config.batchSize} onChange={event => setConfig({...config, batchSize: event.target.value})}/></label>
      <label><span className="ai-label-row">并发请求数<button type="button" className="ai-help-button" title="解释并发请求数" onClick={() => setHelpTopic(helpTopic === 'concurrency' ? '' : 'concurrency')}><CircleHelp size={15}/></button></span><input disabled={active} type="number" min="1" value={config.concurrency} onChange={event => setConfig({...config, concurrency: event.target.value})}/></label>
      {helpTopic === 'batch' && <div className="ai-help-panel wide"><strong>每批视频数就是一次 API 请求里的视频数量。</strong><span>默认 20 表示把 20 个相互独立的视频元数据一次发给模型，并在同一次响应中取回 20 组标签。它不是相关推荐数量，也不是连续发起 20 次请求。</span></div>}
      {helpTopic === 'concurrency' && <div className="ai-help-panel wide"><strong>并发决定同时进行几个完整批次请求，没有程序上限。</strong><span>实际同时请求数不会超过剩余批次数。数值过高可能触发 429、RPM/TPM 限制、连接耗尽和瞬时高额 Token 消耗；锁定受控词表后，各并发批次使用同一套主标签，不再依赖互相交换新标签。</span></div>}

      <label>增量处理范围<select disabled={active} value={config.scope} onChange={event => setConfig({...config, scope: event.target.value})}>
        <option value="unprocessed">尚未由 AI 处理（{allItems.filter(item => !item.ai?.processedAt).length}）</option>
        <option value="filtered">当前筛选结果（{filteredItems.length}）</option>
        <option value="all">全部视频（{allItems.length}）</option>
      </select></label>
      <div className="ai-vocabulary-note"><strong>当前全库标签词表：{currentVocabularySize} 个</strong><span>{lockedCanonicalTags.length ? `受控词表已锁定为 ${lockedCanonicalTags.length} 个规范标签；所有批次使用同一词表。` : '增量任务开始时从完整资料库统计；成功批次产生的新标签会加入后续波次的提示词。'}</span></div>

      <div className="ai-global-settings wide">
        <div className="ai-global-title"><GitMerge size={17}/><div><strong>同义归核 <button type="button" className="ai-help-button" title="解释同义归核" onClick={() => setHelpTopic(helpTopic === 'global' ? '' : 'global')}><CircleHelp size={15}/></button></strong><span>只统一缩写、语言和明确同义名称，不负责把词表压缩到目标数量。目标压缩请使用项目脚本和正式规范。</span></div></div>
        <div className="ai-global-controls">
          <label>切片阈值<input disabled={active} type="number" min="1" value={config.consolidationThreshold} onChange={event => setConfig({...config, consolidationThreshold: event.target.value})}/></label>
          <label>每片词汇数<input disabled={active} type="number" min="1" value={config.consolidationChunkSize} onChange={event => setConfig({...config, consolidationChunkSize: event.target.value})}/></label>
          <label>规范锚点数<input disabled={active} type="number" min="1" value={config.consolidationAnchorSize} onChange={event => setConfig({...config, consolidationAnchorSize: event.target.value})}/></label>
          <label>同义判定<select disabled={active} value={config.consolidationStrength} onChange={event => setConfig({...config, consolidationStrength: event.target.value})}><option value="conservative">严格同义</option><option value="balanced">同义与无损近义</option><option value="aggressive">含安全上下位归并</option></select></label>
        </div>
        <div className="ai-global-stats"><span>唯一标签 {globalTermCount}</span><span>视频 {allItems.length}</span><span>预计请求 {consolidationRequestCount}</span><span>顺序执行</span><span>视频详情 0</span></div>
        {unprocessedCount > 0 && <p className="ai-global-warning">尚有 {unprocessedCount} 条视频未完成初次 AI 分类。现在也能归核，但通常应先完成增量分类，否则之后产生的新标签还需要再次归核。</p>}
        {helpTopic === 'global' && <div className="ai-help-panel"><strong>这是命名清洗，不是数量预算器。</strong><span>默认超过 1000 个词时，每 500 个来源词组成一个顺序请求。后一片继承高频规范锚点；锁定 taxonomy 后只把词表外历史别名映射到规范标签，不允许规范标签彼此合并。未映射名称原样保留，任何一片失败或停止都不会修改资料库。目标压缩流程见 docs/TAG-COMPRESSION-SPEC.md。</span></div>}
      </div>

      <label className="wide">分类规则<textarea disabled={active} rows="3" value={config.instructions} onChange={event => setConfig({...config, instructions: event.target.value})}/></label>
    </div>
    <div className={`ai-task status-${task.status}`}>
      <div className="ai-task-head"><strong>{modeLabels[task.mode]} · {statusLabels[task.status] || task.status}</strong><span>词表 {task.vocabularySize || currentVocabularySize} 个 · {task.mode === 'consolidate' ? `顺序 ${task.batches || consolidationRequestCount} 片` : `并发 ${activeConfigRef.current?.concurrency || normalizeConcurrency(config.concurrency)}`}</span></div>
      <div className="progress-track"><div style={{width: `${percent}%`}}/></div>
      <div className="ai-metrics"><span>{task.completed}/{task.total}</span><span>成功 {task.succeeded}</span><span>失败 {task.failed}</span><span>批次 {task.batch}/{task.batches}</span><span>{percent}%</span></div>
      <div className="ai-stream-metrics">
        <span>耗时 <strong>{formatDuration(elapsedMs)}</strong></span>
        <span>流事件 <strong>{formatNumber(task.streamEvents)}</strong></span>
        <span>已接收 <strong>{formatBytes(task.responseBytes)}</strong></span>
        <span>输入 Token <strong>{formatNumber(usage.inputTokens)}</strong></span>
        <span>输出 Token <strong>{formatNumber(usage.outputTokens)}</strong></span>
        <span>推理 Token <strong>{formatNumber(usage.reasoningTokens)}</strong></span>
        <span>缓存输入 <strong>{formatNumber(usage.cachedInputTokens)}</strong></span>
        <span>总 Token <strong>{formatNumber(usage.totalTokens)}</strong></span>
      </div>
      <p>Responses 使用 SSE 流式传输；本地转发会发送心跳防止空闲连接超时。Token 用量要等每个请求的完成事件返回后才会增加。{task.lastActivityAt ? ` 最近活动：${new Date(task.lastActivityAt).toLocaleTimeString('zh-CN')}` : ''}</p>
      {task.currentBatches.length > 0 && <p>正在请求批次：{task.currentBatches.join('、')}</p>}
      {shownIds.length > 0 && <p>当前 BV：{shownIds.join('、')}{hiddenIds ? `，另有 ${hiddenIds} 条` : ''}</p>}
      {task.lastMessage && <p className="success">{task.lastMessage}</p>}
      {task.lastError && <p className="error">{task.lastError}</p>}
      <p>保存位置：{storageLabel}；{task.mode === 'consolidate' ? '所有分片映射验证通过后整库保存一次。' : '每个成功批次都会立即保存。'}</p>
    </div>
    <div className="modal-actions ai-actions">
      {!active && task.status !== 'paused' && <button className="button" onClick={() => saveConfig(config)}><Save size={16}/>保存配置</button>}
      {!active && task.status !== 'paused' && <button className="button primary" onClick={startClassification}><Bot size={16}/>开始增量分类</button>}
      {!active && task.status !== 'paused' && <button className="button" onClick={startConsolidation}><GitMerge size={16}/>开始同义归核</button>}
      {task.status === 'running' && task.mode === 'classify' && <button className="button" onClick={pause}><Pause size={16}/>暂停</button>}
      {task.status === 'paused' && <button className="button primary" onClick={resume}><Play size={16}/>继续{modeLabels[task.mode]}</button>}
      {['running', 'pausing', 'paused'].includes(task.status) && <button className="button" onClick={stop}><Square size={15}/>停止</button>}
    </div>
  </div></div>;
}
