import React, {useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileDown,
  FolderHeart,
  Globe2,
  HardDrive,
  ImageDown,
  LayoutList,
  MonitorDown,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Square,
  StickyNote,
  Tags,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import {buildStandaloneHtml} from './exportStandaloneHtml';
import {AiTaggingModal} from './AiTaggingModal';
import {HelpButton, HelpDialog} from './HelpDialog';
import {VirtualVideoGrid} from './VirtualVideoGrid';
import './styles.css';
import './features.css';
import './headerEnhancements.css';

const API = 'http://localhost:4175';
const PAGE_SIZE = 48;
const SCHEMA_VERSION = 2;
const BROWSER_ITEMS_KEY = 'watchlater.items';
const BROWSER_TAXONOMY_KEY = 'watchlater.taxonomy';
const generatedCoverFields = [
  'cover',
  'coverOriginal',
  'coverFile',
  'coverMime',
  'coverBytes',
  'coverSha256',
  'coverFetchedAt',
  'coverError'
];
const remoteCoverCandidate = item => item.coverOriginal || (
  /^https?:\/\//i.test(item.cover || '') &&
  !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(item.cover)
    ? item.cover
    : ''
);

const normalize = item => {
  const coverOriginal = remoteCoverCandidate(item);
  return {
    ...item,
    coverOriginal,
    cover: item.coverData || item.cover || coverOriginal || '',
    id: item.id || ((item.url || '').match(/BV\w+/)?.[0] || crypto.randomUUID()),
    title: item.title || '未命名视频',
    tags: Array.isArray(item.tags) ? item.tags : [],
    keywords: Array.isArray(item.keywords) ? item.keywords : [],
    topics: Array.isArray(item.topics) ? item.topics : [],
    collections: Array.isArray(item.collections) ? item.collections : [],
    category: item.category || '',
    note: item.note || item.notes || '',
    status: item.status || 'inbox',
    libraryType: item.libraryType || 'watchlater'
  };
};

const parseTags = value => [...new Set(String(value || '').split(/[\s,，、;；]+/u).map(tag => tag.trim()).filter(Boolean))];
const parseKeywords = value => [...new Set(String(value || '').split(/[\r\n,，、;；]+/u).map(keyword => keyword.trim()).filter(Boolean))];
const tagCountsOf = items => {
  const counts = new Map();
  for (const item of items) for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  return counts;
};

const downloadBlob = (name, content, type) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], {type}));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

const downloadJson = (name, data) => downloadBlob(
  name,
  JSON.stringify(data, null, 2),
  'application/json;charset=utf-8'
);

const mergeItems = (before, incoming) => {
  const map = new Map(before.map(item => [item.id, item]));
  incoming.forEach(rawItem => {
    const item = normalize(rawItem);
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, item);
      return;
    }
    const merged = {...existing, ...item};
    for (const field of generatedCoverFields) {
      if (item[field] === undefined || item[field] === null || item[field] === '') merged[field] = existing[field];
    }
    for (const field of ['tags', 'keywords', 'topics', 'collections', 'category', 'note', 'status', 'ai', 'rating', 'localMedia']) {
      const value = rawItem[field];
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) merged[field] = existing[field];
    }
    map.set(item.id, merged);
  });
  return [...map.values()];
};

const originalCoverOf = item => {
  const candidate = remoteCoverCandidate(item);
  if (!candidate) return '';
  if (candidate.startsWith('//')) return `https:${candidate}`;
  return candidate.replace(/^http:\/\//i, 'https://');
};

const localCoverOf = item => {
  if ((item.coverData || '').startsWith('data:image/')) return item.coverData;
  if ((item.cover || '').startsWith('data:image/')) return item.cover;
  if (item.coverFile) return `${API}/${item.coverFile.replace(/^\/+/, '')}`;
  if ((item.cover || '').startsWith(`${API}/`)) return item.cover;
  return '';
};

const displayCoverOf = (item, source) => {
  if (source === 'original') return originalCoverOf(item);
  return localCoverOf(item) || originalCoverOf(item);
};

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
  reader.readAsDataURL(blob);
});

