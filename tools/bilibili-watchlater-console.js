/* 在已登录的 Bilibili 稍后再看页面开发者控制台执行。会滚动列表、保留原站封面 URL 并下载 JSON。 */
(async () => {
  const seen = new Map();
  const absoluteUrl = value => value ? new URL(value, location.href).href : '';
  const originalCoverUrl = value => {
    const absolute = absoluteUrl(value);
    return absolute.replace(/@[^?#]+(?=$|[?#])/, '');
  };

  const readCard = anchor => {
    const card = anchor.closest('.bili-video-card__wrap') || anchor.closest('li, article, div') || anchor;
    const image = anchor.querySelector('img') || card.querySelector('img');
    const url = anchor.href;
    const parsedUrl = new URL(url);
    const id = parsedUrl.searchParams.get('bvid') || url.match(/(BV\w+)/)?.[1] || '';
    if (!id) return null;

    const titleNode = card.querySelector('.bili-video-card__title');
    const authorLink = card.querySelector('.bili-video-card__author');
    const authorTitle = authorLink?.querySelector('[title]')?.getAttribute('title') || '';
    const authorLine = (authorLink?.innerText || '').trim();
    const author = authorTitle || authorLine.split('·')[0]?.trim() || '';
    const addedAt = authorLine.slice(author.length).replace(/^[\s·]+/, '').trim();
    const stats = [...card.querySelectorAll('.bili-cover-card__stat span')].map(node => node.innerText.trim()).filter(Boolean);
    const coverOriginal = originalCoverUrl(image?.currentSrc || image?.src || image?.getAttribute('src') || image?.dataset?.src || '');

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
  };

  const scanCards = () => {
    const anchors = [...document.querySelectorAll('a[href*="/list/watchlater/"]')]
      .filter(anchor => anchor.querySelector('img'));
    for (const anchor of anchors) {
      const item = readCard(anchor);
      if (!item) continue;
      const previous = seen.get(item.id) || {};
      seen.set(item.id, {
        ...previous,
        ...item,
        cover: item.cover || previous.cover || '',
        coverOriginal: item.coverOriginal || previous.coverOriginal || ''
      });
    }
  };

  let stable = 0;
  let previousCount = 0;
  for (let round = 0; round < 240 && stable < 16; round++) {
    scanCards();
    if (seen.size === previousCount) stable++;
    else {
      stable = 0;
      previousCount = seen.size;
      console.log('已采集', previousCount, '条，已获取封面地址', [...seen.values()].filter(item => item.coverOriginal).length, '条');
    }
    window.scrollBy(0, 1200);
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  scanCards();

  const items = [...seen.values()];
  const covers = items.filter(item => item.coverOriginal).length;
  const dataset = {
    version: 2,
    schema: 'bili-library/v2',
    libraryType: 'watchlater',
    mode: 'browser',
    source: {
      site: 'bilibili',
      listUrl: location.href,
      exportedAt: new Date().toISOString()
    },
    items
  };
  const blob = new Blob([JSON.stringify(dataset, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'bilibili-watchlater-export.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  console.log('完成，共', items.length, '条，原站封面地址', covers, '条；图片二进制交给 Watchlater Atlas 本地化。');
})();
