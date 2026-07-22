import React, {useMemo, useRef, useState} from 'react';
import {Bot, KeyRound, Pause, Play, Save, Square, X} from 'lucide-react';

const STORAGE_KEY = 'watchlater.ai.config';
const LOCAL_AI_PROXY = 'http://localhost:4175/api/ai-proxy';
const defaultConfig = {
  protocol: 'responses',
  endpoint: 'https://api.openai.com/v1/responses',
  apiKey: '',
  model: 'gpt-5.6-luna',
  batchSize: 20,
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
const cleanList = (value, limit) => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim())
  .filter(Boolean))].slice(0, limit);
const statusLabels = {
  idle: '尚未开始', running: '处理中', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', stopped: '已停止', completed: '已完成', failed: '配置错误'
};

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
          category: {type: 'string'},
          topics: {type: 'array', items: {type: 'string'}},
          collections: {type: 'array', items: {type: 'string'}},
          reason: {type: 'string'}
        },
        required: ['id', 'tags', 'category', 'topics', 'collections', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
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

export function AiTaggingModal({open, allItems, filteredItems, existingTags, onApplyBatch, onClose, storageLabel}) {
  const [config, setConfig] = useState(loadConfig);
  const [task, setTask] = useState({
    status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0,
    batch: 0, batches: 0, currentIds: [], lastMessage: '', lastError: ''
  });
  const queueRef = useRef([]);
  const cursorRef = useRef(0);
  const runningRef = useRef(false);
  const pauseRef = useRef(false);
  const stopRef = useRef(false);
  const abortRef = useRef(null);

  const candidates = useMemo(() => {
    if (config.scope === 'filtered') return filteredItems;
    if (config.scope === 'all') return allItems;
    return allItems.filter(item => !item.ai?.processedAt);
  }, [allItems, filteredItems, config.scope]);

  if (!open) return null;

  const saveConfig = next => {
    const normalized = {...next, batchSize: clampBatchSize(next.batchSize)};
    setConfig(normalized);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  };

  const requestBatch = async (batch, activeConfig, signal) => {
    const knownTags = existingTags.filter(tag => tag !== '全部').slice(0, 160);
    const payloadItems = batch.map(item => ({
      id: item.id,
      title: item.title,
      author: item.author || '',
      description: item.description || '',
      currentTags: item.tags || [],
      currentCategory: item.category || '',
      note: item.note || ''
    }));
    const prompt = [
      '你是视频资料库分类器。必须只返回 JSON，不要 Markdown。',
      `已有标签词表：${JSON.stringify(knownTags)}`,
      `附加规则：${activeConfig.instructions}`,
      '返回格式：{"items":[{"id":"BV号","tags":["标签"],"category":"主分类","topics":["主题"],"collections":["建议收藏夹"],"reason":"一句简短依据"}]}。',
      '不得遗漏输入 id，不得修改 id；标签去重，不要把播放量、作者名或“视频”当作标签。',
      `待处理数据：${JSON.stringify(payloadItems)}`
    ].join('\n');
    const isResponses = activeConfig.protocol === 'responses';
    const body = isResponses ? {
      model: activeConfig.model,
      instructions: '你负责为中文视频资料库生成稳定、可复用的结构化分类元数据。',
      input: prompt,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'watchlater_video_tags',
          strict: true,
          schema: responseSchema
        }
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
      if (isResponses) body.text = {format: {type: 'json_object'}};
      else delete body.response_format;
      response = await send();
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`API HTTP ${response.status}：${raw.slice(0, 300)}`);
    const envelope = JSON.parse(raw);
    const content = isResponses ? responseOutputText(envelope) : envelope.choices?.[0]?.message?.content;
    if (!content) throw new Error(isResponses
      ? 'Responses API 响应中没有 output_text 内容'
      : 'Chat Completions 响应中没有 choices[0].message.content');
    const parsed = JSON.parse(cleanJson(content));
    const allowed = new Set(batch.map(item => item.id));
    const results = (parsed.items || []).filter(item => allowed.has(item.id)).map(item => ({
      id: item.id,
      tags: cleanList(item.tags, 8),
      category: String(item.category || '').trim(),
      topics: cleanList(item.topics, 5),
      collections: cleanList(item.collections, 5),
      reason: String(item.reason || '').trim()
    }));
    if (!results.length) throw new Error('模型返回了 JSON，但没有可匹配当前批次 BV 号的结果');
    return results;
  };

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    pauseRef.current = false;
    stopRef.current = false;
    setTask(current => ({...current, status: 'running', lastError: ''}));
    const activeConfig = saveConfig(config);
    const batchSize = activeConfig.batchSize;
    try {
      while (cursorRef.current < queueRef.current.length) {
        if (pauseRef.current || stopRef.current) break;
        const start = cursorRef.current;
        const batch = queueRef.current.slice(start, start + batchSize);
        const batchNumber = Math.floor(start / batchSize) + 1;
        setTask(current => ({...current, status: 'running', batch: batchNumber, currentIds: batch.map(item => item.id)}));
        abortRef.current = new AbortController();
        try {
          const results = await requestBatch(batch, activeConfig, abortRef.current.signal);
          await onApplyBatch(results, activeConfig.model);
          const matched = new Set(results.map(item => item.id));
          setTask(current => ({
            ...current,
            completed: start + batch.length,
            succeeded: current.succeeded + results.length,
            failed: current.failed + batch.filter(item => !matched.has(item.id)).length,
            lastMessage: `第 ${batchNumber} 批已保存 ${results.length} 条到${storageLabel}`,
            lastError: ''
          }));
        } catch (error) {
          if (error.name === 'AbortError' && stopRef.current) break;
          setTask(current => ({
            ...current,
            completed: start + batch.length,
            failed: current.failed + batch.length,
            lastError: `第 ${batchNumber} 批失败：${error.message}`
          }));
        }
        cursorRef.current += batch.length;
      }
      setTask(current => ({
        ...current,
        status: stopRef.current ? 'stopped' : pauseRef.current ? 'paused' : 'completed',
        currentIds: []
      }));
    } finally {
      abortRef.current = null;
      runningRef.current = false;
    }
  };

  const start = () => {
    const activeConfig = saveConfig(config);
    if (!activeConfig.endpoint || !activeConfig.model || !activeConfig.apiKey) {
      setTask(current => ({...current, status: 'failed', lastError: '请填写 API 地址、模型和 API Key'}));
      return;
    }
    queueRef.current = [...candidates];
    cursorRef.current = 0;
    const batches = Math.ceil(queueRef.current.length / activeConfig.batchSize);
    setTask({
      status: queueRef.current.length ? 'running' : 'completed',
      total: queueRef.current.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      batch: 0,
      batches,
      currentIds: [],
      lastMessage: queueRef.current.length ? `已建立 ${batches} 个批次` : '当前范围没有需要处理的视频',
      lastError: ''
    });
    if (queueRef.current.length) void run();
  };

  const pause = () => {
    pauseRef.current = true;
    setTask(current => ({...current, status: 'pausing', lastMessage: '当前批次完成后暂停'}));
  };
  const resume = () => {
    pauseRef.current = false;
    void run();
  };
  const stop = () => {
    stopRef.current = true;
    pauseRef.current = false;
    abortRef.current?.abort();
    setTask(current => ({...current, status: 'stopping', lastMessage: '正在停止，已保存的批次会保留'}));
  };

  const percent = task.total ? Math.round(task.completed / task.total * 1000) / 10 : 0;
  const active = ['running', 'pausing', 'stopping'].includes(task.status);

  return <div className="overlay"><div className="modal ai-modal">
    <div className="modal-head"><div><h2><Bot size={20}/>AI 分类任务</h2><p>配置只保存在当前浏览器；视频元数据按批发送，封面图片不会发送。</p></div><button title="关闭" disabled={active} onClick={onClose}><X size={18}/></button></div>
    <div className="ai-key-note"><KeyRound size={17}/><span>请求通过本机 4175 服务转发。API Key 保存于 localStorage 的 <code>{STORAGE_KEY}</code>，不会写入导出 JSON、本地数据库或服务日志。共享电脑不建议保存长期密钥。</span></div>
    <div className="ai-form">
      <label>API 协议<select value={config.protocol} onChange={event => {
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
      <label className="wide">API 地址<input value={config.endpoint} onChange={event => setConfig({...config, endpoint: event.target.value.trim()})}/></label>
      <label>模型<input value={config.model} onChange={event => setConfig({...config, model: event.target.value.trim()})}/></label>
      <label className="wide">API Key<input type="password" autoComplete="off" value={config.apiKey} onChange={event => setConfig({...config, apiKey: event.target.value})}/></label>
      <label>每批视频数<input type="number" min="5" max="40" value={config.batchSize} onChange={event => setConfig({...config, batchSize: event.target.value})}/></label>
      <label>处理范围<select value={config.scope} onChange={event => setConfig({...config, scope: event.target.value})}>
        <option value="unprocessed">尚未由 AI 处理（{allItems.filter(item => !item.ai?.processedAt).length}）</option>
        <option value="filtered">当前筛选结果（{filteredItems.length}）</option>
        <option value="all">全部视频（{allItems.length}）</option>
      </select></label>
      <label className="wide">分类规则<textarea rows="3" value={config.instructions} onChange={event => setConfig({...config, instructions: event.target.value})}/></label>
    </div>
    <div className={`ai-task status-${task.status}`}>
      <div className="ai-task-head"><strong>任务状态：{statusLabels[task.status] || task.status}</strong><span>候选 {candidates.length} 条 · 每批 {clampBatchSize(config.batchSize)} 条</span></div>
      <div className="progress-track"><div style={{width: `${percent}%`}}/></div>
      <div className="ai-metrics"><span>{task.completed}/{task.total}</span><span>成功 {task.succeeded}</span><span>失败 {task.failed}</span><span>批次 {task.batch}/{task.batches}</span><span>{percent}%</span></div>
      {task.currentIds.length > 0 && <p>当前：{task.currentIds.join('、')}</p>}
      {task.lastMessage && <p className="success">{task.lastMessage}</p>}
      {task.lastError && <p className="error">{task.lastError}</p>}
      <p>保存位置：{storageLabel}；每个成功批次都会立即保存。</p>
    </div>
    <div className="modal-actions">
      {!active && task.status !== 'paused' && <button className="button" onClick={() => saveConfig(config)}><Save size={16}/>保存配置</button>}
      {!active && task.status !== 'paused' && <button className="button primary" onClick={start}><Bot size={16}/>开始处理</button>}
      {task.status === 'running' && <button className="button" onClick={pause}><Pause size={16}/>暂停</button>}
      {task.status === 'paused' && <button className="button primary" onClick={resume}><Play size={16}/>继续</button>}
      {['running', 'pausing', 'paused'].includes(task.status) && <button className="button" onClick={stop}><Square size={15}/>停止</button>}
    </div>
  </div></div>;
}
