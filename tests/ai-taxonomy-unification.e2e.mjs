import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const appUrl = process.env.WATCHLATER_APP_URL || 'http://localhost:4173/';
const itemCount = 120;
const targetCount = 20;
const items = Array.from({length: itemCount}, (_, index) => ({
  id: `BVTEST${String(index + 1).padStart(4, '0')}`,
  title: `测试视频 ${index + 1}`,
  url: `https://www.bilibili.com/video/BVTEST${String(index + 1).padStart(4, '0')}`,
  cover: `https://i0.hdslb.com/bfs/archive/test-${index + 1}.jpg`,
  coverOriginal: `https://i0.hdslb.com/bfs/archive/test-${index + 1}.jpg`,
  coverFile: `data/covers/BVTE/BVTEST${String(index + 1).padStart(4, '0')}.jpg`,
  tags: [`原始标签-${String(index + 1).padStart(3, '0')}`],
  keywords: [],
  status: 'inbox'
}));

const browser = await chromium.launch({headless: true});
const context = await browser.newContext({acceptDownloads: true});
const page = await context.newPage();
const requests = [];
let requestSerial = 0;

await page.addInitScript(({seedItems, target}) => {
  localStorage.setItem('watchlater.mode', 'browser');
  localStorage.setItem('watchlater.items', JSON.stringify(seedItems));
  localStorage.removeItem('watchlater.taxonomy');
  localStorage.setItem('watchlater.ai.config', JSON.stringify({
    protocol: 'responses',
    endpoint: 'https://example.invalid/v1/responses',
    apiKey: 'test-only-key',
    model: 'taxonomy-test-model',
    unificationTarget: target,
    unificationChunkSize: 50,
    unificationConcurrency: 3,
    unificationStrength: 'balanced'
  }));
}, {seedItems: items, target: targetCount});

await page.route('**/api/ai-proxy', async route => {
  const requestBody = route.request().postDataJSON();
  const prompt = String(requestBody?.body?.input || '');
  const targetMatch = prompt.match(/恰好\s*(\d+)\s*个规范标签/);
  const sourceMarker = '来源标签及使用次数：';
  const markerIndex = prompt.lastIndexOf(sourceMarker);
  assert.ok(targetMatch, '模拟请求必须包含准确目标数量');
  assert.ok(markerIndex >= 0, '模拟请求必须包含来源标签 JSON');
  const sourceEntries = JSON.parse(prompt.slice(markerIndex + sourceMarker.length));
  const requestedTarget = Number(targetMatch[1]);
  assert.ok(requestedTarget > 0 && requestedTarget <= sourceEntries.length);

  requestSerial++;
  const canonicalTags = Array.from({length: requestedTarget}, (_, index) =>
    `R${requestSerial}-规范-${String(index + 1).padStart(3, '0')}`);
  const tagMappings = sourceEntries.map((entry, index) => ({
    from: entry.name,
    to: canonicalTags[index % canonicalTags.length],
    reason: '端到端测试映射'
  }));
  requests.push({inputCount: sourceEntries.length, targetCount: requestedTarget});
  const output = JSON.stringify({canonicalTags, tagMappings, summary: '端到端测试结果'});
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({output_text: output, usage: {input_tokens: 100, output_tokens: 50, total_tokens: 150}})
  });
});
await page.route('**/api/watchlater', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({version: 2, schema: 'bili-library/v2', taxonomy: null, items: []})
}));

