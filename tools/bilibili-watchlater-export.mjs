import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';

const listUrl = 'https://www.bilibili.com/watchlater/list?spm_id_from=333.1007.0.0#/list';
const out = process.argv[2] || path.resolve('data/bilibili-watchlater-export.json');
const profile = path.resolve('data/playwright-profile');
const context = await chromium.launchPersistentContext(profile, {headless: false});
const page = context.pages()[0] || await context.newPage();
await page.goto(listUrl, {waitUntil: 'domcontentloaded'});

console.log('浏览器配置保存在 data/playwright-profile，首次运行请登录 Bilibili。');
console.log('确认稍后再看列表已经显示后，回到此窗口按 Enter 开始采集。');
const terminal = readline.createInterface({input, output});
await terminal.question('按 Enter 开始：');
terminal.close();

const seen = new Map();
let stable = 0;
let previous = 0;
for (let round = 0; round < 240 && stable < 16; round++) {
  const rows = await page.locator('a[href*="/list/watchlater/"]').evaluateAll(anchors => anchors
    .filter(anchor => anchor.querySelector('img'))
    .map(anchor => {
      const card = anchor.closest('.bili-video-card__wrap') || anchor.closest('li, article, div') || anchor;
      const image = anchor.querySelector('img') || card.querySelector('img');
      const url = anchor.href;
      const parsedUrl = new URL(url);
      const id = parsedUrl.searchParams.get('bvid') || url.match(/(BV\w+)/)?.[1] || '';
      const titleNode = card.querySelector('.bili-video-card__title');
      const authorLink = card.querySelector('.bili-video-card__author');
      const authorTitle = authorLink?.querySelector('[title]')?.getAttribute('title') || '';
      const authorLine = (authorLink?.innerText || '').trim();
      const author = authorTitle || authorLine.split('·')[0]?.trim() || '';
      const addedAt = authorLine.slice(author.length).replace(/^[\s·]+/, '').trim();
      const stats = [...card.querySelectorAll('.bili-cover-card__stat span')].map(node => node.innerText.trim()).filter(Boolean);
      const rawCover = image?.currentSrc || image?.src || image?.getAttribute('src') || image?.dataset?.src || '';
      const coverOriginal = rawCover ? new URL(rawCover, location.href).href.replace(/@[^?#]+(?=$|[?#])/, '') : '';
      return {
        id,
        title: titleNode?.getAttribute('title') || image?.alt || titleNode?.innerText?.trim() || '未命名视频',
        url,
        cover: coverOriginal,
        coverOriginal,
        coverFile: '',
        author,
        authorId: authorLink?.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] || '',
        addedAt,
        views: stats[0] || '',
        progress: stats[1] || '',
        watched: (stats[1] || '').includes('已看完'),
        tags: [],
        topics: [],
        collections: [],
        category: '',
        note: '',
        status: 'inbox',
        description: '',
        extra: {
          oid: parsedUrl.searchParams.get('oid') || '',
          watchlaterCfg: parsedUrl.searchParams.get('watchlater_cfg') || '',
          cardText: card.innerText || ''
        },
        text: card.innerText || '',
        source: 'bilibili-watchlater'
      };
    }));

  for (const row of rows.filter(item => item.id)) {
    const prior = seen.get(row.id) || {};
    seen.set(row.id, {
      ...prior,
      ...row,
      cover: row.cover || prior.cover || '',
      coverOriginal: row.coverOriginal || prior.coverOriginal || ''
    });
  }
  if (seen.size === previous) stable++;
  else {
    stable = 0;
    previous = seen.size;
    console.log('已采集', seen.size, '条，已获取封面地址', [...seen.values()].filter(item => item.coverOriginal).length, '条');
  }
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(350);
}

const items = [...seen.values()];
const dataset = {
  version: 2,
  schema: 'bili-library/v2',
  libraryType: 'watchlater',
  mode: 'file',
  source: {site: 'bilibili', listUrl, exportedAt: new Date().toISOString()},
  items
};
await fs.mkdir(path.dirname(out), {recursive: true});
await fs.writeFile(out, JSON.stringify(dataset, null, 2));
console.log(`已写入 ${out}，共 ${items.length} 条，原站封面地址 ${items.filter(item => item.coverOriginal).length} 条`);
await context.close();
