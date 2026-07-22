import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const dataDir = path.join(root, 'data');
const coversDir = path.join(dataDir, 'covers');
const dbFile = path.join(dataDir, 'watchlater.json');
await fs.mkdir(coversDir, {recursive: true});
try {
  await fs.access(dbFile);
} catch {
  await fs.writeFile(dbFile, JSON.stringify({version: 2, schema: 'bili-library/v2', libraryType: 'watchlater', updatedAt: new Date().toISOString(), items: []}, null, 2));
}

const corsHeaders = {'access-control-allow-origin': '*'};
const apiHeaders = {'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/'};
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

const normalizeItem = item => ({
  ...item,
  tags: Array.isArray(item.tags) ? item.tags : [],
  topics: Array.isArray(item.topics) ? item.topics : [],
  collections: Array.isArray(item.collections) ? item.collections : [],
  category: item.category || '',
  note: item.note || item.notes || '',
  status: item.status || 'inbox',
  libraryType: item.libraryType || 'watchlater'
});

const normalizeDatabase = database => ({
  ...database,
  version: 2,
  schema: 'bili-library/v2',
  libraryType: 'watchlater',
  items: (database.items || []).map(normalizeItem)
});

const sendJson = (res, status, data) => {
  res.writeHead(status, {...corsHeaders, 'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
};

const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      resolve(JSON.parse(body || '{}'));
    } catch (error) {
      reject(error);
    }
  });
});

const readDb = async () => normalizeDatabase(JSON.parse(await fs.readFile(dbFile, 'utf8')));
let dbWriteQueue = Promise.resolve();
const writeDb = items => {
  const operation = dbWriteQueue.catch(() => {}).then(async () => {
    const output = {
      version: 2,
      schema: 'bili-library/v2',
      libraryType: 'watchlater',
      updatedAt: new Date().toISOString(),
      items: items.map(normalizeItem)
    };
    const temporary = `${dbFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(output, null, 2));
    await fs.rename(temporary, dbFile);
    return output;
  });
  dbWriteQueue = operation;
  return operation;
};

const mergeIncomingWithLocalCovers = (existingItems, incomingItems) => {
  const existingById = new Map(existingItems.map(item => [item.id, item]));
  return incomingItems.map(rawIncoming => {
    const incoming = normalizeItem(rawIncoming);
    const existing = existingById.get(incoming.id);
    if (!existing) return incoming;
    const merged = {...existing, ...incoming};
    for (const field of generatedCoverFields) {
      if (incoming[field] === undefined || incoming[field] === null || incoming[field] === '') {
        merged[field] = existing[field];
      }
    }
    for (const field of ['tags', 'topics', 'collections', 'category', 'note', 'status', 'ai', 'rating', 'localMedia']) {
      const value = rawIncoming[field];
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        merged[field] = existing[field];
      }
    }
    return merged;
  });
};

const bvidOf = item => item.id?.match(/^BV[\w]+$/)?.[0]
  || item.url?.match(/(?:bvid=|video\/)(BV[\w]+)/)?.[1]
  || item.url?.match(/(BV[\w]+)/)?.[1];
const mimeExtension = mime => ({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif'
})[mime];

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      const retryableStatus = response.status === 408 || response.status === 412 || response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await wait(300 * 2 ** attempt);
  }
  throw lastError || new Error('请求失败');
}

async function enrichOne(item) {
  const bvid = bvidOf(item);
  if (!bvid) return {...item, coverError: '无法从 id 或 URL 解析 BV 号'};
  try {
    let coverUrl = item.coverOriginal || (!item.cover?.startsWith('http://localhost:4175/') ? item.cover : '');
    let metadata = {};
    if (!coverUrl || !item.title || !item.author) {
      const response = await fetchWithRetry(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {headers: apiHeaders});
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(`Bilibili 元数据接口返回 ${payload.code}`);
      metadata = payload.data;
      coverUrl = coverUrl || metadata.pic;
    }
    if (!coverUrl) throw new Error('没有封面地址');

    const image = await fetchWithRetry(coverUrl, {headers: apiHeaders});
    if (!image.ok) throw new Error(`封面下载 HTTP ${image.status}`);
    const mime = (image.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const extension = mimeExtension(mime);
    if (!extension) throw new Error(`响应不是受支持的图片：${mime || '未知类型'}`);
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length < 1024) throw new Error('图片文件过小，可能是错误响应');

    const bucket = bvid.slice(0, 4);
    const directory = path.join(coversDir, bucket);
    await fs.mkdir(directory, {recursive: true});
    const filename = `${bvid}.${extension}`;
    const absolute = path.join(directory, filename);
    await fs.writeFile(absolute, bytes);
    const relative = path.relative(dataDir, absolute).replaceAll('\\', '/');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    return {
      ...item,
      id: bvid,
      title: item.title || metadata.title || '未命名视频',
      author: item.author || metadata.owner?.name || '',
      authorId: item.authorId || String(metadata.owner?.mid || ''),
      description: item.description || metadata.desc || '',
      durationSeconds: item.durationSeconds || metadata.duration || null,
      views: item.views || metadata.stat?.view || '',
      coverOriginal: coverUrl,
      coverFile: relative,
      cover: `http://localhost:4175/covers/${bucket}/${filename}`,
      coverMime: mime,
      coverBytes: bytes.length,
      coverSha256: hash,
      coverFetchedAt: new Date().toISOString(),
      coverError: null
    };
  } catch (error) {
    return {
      ...item,
      id: bvid || item.id,
      coverError: item.coverFile ? null : error.message,
      coverRefreshError: item.coverFile ? error.message : null,
      coverFetchedAt: new Date().toISOString()
    };
  }
}