try {
  await page.goto(appUrl, {waitUntil: 'networkidle'});
  await page.getByRole('button', {name: 'AI 标签'}).click();
  await page.getByRole('tab', {name: /统一规格/}).click();
  await page.getByRole('button', {name: '生成目标规格提案'}).click();
  await page.getByText('统一规格提案已生成', {exact: false}).waitFor({timeout: 30_000});

  const firstRound = requests.slice(0, 3).sort((left, right) => left.inputCount - right.inputCount);
  assert.deepEqual(firstRound, [
    {inputCount: 20, targetCount: 10},
    {inputCount: 50, targetCount: 25},
    {inputCount: 50, targetCount: 25}
  ]);
  assert.deepEqual(requests[3], {inputCount: 60, targetCount});
  assert.equal(requests.length, 4, '必须包含三次首轮分片和一次终局全量请求');

  const beforeApply = await page.evaluate(() => ({
    items: JSON.parse(localStorage.getItem('watchlater.items') || '[]'),
    taxonomy: JSON.parse(localStorage.getItem('watchlater.taxonomy') || 'null')
  }));
  assert.equal(beforeApply.items.length, itemCount);
  assert.equal(beforeApply.taxonomy, null, '提案阶段不得提前写入 taxonomy');
  assert.ok(beforeApply.items.every(item => item.tags?.[0]?.startsWith('原始标签-')));

  const desktopScreenshot = await page.screenshot();
  assert.ok(desktopScreenshot.length > 10_000, '桌面截图不应为空');
  await page.setViewportSize({width: 390, height: 844});
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogRight: document.querySelector('.ai-modal')?.getBoundingClientRect().right || 0,
    dialogLeft: document.querySelector('.ai-modal')?.getBoundingClientRect().left || 0
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth, '移动端页面不应产生横向溢出');
  assert.ok(mobileLayout.dialogLeft >= 0 && mobileLayout.dialogRight <= mobileLayout.viewportWidth);
  const mobileScreenshot = await page.screenshot();
  assert.ok(mobileScreenshot.length > 10_000, '移动端截图不应为空');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: '备份并应用'}).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^watchlater-browser-before-ai-taxonomy-/);
  await page.getByText('统一规格已应用', {exact: false}).waitFor({timeout: 15_000});

  const afterApply = await page.evaluate(() => ({
    items: JSON.parse(localStorage.getItem('watchlater.items') || '[]'),
    taxonomy: JSON.parse(localStorage.getItem('watchlater.taxonomy') || 'null')
  }));
  assert.equal(afterApply.taxonomy.finalUniqueTagCount, targetCount);
  assert.equal(afterApply.taxonomy.canonicalTags.length, targetCount);
  assert.equal(new Set(afterApply.items.flatMap(item => item.tags || [])).size, targetCount);
  assert.ok(afterApply.items.every(item => item.tags.length >= 1 && item.tags.length <= 5));
  assert.ok(afterApply.items.every(item => item.keywords?.some(keyword => keyword.startsWith('原始标签-'))));

  await page.getByRole('button', {name: '关闭'}).click();
  await page.getByRole('button', {name: '导出数据'}).click();
  const cacheExportPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: /浏览器缓存包/}).click();
  const cacheExport = await cacheExportPromise;
  const cacheExportPath = await cacheExport.path();
  const cachePackage = JSON.parse(await fs.readFile(cacheExportPath, 'utf8'));
  assert.equal(cachePackage.items.length, itemCount);
  assert.ok(cachePackage.items.every(item => !('coverFile' in item)));
  assert.ok(cachePackage.items.every(item => item.cover === item.coverOriginal && item.coverOriginal.startsWith('https://')));

  await page.getByRole('button', {name: '清理缓存'}).click();
  await page.getByRole('button', {name: '确认清空'}).click();
  await page.waitForFunction(() => localStorage.getItem('watchlater.mode') === 'file');
  const afterClear = await page.evaluate(() => ({
    items: localStorage.getItem('watchlater.items'),
    taxonomy: localStorage.getItem('watchlater.taxonomy'),
    aiConfig: JSON.parse(localStorage.getItem('watchlater.ai.config') || 'null')
  }));
  assert.equal(afterClear.items, null);
  assert.equal(afterClear.taxonomy, null);
  assert.equal(afterClear.aiConfig.apiKey, 'test-only-key');
  console.log(`AI taxonomy E2E passed: ${itemCount} -> ${targetCount}, ${requests.length} mocked requests.`);
} finally {
  await context.close();
  await browser.close();
}