const imageAsDataUrl = async source => {
  if (!source) return '';
  if (source.startsWith('data:image/')) return source;
  const response = await fetch(source, {credentials: 'omit', referrerPolicy: 'no-referrer'});
  if (!response.ok) throw new Error(`图片下载 HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('响应不是图片');
  return blobToDataUrl(blob);
};

const mapConcurrent = async (values, limit, mapper) => {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, values.length || 1)}, worker));
  return output;
};

const formatBytes = bytes => {
  if (!bytes) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
};

const browserCacheStats = () => {
  const rawItems = localStorage.getItem(BROWSER_ITEMS_KEY) || '';
  const rawTaxonomy = localStorage.getItem(BROWSER_TAXONOMY_KEY) || '';
  let count = 0;
  try {
    const parsed = JSON.parse(rawItems || '[]');
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch {}
  return {count, bytes: new Blob([rawItems, rawTaxonomy]).size};
};

const browserPortableItem = item => {
  const {
    coverData: _coverData,
    coverFile: _coverFile,
    coverMime: _coverMime,
    coverBytes: _coverBytes,
    coverSha256: _coverSha256,
    coverFetchedAt: _coverFetchedAt,
    ...portable
  } = item;
  const coverOriginal = originalCoverOf(item);
  return {...portable, cover: coverOriginal, coverOriginal};
};

const APP_HELP = {
  storage: {
    title: '本地文件和浏览器缓存有什么区别？',
    paragraphs: [
      '本地文件模式把长期资料写进项目的 data/watchlater.json，并使用 data/covers 保存封面。浏览器缓存模式只把一份独立副本放进当前浏览器的 localStorage。',
      '两种模式不会自动同步，所以视频数量不同是正常的。确定以后只使用本地文件时，可以清空浏览器缓存；这不会删除本地数据库，也不会删除 AI API 配置。'
    ]
  },
  import: {
    title: '导入 JSON 是做什么的？',
    paragraphs: [
      '导入会把扫描脚本或本项目导出的 JSON 合并进当前模式。当前是本地文件模式时，结果写入 data/watchlater.json；当前是浏览器缓存模式时，结果写入 localStorage。',
      '相同 BV 号会合并，不会简单复制成两条。本地已有的封面、标签、备注和 AI 记录会尽量保留。'
    ]
  },
  json: {
    title: '两种 JSON 导出分别给谁用？',
    paragraphs: [
      '通用 JSON 是完整的数据交换文件，适合备份、迁移到另一份 Watchlater Atlas，或之后重新导入本地文件模式。',
      '浏览器缓存包会去掉只有本机服务才能读取的 coverFile 等路径，保留原站 CDN 封面。把它导入“浏览器缓存”模式后，不启动本地数据服务也能联网浏览。'
    ]
  },
  html: {
    title: 'HTML 导出是做什么的？',
    paragraphs: [
      'HTML 是一个只读快照，双击文件就能搜索和浏览，不需要启动 4173/4175 服务。它适合归档和分享，不适合继续编辑资料库。',
      '选择 CDN 封面时文件更小但需要联网；选择图片随 HTML 时可以离线看封面，但 Base64 会让文件明显变大。'
    ]
  },
  bilistar: {
    title: '导出到 BiliStar 是做什么的？',
    paragraphs: [
      '这个文件用于导入 BiliStar Video 收藏夹项目。它保留视频元数据、标签、关键词和 taxonomy，并把资料库类型改成 favorites。',
      'Watchlater Atlas 不会移动或下载视频文件；本地视频绑定需要在 BiliStar Video 中继续操作。'
    ]
  }
};

function App() {
  const [mode, setMode] = useState(() => localStorage.getItem('watchlater.mode') || 'file');
  const [coverSource, setCoverSource] = useState(() => localStorage.getItem('watchlater.coverSource') || 'local');
  const [listMode, setListMode] = useState(() => localStorage.getItem('watchlater.listMode') || 'virtual');
  const [items, setItems] = useState([]);
  const [taxonomy, setTaxonomy] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');
  const [tag, setTag] = useState('全部');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [tagDraft, setTagDraft] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [activePlayer, setActivePlayer] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [coverJob, setCoverJob] = useState(null);
  const [htmlExportOpen, setHtmlExportOpen] = useState(false);
  const [dataExportOpen, setDataExportOpen] = useState(false);
  const [cacheClearOpen, setCacheClearOpen] = useState(false);
  const [appHelp, setAppHelp] = useState('');
  const [cacheStats, setCacheStats] = useState(browserCacheStats);
  const [htmlImageMode, setHtmlImageMode] = useState('remote');
  const [htmlExporting, setHtmlExporting] = useState(false);
  const playerWindow = useRef(null);
  const lastJobSync = useRef('');
  const itemsRef = useRef([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadFile = async () => {
    try {
      const response = await fetch(`${API}/api/watchlater`);
      const data = await response.json();
      setTaxonomy(data.taxonomy || null);
      setItems((data.items || []).map(normalize));
    } catch {
      setTaxonomy(null);
      setItems([]);
      setNotice('本地数据服务不可用，没有改用浏览器缓存；请确认 4175 服务已经启动');
    }
  };

  useEffect(() => {
    localStorage.setItem('watchlater.mode', mode);
    if (mode === 'file') loadFile();
    else {
      setTaxonomy(JSON.parse(localStorage.getItem(BROWSER_TAXONOMY_KEY) || 'null'));
      setItems(JSON.parse(localStorage.getItem(BROWSER_ITEMS_KEY) || '[]'));
    }
  }, [mode]);

  useEffect(() => {
    localStorage.setItem('watchlater.coverSource', coverSource);
  }, [coverSource]);

  useEffect(() => {
    localStorage.setItem('watchlater.listMode', listMode);
  }, [listMode]);

  useEffect(() => {
    if (mode !== 'browser' || !items.length) return;
    let idleId;
    let fallbackId;
    const timeout = setTimeout(() => {
      const write = () => {
        localStorage.setItem(BROWSER_ITEMS_KEY, JSON.stringify(items));
        setCacheStats(browserCacheStats());
      };
      if ('requestIdleCallback' in window) idleId = window.requestIdleCallback(write, {timeout: 1500});
      else fallbackId = setTimeout(write, 0);
    }, 500);
    return () => {
      clearTimeout(timeout);
      clearTimeout(fallbackId);
      if (idleId && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId);
    };
  }, [items, mode]);

  useEffect(() => {
    if (mode === 'browser') {
      localStorage.setItem(BROWSER_TAXONOMY_KEY, JSON.stringify(taxonomy));
      setCacheStats(browserCacheStats());
    }
  }, [taxonomy, mode]);

  useEffect(() => {
    if (mode !== 'file') {
      setCoverJob(null);
      return undefined;
    }
    let disposed = false;
    let timer;
    const poll = async () => {
      try {
        const response = await fetch(`${API}/api/cover-job`);
        const job = await response.json();
        if (disposed) return;
        setCoverJob(job);
        if (['completed', 'cancelled', 'failed', 'paused'].includes(job.status) && lastJobSync.current !== job.updatedAt) {
          lastJobSync.current = job.updatedAt;
          await loadFile();
        }
        const active = ['running', 'pausing', 'cancelling'].includes(job.status);
        timer = setTimeout(poll, active ? 700 : 2500);
      } catch {
        if (!disposed) timer = setTimeout(poll, 3000);
      }
    };
    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [mode]);

  const saveFileItems = async (next, taxonomyOverride = taxonomy, options = {}) => {
    const response = await fetch(`${API}/api/watchlater`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({items: next, taxonomy: taxonomyOverride, createBackup: options.createBackup || ''})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '本地数据库写入失败');
    return data;
  };

  const persist = next => {
    const normalized = next.map(normalize);
    setItems(normalized);
    if (mode === 'file') saveFileItems(normalized).catch(error => setNotice(error.message));
  };

  const enrich = async ids => {
    if (mode !== 'file') {
      setNotice('封面本地化只在本地文件模式可用');
      return;
    }
    setBusy(true);
    setNotice('正在创建封面本地化任务...');
    try {
      await saveFileItems(items);
      const response = await fetch(`${API}/api/cover-job/start`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ids})
      });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || '任务创建失败');
      setCoverJob(job);
      setNotice(job.total ? `封面任务已开始：需要处理 ${job.total} 条` : '所有封面已经本地化');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const controlCoverJob = async action => {
    try {
      const response = await fetch(`${API}/api/cover-job/${action}`, {method: 'POST'});
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || '任务控制失败');
      setCoverJob(job);
      const labels = {pause: '正在暂停封面任务', resume: '封面任务已继续', cancel: '正在停止封面任务'};
      setNotice(labels[action]);
    } catch (error) {
      setNotice(error.message);
    }
  };

  const tags = useMemo(() => ['全部', ...new Set(items.flatMap(item => item.tags || []))], [items]);
  const filtered = useMemo(() => items.filter(item => (
    (view === 'all' || item.status === view) &&
    (tag === '全部' || item.tags?.includes(tag)) &&
    (!q || [
      item.title,
      item.author,
      item.id,
      item.note,
      item.category,
      ...(item.tags || []),
      ...(item.keywords || []),
      ...(item.topics || []),
      ...(item.collections || [])
    ].join(' ').toLowerCase().includes(q.toLowerCase()))
  )), [items, q, view, tag]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);
  const pageStart = filtered.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(page * PAGE_SIZE, filtered.length);
  const coverTaskActive = ['running', 'pausing', 'cancelling'].includes(coverJob?.status);
  const coverTaskLocked = ['running', 'pausing', 'paused', 'cancelling'].includes(coverJob?.status);
  const coverJobStatusLabel = {
    running: '处理中',
    pausing: '正在暂停',
    paused: '已暂停',
    cancelling: '正在停止',
    cancelled: '已停止',
    completed: '已完成',
    failed: '任务失败'
  }[coverJob?.status] || '';

  useEffect(() => { setPage(1); }, [q, view, tag]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const localCoverBytes = useMemo(() => items.reduce((total, item) => total + Number(item.coverBytes || 0), 0), [items]);
  const estimatedHtmlImageBytes = Math.ceil(localCoverBytes * 4 / 3);

  const importFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = Array.isArray(data) ? data : (data.items || data.videos || []);
        const incomingTaxonomy = !Array.isArray(data) && data.taxonomy ? data.taxonomy : taxonomy;
        const next = mergeItems(items, incoming);
        setTaxonomy(incomingTaxonomy);
        setItems(next);
        if (mode === 'file') {
          setBusy(true);
          await saveFileItems(next, incomingTaxonomy);
          const jobResponse = await fetch(`${API}/api/cover-job/start`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: '{}'
          });
          const job = await jobResponse.json();
          if (!jobResponse.ok) throw new Error(job.error || '封面任务创建失败');
          setCoverJob(job);
          setNotice(job.total
            ? `已导入 ${incoming.length} 条，封面任务需要处理 ${job.total} 条`
            : `已导入 ${incoming.length} 条，封面均已就绪`);
          setBusy(false);
        } else setNotice(`已导入 ${incoming.length} 条，浏览器存储将在空闲时写入`);
      } catch (error) {
        setBusy(false);
        setNotice(`导入失败：${error.message}`);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const exportHtml = async () => {
    setHtmlExporting(true);
    let failed = 0;
    let completed = 0;
    try {
      const exportItems = htmlImageMode === 'embedded'
        ? await mapConcurrent(items, 6, async item => {
          let coverEmbedded = '';
          try {
            coverEmbedded = await imageAsDataUrl(localCoverOf(item) || originalCoverOf(item));
            if (!coverEmbedded) failed++;
          } catch {
            failed++;
          }
          completed++;
          if (completed === items.length || completed % 10 === 0) {
            setNotice(`正在生成 HTML：已处理 ${completed}/${items.length} 张封面`);
          }
          return {...item, coverEmbedded};
        })
        : items;
      const exportedAt = new Date().toISOString();
      const html = buildStandaloneHtml(exportItems, {imageMode: htmlImageMode, exportedAt});
      const date = exportedAt.slice(0, 10);
      downloadBlob(`watchlater-atlas-${date}-${htmlImageMode}.html`, html, 'text/html;charset=utf-8');
      setHtmlExportOpen(false);
      setNotice(htmlImageMode === 'embedded'
        ? `HTML 已导出：内嵌 ${items.length - failed} 张封面，失败 ${failed} 张`
        : 'HTML 已导出：仅保存原站 CDN 封面地址');
    } catch (error) {
      setNotice(`HTML 导出失败：${error.message}`);
    } finally {
      setHtmlExporting(false);
    }
  };

  const exportData = kind => {
    const exportedAt = new Date().toISOString();
    const base = {
      version: SCHEMA_VERSION,
      schema: 'bili-library/v2',
      libraryType: 'watchlater',
      exportedAt,
      taxonomy
    };
    if (kind === 'browser-cache') {
      downloadJson(`watchlater-browser-cache-${exportedAt.slice(0, 10)}.json`, {
        ...base,
        mode: 'browser',
        storageHint: 'localStorage',
        items: items.map(browserPortableItem)
      });
      setNotice(`已导出浏览器缓存包：${items.length} 条，封面使用原站 CDN 地址`);
    } else {
      downloadJson(`watchlater-${mode}-${exportedAt.slice(0, 10)}.json`, {...base, mode, items});
      setNotice(`已导出通用 JSON：${items.length} 条`);
    }
    setDataExportOpen(false);
  };

  const clearBrowserCache = () => {
    localStorage.removeItem(BROWSER_ITEMS_KEY);
    localStorage.removeItem(BROWSER_TAXONOMY_KEY);
    setCacheStats({count: 0, bytes: 0});
    setCacheClearOpen(false);
    if (mode === 'browser') setMode('file');
    setNotice('浏览器缓存数据已经清空；本地文件、封面和 AI API 配置没有改变');
  };

  const remove = id => persist(items.filter(item => item.id !== id));
  const update = (id, patch) => persist(items.map(item => item.id === id ? {...item, ...patch} : item));
  const beginEdit = item => {
    setEditing({...item});
    setTagDraft((item.tags || []).join(' '));
  };
  const add = () => beginEdit({
    id: '',
    title: '',
    url: '',
    cover: '',
    author: '',
    addedAt: new Date().toISOString().slice(0, 10),
    views: '',
    progress: '',
    tags: [],
    keywords: [],
    topics: [],
    collections: [],
    category: '',
    note: '',
    status: 'inbox',
    libraryType: 'watchlater'
  });
  const saveEdit = () => {
    if (!editing.title.trim()) return;
    const requestedTags = parseTags(tagDraft);
    const canonicalTags = new Set((taxonomy?.canonicalTags || [])
      .map(entry => typeof entry === 'string' ? entry : entry?.name)
      .filter(Boolean));
    const movedToKeywords = canonicalTags.size
      ? requestedTags.filter(value => !canonicalTags.has(value))
      : [];
    const acceptedTags = canonicalTags.size
      ? requestedTags.filter(value => canonicalTags.has(value))
      : requestedTags;
    if (canonicalTags.size && !acceptedTags.length && canonicalTags.has('综合')) acceptedTags.push('综合');
    const item = normalize({
      ...editing,
      tags: acceptedTags,
      keywords: [...new Set([...(editing.keywords || []), ...movedToKeywords])]
    });
    persist(items.some(existing => existing.id === item.id)
      ? items.map(existing => existing.id === item.id ? item : existing)
      : [item, ...items]);
    if (movedToKeywords.length) setNotice(`已将 ${movedToKeywords.length} 个非规范标签转存为详细关键词`);
    setEditing(null);
  };

  const toggleEditingTag = selected => {
    const next = new Set(parseTags(tagDraft));
    if (next.has(selected)) next.delete(selected);
    else next.add(selected);
    setTagDraft([...next].join(' '));
  };

  const applyAiBatch = async (results, model) => {
    const byId = new Map(results.map(result => [result.id, result]));
    const processedAt = new Date().toISOString();
    const next = itemsRef.current.map(item => {
      const result = byId.get(item.id);
      if (!result) return item;
      return normalize({
        ...item,
        tags: [...new Set([...(item.tags || []), ...result.tags])],
        keywords: [...new Set([...(item.keywords || []), ...(result.keywords || [])])],
        category: result.category || item.category || '',
        topics: result.topics,
        collections: result.collections,
        ai: {
          ...(item.ai || {}),
          status: 'completed',
          model,
          processedAt,
          reason: result.reason,
          mode: 'classify',
          tagStrategy: 'merge'
        }
      });
    });
    itemsRef.current = next;
    setItems(next);
    if (mode === 'file') await saveFileItems(next);
    else localStorage.setItem(BROWSER_ITEMS_KEY, JSON.stringify(next));
  };

  const applyAiConsolidation = async (plan, model) => {
    const mapOf = mappings => new Map((mappings || []).map(mapping => [mapping.from, mapping.to]));
    const tagMap = mapOf(plan.tagMappings);
    const resolve = (value, mapping) => {
      let current = value;
      const seen = new Set([current]);
      while (mapping.has(current)) {
        const next = mapping.get(current);
        if (!next || next === current) return current;
        if (seen.has(next)) return value;
        seen.add(next);
        current = next;
      }
      return current;
    };
    const mapList = (values, mapping) => [...new Set((values || []).map(value => resolve(value, mapping)).filter(Boolean))];
    const consolidatedAt = new Date().toISOString();
    let changedItems = 0;
    const next = itemsRef.current.map(item => {
      const tags = mapList(item.tags, tagMap);
      const changed = JSON.stringify(tags) !== JSON.stringify(item.tags || []);
      if (changed) changedItems++;
      return normalize({
        ...item,
        tags,
        ai: {
          ...(item.ai || {}),
          consolidatedAt,
          consolidationModel: model,
          consolidationSummary: plan.summary || ''
        }
      });
    });
    itemsRef.current = next;
    setItems(next);
    if (mode === 'file') await saveFileItems(next);
    else localStorage.setItem(BROWSER_ITEMS_KEY, JSON.stringify(next));
    const mappingCount = [...tagMap].filter(([from, to]) => from !== to).length;
    const finalVocabularySize = new Set(next.flatMap(item => item.tags || [])).size;
    return {changedItems, mappingCount, finalVocabularySize};
  };

  const applyAiTaxonomy = async (plan, model) => {
    const canonicalNames = [...new Set((plan.canonicalTags || []).map(value => String(value?.name || value).trim()).filter(Boolean))];
    const canonicalSet = new Set(canonicalNames);
    if (canonicalNames.length !== plan.requestedTargetCount) {
      throw new Error(`统一规格结果应为 ${plan.requestedTargetCount} 个标签，实际为 ${canonicalNames.length} 个`);
    }
    const sourceMap = new Map((plan.sourceMappings || []).map(mapping => [mapping.source, mapping.target]));
    const sourceCounts = tagCountsOf(itemsRef.current);
    const missingSources = [...sourceCounts.keys()].filter(source => !sourceMap.has(source));
    const invalidTargets = [...sourceMap].filter(([, target]) => !canonicalSet.has(target));
    if (missingSources.length || invalidTargets.length) {
      throw new Error(`统一规格映射不完整：遗漏 ${missingSources.length} 个来源词，非法目标 ${invalidTargets.length} 个`);
    }

    const unifiedAt = new Date().toISOString();
    const originalTagsByIndex = itemsRef.current.map(item => [...new Set(item.tags || [])]);
    const next = itemsRef.current.map((item, index) => {
      const tags = [...new Set(originalTagsByIndex[index].map(tag => sourceMap.get(tag)).filter(Boolean))].slice(0, 5);
      if (!tags.length && canonicalNames.length) tags.push(canonicalNames[0]);
      return normalize({
        ...item,
        tags,
        keywords: [...new Set([...(item.keywords || []), ...originalTagsByIndex[index]])],
        ai: {
          ...(item.ai || {}),
          taxonomyUnifiedAt: unifiedAt,
          taxonomyModel: model,
          taxonomyStrategy: 'ai-hierarchical-v1',
          taxonomySummary: plan.summary || ''
        }
      });
    });

    const finalCounts = tagCountsOf(next);
    const missingCanonical = canonicalNames.filter(name => !finalCounts.has(name));
    for (const name of missingCanonical) {
      const sourceNames = (plan.sourceMappings || []).filter(mapping => mapping.target === name).map(mapping => mapping.source);
      let itemIndex = originalTagsByIndex.findIndex((tags, index) => tags.some(tag => sourceNames.includes(tag)) && next[index].tags.length < 5);
      if (itemIndex < 0) {
        itemIndex = originalTagsByIndex.findIndex(tags => tags.some(tag => sourceNames.includes(tag)));
        if (itemIndex >= 0) {
          const replaceIndex = next[itemIndex].tags.findIndex(tag => (finalCounts.get(tag) || 0) > 1);
          if (replaceIndex >= 0) {
            const removed = next[itemIndex].tags[replaceIndex];
            next[itemIndex].tags.splice(replaceIndex, 1, name);
            finalCounts.set(removed, finalCounts.get(removed) - 1);
          } else itemIndex = -1;
        }
      } else next[itemIndex].tags.push(name);
      if (itemIndex >= 0) finalCounts.set(name, 1);
    }

    const verifiedCounts = tagCountsOf(next);
    const invalidItems = next.filter(item => !item.tags.length || item.tags.length > 5 || item.tags.some(tag => !canonicalSet.has(tag)));
    if (verifiedCounts.size !== canonicalNames.length || invalidItems.length) {
      throw new Error(`统一规格应用前验证失败：实际使用 ${verifiedCounts.size}/${canonicalNames.length} 个标签，异常视频 ${invalidItems.length} 条`);
    }

    const previousTaxonomy = taxonomy ? {
      version: taxonomy.version,
      strategy: taxonomy.strategy,
      generatedAt: taxonomy.generatedAt,
      finalUniqueTagCount: taxonomy.finalUniqueTagCount
    } : null;
    const nextTaxonomy = {
      version: 'watchlater-controlled-tags/v2',
      strategy: 'ai-hierarchical-v1',
      generatedAt: unifiedAt,
      requestedTargetCount: plan.requestedTargetCount,
      sourceUniqueTagCount: sourceCounts.size,
      finalUniqueTagCount: verifiedCounts.size,
      rounds: plan.rounds || [],
      summary: plan.summary || '',
      model,
      previousTaxonomy,
      historicalSourceUniqueTagCount: taxonomy?.historicalSourceUniqueTagCount || taxonomy?.sourceUniqueTagCount || sourceCounts.size,
      historicalSourceMappings: taxonomy?.historicalSourceMappings || taxonomy?.sourceMappings || [],
      canonicalTags: canonicalNames.map(name => ({
        name,
        sourceUsageCount: (plan.canonicalTags || []).find(entry => (entry?.name || entry) === name)?.count || 0,
        finalVideoCount: verifiedCounts.get(name) || 0
      })),
      sourceMappings: (plan.sourceMappings || []).map(mapping => ({
        source: mapping.source,
        count: mapping.count || sourceCounts.get(mapping.source) || 0,
        targets: [mapping.target],
        disposition: 'canonical_and_keyword'
      }))
    };

    let backupFile = '';
    if (mode === 'file') {
      const saved = await saveFileItems(next, nextTaxonomy, {createBackup: 'ai-taxonomy-unification'});
      backupFile = saved._write?.backupFile || '';
    } else {
      downloadJson(`watchlater-browser-before-ai-taxonomy-${unifiedAt.slice(0, 10)}.json`, {
        version: SCHEMA_VERSION,
        schema: 'bili-library/v2',
        libraryType: 'watchlater',
        exportedAt: unifiedAt,
        taxonomy,
        items: itemsRef.current
      });
      localStorage.setItem(BROWSER_ITEMS_KEY, JSON.stringify(next));
      localStorage.setItem(BROWSER_TAXONOMY_KEY, JSON.stringify(nextTaxonomy));
      setCacheStats(browserCacheStats());
    }
    itemsRef.current = next;
    setItems(next);
    setTaxonomy(nextTaxonomy);
    return {finalVocabularySize: verifiedCounts.size, changedItems: next.length, backupFile};
  };

  const playerUrl = item => `https://www.bilibili.com/video/${encodeURIComponent(item.id)}/?spm_id_from=333.1007.0.0`;
  const openPlayer = item => {
    const width = Math.min(1280, screen.availWidth - 60);
    const height = Math.min(860, screen.availHeight - 60);
    const left = Math.max(10, Math.round((screen.availWidth - width) / 2));
    const top = Math.max(10, Math.round((screen.availHeight - height) / 2));
    const player = window.open(
      playerUrl(item),
      'watchlater_atlas_player',
      `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
    if (!player) {
      setNotice('浏览器阻止了播放器窗口，请允许 localhost 弹出窗口');
      return;
    }
    playerWindow.current = player;
    setActivePlayer(item);
    player.focus();
  };
  const focusPlayer = () => {
    if (playerWindow.current && !playerWindow.current.closed) playerWindow.current.focus();
    else if (activePlayer) openPlayer(activePlayer);
  };
  const closePlayer = () => {
    if (playerWindow.current && !playerWindow.current.closed) playerWindow.current.close();
    playerWindow.current = null;
    setActivePlayer(null);
  };

  const renderCard = item => {
    const displayedCover = displayCoverOf(item, coverSource);
    return <article className="card" key={item.id}>
      <div className="thumb">
        {displayedCover ? <img src={displayedCover} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"/> : <div className="placeholder">{item.id.slice(0, 4)}</div>}
        <span className="badge">{item.progress || '未播放'}</span>
        {item.coverError && <span className="cover-error" title={item.coverError}>封面待修复</span>}
      </div>
      <div className="body">
        <h2 title={item.title}>{item.title}</h2>
        <p className="meta">{item.author || '未知作者'} · {item.addedAt || '未知日期'} · {item.views || '暂无播放量'}</p>
        {item.category && <p className="category">{item.category}</p>}
        <div className="cardtags">{(item.tags || []).map(currentTag => <span key={currentTag}>{currentTag}</span>)}</div>
        {item.note && <p className="card-note"><StickyNote size={13}/>{item.note}</p>}
        <div className="actions">
          <button onClick={() => openPlayer(item)}><Play size={15}/>B站网页窗口</button>
          <a href={playerUrl(item)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>新标签</a>
          <button disabled={coverTaskLocked} onClick={() => beginEdit(item)}><Save size={15}/>编辑</button>
          <button disabled={coverTaskLocked} title={item.status === 'archived' ? '恢复到待整理' : '归档'} onClick={() => update(item.id, {status: item.status === 'archived' ? 'inbox' : 'archived'})}>{item.status === 'archived' ? <RotateCcw size={15}/> : <Archive size={15}/>}</button>
          <button disabled={coverTaskLocked} className="danger" title="删除" onClick={() => remove(item.id)}><Trash2 size={15}/></button>
        </div>
      </div>
    </article>;
  };

  return <div className="app">
    <header>
      <div className="brand"><Database size={22}/><span>Watchlater Atlas</span></div>
      <div className="header-actions">
        <div className="header-tool mode-tool">
          <div className="mode">
            <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}><HardDrive size={15}/>本地文件</button>
            <button className={mode === 'browser' ? 'active' : ''} onClick={() => setMode('browser')}><MonitorDown size={15}/>浏览器缓存</button>
          </div>
          <HelpButton label="两种存储模式" onClick={() => setAppHelp('storage')}/>
        </div>
        <div className="header-tool"><label className={`button ${coverTaskLocked ? 'disabled' : ''}`} title={coverTaskLocked ? '请先暂停后停止封面任务，再导入新数据' : '导入 JSON'}><Upload size={16}/>导入<input type="file" accept=".json,.ndjson" disabled={coverTaskLocked} onChange={importFile}/></label><HelpButton label="导入 JSON" onClick={() => setAppHelp('import')}/></div>
        <div className="header-tool"><button className="button" onClick={() => setDataExportOpen(true)}><Download size={16}/>导出数据</button><HelpButton label="JSON 导出" onClick={() => setAppHelp('json')}/></div>
        <div className="header-tool"><button className="button" onClick={() => downloadJson('bilistar-import.json', {version: SCHEMA_VERSION, schema: 'bili-library/v2', libraryType: 'favorites', exportedAt: new Date().toISOString(), taxonomy, items: items.map(item => ({...item, libraryType: 'favorites', status: item.status === 'archived' ? 'archived' : 'active', localMedia: null}))})}><FolderHeart size={16}/>BiliStar</button><HelpButton label="导出到 BiliStar" onClick={() => setAppHelp('bilistar')}/></div>
        <div className="header-tool"><button className="button" onClick={() => setHtmlExportOpen(true)}><FileDown size={16}/>HTML</button><HelpButton label="HTML 导出" onClick={() => setAppHelp('html')}/></div>
        <button className="button" disabled={coverTaskLocked} onClick={() => setAiOpen(true)}><Bot size={16}/>AI 标签</button>
        {mode === 'file' && <button className="button" disabled={busy || coverTaskLocked} onClick={() => enrich()}><ImageDown size={16}/>补全封面</button>}
        <button className="button cache-clear-button" disabled={!cacheStats.count} onClick={() => setCacheClearOpen(true)} title={`清空独立的浏览器缓存副本，共 ${cacheStats.count} 条`}><Trash2 size={16}/>清理缓存</button>
        <button className="button primary" disabled={coverTaskLocked} onClick={add}><Plus size={16}/>新增</button>
      </div>
    </header>

    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">PERSONAL VIDEO LIBRARY</p>
          <h1>把稍后再看，变成真正可整理的知识库。</h1>
          <p className="sub">当前模式：{mode === 'file' ? '本地 JSON 索引 + data/covers 分层封面目录' : '浏览器缓存（localStorage 独立副本）'}。封面显示：{coverSource === 'local' ? '本地优先' : '原站 CDN'}。</p>
        </div>
        <div className="stats"><b>{items.length}</b><span>条视频</span><b>{items.filter(item => item.coverFile).length}</b><span>本地封面</span></div>
      </section>

      {mode === 'file' && coverJob && coverJob.status !== 'idle' && <section className={`cover-task status-${coverJob.status}`}>
        <div className="cover-task-head">
          <div><strong>封面本地化 · {coverJobStatusLabel}</strong><span>{coverJob.completed}/{coverJob.total}，成功 {coverJob.succeeded}，失败 {coverJob.failed}</span></div>
          <div className="cover-task-actions">
            {coverJob.status === 'running' && <button className="button" onClick={() => controlCoverJob('pause')}><Pause size={15}/>暂停</button>}
            {coverJob.status === 'paused' && <button className="button primary" onClick={() => controlCoverJob('resume')}><Play size={15}/>继续</button>}
            {['running', 'pausing', 'paused'].includes(coverJob.status) && <button className="button" onClick={() => controlCoverJob('cancel')}><Square size={14}/>停止</button>}
          </div>
        </div>
        <div className="progress-track"><div style={{width: `${coverJob.percent || 0}%`}}/></div>
        <div className="cover-task-foot"><span>{coverJob.percent || 0}% · 剩余 {coverJob.remaining}</span><span>{coverJob.currentId || coverJob.lastError || '等待任务状态更新'}</span><code>http://localhost:4175/api/cover-job</code></div>
      </section>}

      <div className="toolbar">
        <div className="search"><Search size={17}/><input placeholder="搜索标题、作者、BV号或标签" value={q} onChange={event => setQ(event.target.value)}/></div>
        <div className="toolbar-controls">
          <div className="source-mode" aria-label="列表显示方式">
            <button title="窗口级虚拟滚动，只渲染视口附近卡片" className={listMode === 'virtual' ? 'on' : ''} onClick={() => setListMode('virtual')}><LayoutList size={14}/>无限滚动</button>
            <button title="按固定页数显示，并在列表顶部翻页" className={listMode === 'paged' ? 'on' : ''} onClick={() => setListMode('paged')}><Database size={14}/>分页</button>
          </div>
          <div className="source-mode" aria-label="封面来源">
            <button title="优先使用本地保存或内嵌的封面" className={coverSource === 'local' ? 'on' : ''} onClick={() => setCoverSource('local')}><HardDrive size={14}/>本地优先</button>
            <button title="只使用 Bilibili 原站封面地址" className={coverSource === 'original' ? 'on' : ''} onClick={() => setCoverSource('original')}><Globe2 size={14}/>原站 CDN</button>
          </div>
          <div className="seg">
            <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>全部</button>
            <button className={view === 'inbox' ? 'on' : ''} onClick={() => setView('inbox')}>待整理</button>
            <button className={view === 'archived' ? 'on' : ''} onClick={() => setView('archived')}>已归档</button>
          </div>
        </div>
      </div>

      <div className="list-summary">
        <span>{listMode === 'virtual' ? `无限滚动 · 共 ${filtered.length} 条` : `显示 ${pageStart}-${pageEnd} / ${filtered.length}`}</span>
        {listMode === 'virtual'
          ? <span>虚拟化只挂载当前视口附近的卡片</span>
          : <div className="pager top-pager">
            <button title="上一页" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}><ChevronLeft size={18}/></button>
            <span>第 {page} / {pageCount} 页</span>
            <button title="下一页" disabled={page >= pageCount} onClick={() => setPage(current => Math.min(pageCount, current + 1))}><ChevronRight size={18}/></button>
          </div>}
      </div>
      <div className="tags">{tags.map(currentTag => <button key={currentTag} className={tag === currentTag ? 'active' : ''} onClick={() => setTag(currentTag)}><Tags size={14}/>{currentTag}</button>)}</div>
      {listMode === 'virtual'
        ? <VirtualVideoGrid items={filtered} renderItem={renderCard}/>
        : <div className="grid">{pageItems.map(renderCard)}</div>}
      {filtered.length === 0 && <div className="empty">没有匹配的视频</div>}
    </main>

    {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
    {activePlayer && <div className="window-dock">
      <div className="window-dot"/>
      <div className="window-copy"><strong>{activePlayer.title}</strong><span>完整 Bilibili 网页窗口正在运行</span></div>
      <button title="聚焦 Bilibili 窗口" onClick={focusPlayer}><Play size={16}/></button>
      <button title="关闭 Bilibili 窗口" onClick={closePlayer}><X size={17}/></button>
    </div>}

    {dataExportOpen && <div className="overlay">
      <div className="modal export-modal">
        <div className="modal-head"><div><h2>导出数据</h2><p>选择文件之后准备在哪里使用。</p></div><button title="关闭" onClick={() => setDataExportOpen(false)}><X size={18}/></button></div>
        <div className="export-options">
          <button className="export-choice" onClick={() => exportData('portable')}>
            <Database size={22}/><span><strong>通用 JSON</strong><small>完整保留当前字段，适合备份、迁移和重新导入本地文件模式。</small></span>
          </button>
          <button className="export-choice" onClick={() => exportData('browser-cache')}>
            <MonitorDown size={22}/><span><strong>浏览器缓存包</strong><small>去掉本机封面路径，保留 CDN 地址；导入浏览器缓存模式即可读取。</small></span>
          </button>
        </div>
        <div className="export-summary"><b>{items.length}</b><span>条视频</span><b>{taxonomy?.canonicalTags?.length || tags.length - 1}</b><span>个规范标签</span></div>
      </div>
    </div>}

    {cacheClearOpen && <div className="overlay">
      <div className="modal confirm-modal">
        <div className="modal-head"><div><h2>清空浏览器缓存副本</h2><p>只删除当前站点 localStorage 里的视频数据。</p></div><button title="关闭" onClick={() => setCacheClearOpen(false)}><X size={18}/></button></div>
        <div className="cache-clear-summary"><b>{cacheStats.count}</b><span>条缓存视频</span><b>{formatBytes(cacheStats.bytes)}</b><span>预计占用</span></div>
        <p className="confirm-copy">本地 `data/watchlater.json`、`data/covers` 和 AI API 配置不会删除。清理后如果当前正在查看浏览器缓存，页面会自动切回本地文件模式。</p>
        <div className="modal-actions"><button className="button" onClick={() => setCacheClearOpen(false)}>取消</button><button className="button danger-button" onClick={clearBrowserCache}><Trash2 size={16}/>确认清空</button></div>
      </div>
    </div>}

    {htmlExportOpen && <div className="overlay">
      <div className="modal export-modal">
        <div className="modal-head"><div><h2>导出单文件 HTML</h2><p>导出全部 {items.length} 条视频，之后可以直接双击打开。</p></div><button title="关闭" onClick={() => !htmlExporting && setHtmlExportOpen(false)}><X size={18}/></button></div>
        <div className="export-options">
          <label className={htmlImageMode === 'embedded' ? 'selected' : ''}>
            <input type="radio" name="html-image-mode" value="embedded" checked={htmlImageMode === 'embedded'} onChange={() => setHtmlImageMode('embedded')}/>
            <HardDrive size={20}/><span><strong>图片随 HTML</strong><small>本地图片约 {formatBytes(localCoverBytes)}；Base64 通常增加约 33%，仅图片数据预计约 {formatBytes(estimatedHtmlImageBytes)}，还未包含页面和元数据。</small></span>
          </label>
          <label className={htmlImageMode === 'remote' ? 'selected' : ''}>
            <input type="radio" name="html-image-mode" value="remote" checked={htmlImageMode === 'remote'} onChange={() => setHtmlImageMode('remote')}/>
            <Globe2 size={20}/><span><strong>仅保留原站 CDN 地址 · 推荐</strong><small>文件明显更小，适合日常分享和备份；查看封面时需要联网，且取决于原站地址仍然有效。</small></span>
          </label>
        </div>
        <div className="export-advice"><strong>推荐策略</strong><span>长期使用请保留本项目的 `data/covers` 本地图片库；有网络时导出 CDN 版 HTML。把近千张封面塞进单个 HTML 会占用大量内存，只建议在确实需要完全离线且数据量较小时使用。</span></div>
        <div className="export-summary"><b>{items.length}</b><span>条视频将写入快照</span><b>{items.filter(item => originalCoverOf(item)).length}</b><span>条含原站封面地址</span></div>
        <div className="modal-actions"><button className="button" disabled={htmlExporting} onClick={() => setHtmlExportOpen(false)}>取消</button><button className="button primary" disabled={htmlExporting} onClick={exportHtml}><FileDown size={16}/>{htmlExporting ? '正在生成...' : '导出 HTML'}</button></div>
      </div>
    </div>}

    <AiTaggingModal
      open={aiOpen}
      allItems={items}
      filteredItems={filtered}
      taxonomy={taxonomy}
      onApplyBatch={applyAiBatch}
      onApplyConsolidation={applyAiConsolidation}
      onApplyTaxonomy={applyAiTaxonomy}
      onClose={() => setAiOpen(false)}
      storageLabel={mode === 'file' ? 'data/watchlater.json' : '当前站点浏览器缓存'}
    />

    {APP_HELP[appHelp] && <HelpDialog title={APP_HELP[appHelp].title} onClose={() => setAppHelp('')}>
      {APP_HELP[appHelp].paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </HelpDialog>}

    {editing && <div className="overlay"><div className="modal">
      <div className="modal-head"><h2>{editing.id ? '编辑视频' : '新增视频'}</h2><button title="关闭" onClick={() => setEditing(null)}><X size={18}/></button></div>
      <div className="form">
        <label>标题<input value={editing.title || ''} onChange={event => setEditing({...editing, title: event.target.value})}/></label>
        <label>视频 URL<input value={editing.url || ''} onChange={event => setEditing({...editing, url: event.target.value})}/></label>
        <label>封面 URL 或 data URL<input value={editing.cover || ''} onChange={event => setEditing({...editing, cover: event.target.value})}/></label>
        <label>作者<input value={editing.author || ''} onChange={event => setEditing({...editing, author: event.target.value})}/></label>
        <label>添加日期<input value={editing.addedAt || ''} onChange={event => setEditing({...editing, addedAt: event.target.value})}/></label>
        <label>播放量<input value={editing.views || ''} onChange={event => setEditing({...editing, views: event.target.value})}/></label>
        <label>观看进度<input value={editing.progress || ''} onChange={event => setEditing({...editing, progress: event.target.value})}/></label>
        <label>主分类<input value={editing.category || ''} onChange={event => setEditing({...editing, category: event.target.value})}/></label>
        <label>主题（空格或逗号分隔）<input value={(editing.topics || []).join(' ')} onChange={event => setEditing({...editing, topics: parseTags(event.target.value)})}/></label>
        <label>收藏夹（空格或逗号分隔）<input value={(editing.collections || []).join(' ')} onChange={event => setEditing({...editing, collections: parseTags(event.target.value)})}/></label>
        <label className="wide">标签（空格、逗号、中文逗号均可；锁定词表外的名称自动转为关键词）<input value={tagDraft} onChange={event => setTagDraft(event.target.value)}/></label>
        {tags.length > 1 && <div className="tag-library"><span>已有标签，点击复用：</span><div>{tags.filter(value => value !== '全部').map(value => <button type="button" key={value} className={parseTags(tagDraft).includes(value) ? 'selected' : ''} onClick={() => toggleEditingTag(value)}>{value}</button>)}</div></div>}
        <label className="wide">详细关键词（每行一个或使用逗号分隔）<textarea rows="4" value={(editing.keywords || []).join('\n')} onChange={event => setEditing({...editing, keywords: parseKeywords(event.target.value)})}/></label>
        <label className="wide">个人备注<textarea rows="5" value={editing.note || ''} onChange={event => setEditing({...editing, note: event.target.value})}/></label>
      </div>
      <div className="modal-actions"><button className="button" onClick={() => setEditing(null)}>取消</button><button className="button primary" onClick={saveEdit}>保存</button></div>
    </div></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