const idleJob = () => ({
  id: null,
  status: 'idle',
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  remaining: 0,
  percent: 0,
  currentId: '',
  lastError: '',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  finishedAt: null
});

let coverJob = idleJob();
let coverJobItems = [];
let coverJobIndexes = [];
let coverJobCursor = 0;
let coverJobRunner = null;
let coverJobControl = {pause: false, cancel: false};
let dirtyCoverResults = 0;

const publicCoverJob = () => ({...coverJob});
const updateJobProgress = () => {
  coverJob.remaining = Math.max(0, coverJob.total - coverJob.completed);
  coverJob.percent = coverJob.total ? Math.round(coverJob.completed / coverJob.total * 1000) / 10 : 100;
  coverJob.updatedAt = new Date().toISOString();
};

const coverFileExists = async item => {
  if (!item.coverFile) return false;
  const absolute = path.resolve(dataDir, item.coverFile);
  if (!absolute.startsWith(path.resolve(coversDir))) return false;
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
};

const flushCoverResults = async force => {
  if (!force && dirtyCoverResults < 100) return;
  if (!dirtyCoverResults && !force) return;
  dirtyCoverResults = 0;
  await writeDb(coverJobItems);
};

async function runCoverJob() {
  if (coverJobRunner || coverJob.status === 'completed' || coverJob.status === 'cancelled') return;
  coverJob.status = 'running';
  coverJobControl.pause = false;
  updateJobProgress();
  coverJobRunner = (async () => {
    async function worker() {
      while (coverJobCursor < coverJobIndexes.length) {
        if (coverJobControl.cancel || coverJobControl.pause) return;
        const queueIndex = coverJobCursor++;
        const itemIndex = coverJobIndexes[queueIndex];
        const item = coverJobItems[itemIndex];
        coverJob.currentId = item.id || bvidOf(item) || '';
        const enriched = await enrichOne(item);
        coverJobItems[itemIndex] = enriched;
        coverJob.completed++;
        if (enriched.coverFile && !enriched.coverError) coverJob.succeeded++;
        else {
          coverJob.failed++;
          coverJob.lastError = enriched.coverError || '未知错误';
        }
        dirtyCoverResults++;
        updateJobProgress();
        await flushCoverResults(false);
      }
    }

    await Promise.all(Array.from({length: Math.min(4, coverJobIndexes.length || 1)}, worker));
    await flushCoverResults(true);
    coverJob.currentId = '';
    if (coverJob.completed >= coverJob.total) coverJob.status = 'completed';
    else if (coverJobControl.cancel) coverJob.status = 'cancelled';
    else if (coverJobControl.pause && coverJob.completed < coverJob.total) coverJob.status = 'paused';
    else coverJob.status = 'completed';
    if (coverJob.status === 'completed' || coverJob.status === 'cancelled') coverJob.finishedAt = new Date().toISOString();
    updateJobProgress();
  })().catch(error => {
    coverJob.status = 'failed';
    coverJob.lastError = error.message;
    coverJob.finishedAt = new Date().toISOString();
    updateJobProgress();
  }).finally(() => {
    coverJobRunner = null;
  });
}

async function startCoverJob({ids, force = false} = {}) {
  if (['running', 'pausing', 'cancelling'].includes(coverJob.status)) return publicCoverJob();
  const database = await readDb();
  const wanted = ids?.length ? new Set(ids) : null;
  const checks = await Promise.all(database.items.map(async (item, index) => {
    if (wanted && !wanted.has(item.id)) return null;
    if (force || item.coverError || !(await coverFileExists(item))) return index;
    return null;
  }));
  coverJobItems = database.items;
  coverJobIndexes = checks.filter(index => index !== null);
  coverJobCursor = 0;
  dirtyCoverResults = 0;
  coverJobControl = {pause: false, cancel: false};
  coverJob = {
    id: crypto.randomUUID(),
    status: coverJobIndexes.length ? 'running' : 'completed',
    total: coverJobIndexes.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    remaining: coverJobIndexes.length,
    percent: coverJobIndexes.length ? 0 : 100,
    currentId: '',
    lastError: '',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: coverJobIndexes.length ? null : new Date().toISOString()
  };
  if (coverJobIndexes.length) void runCoverJob();
  return publicCoverJob();
}

async function pauseCoverJob() {
  if (coverJob.status !== 'running') return publicCoverJob();
  coverJobControl.pause = true;
  coverJob.status = 'pausing';
  updateJobProgress();
  return publicCoverJob();
}

async function resumeCoverJob() {
  if (coverJob.status !== 'paused') return publicCoverJob();
  coverJobControl.pause = false;
  void runCoverJob();
  return publicCoverJob();
}

async function cancelCoverJob() {
  if (!['running', 'pausing', 'paused'].includes(coverJob.status)) return publicCoverJob();
  coverJobControl.cancel = true;
  coverJobControl.pause = false;
  if (coverJob.status === 'paused') {
    await flushCoverResults(true);
    coverJob.status = 'cancelled';
    coverJob.finishedAt = new Date().toISOString();
  } else coverJob.status = 'cancelling';
  updateJobProgress();
  return publicCoverJob();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/covers/') && req.method === 'GET') {
      const relative = url.pathname.slice(1);
      const absolute = path.resolve(dataDir, relative);
      if (!absolute.startsWith(path.resolve(coversDir))) return sendJson(res, 403, {error: 'forbidden'});
      const bytes = await fs.readFile(absolute);
      const extension = path.extname(absolute).slice(1);
      const mime = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif'
      }[extension] || 'application/octet-stream';
      res.writeHead(200, {...corsHeaders, 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable'});
      return res.end(bytes);
    }

    if (url.pathname === '/api/watchlater' && req.method === 'GET') return sendJson(res, 200, await readDb());
    if (url.pathname === '/api/watchlater' && req.method === 'PUT') {
      const body = await readBody(req);
      const incoming = Array.isArray(body.items) ? body.items : [];
      const existing = await readDb();
      return sendJson(res, 200, await writeDb(mergeIncomingWithLocalCovers(existing.items, incoming)));
    }

    if (url.pathname === '/api/cover-job' && req.method === 'GET') return sendJson(res, 200, publicCoverJob());
    if ((url.pathname === '/api/cover-job/start' || url.pathname === '/api/enrich-covers') && req.method === 'POST') {
      return sendJson(res, 202, await startCoverJob(await readBody(req)));
    }
    if (url.pathname === '/api/cover-job/pause' && req.method === 'POST') return sendJson(res, 200, await pauseCoverJob());
    if (url.pathname === '/api/cover-job/resume' && req.method === 'POST') return sendJson(res, 200, await resumeCoverJob());
    if (url.pathname === '/api/cover-job/cancel' && req.method === 'POST') return sendJson(res, 200, await cancelCoverJob());

    sendJson(res, 404, {error: 'not found'});
  } catch (error) {
    sendJson(res, 500, {error: error.message});
  }
});

server.listen(4175, '0.0.0.0', () => console.log('Watchlater data API: http://localhost:4175'));
