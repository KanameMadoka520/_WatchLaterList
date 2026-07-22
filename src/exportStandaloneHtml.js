const escapeJsonForHtml = value => JSON.stringify(value)
  .replaceAll('&', '\\u0026')
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');

const remoteCover = item => {
  const candidate = item.coverOriginal || (
    /^https?:\/\//i.test(item.cover || '') &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(item.cover)
      ? item.cover
      : ''
  );
  if (!candidate) return '';
  if (candidate.startsWith('//')) return `https:${candidate}`;
  return candidate.replace(/^http:\/\//i, 'https://');
};

const prepareItem = (item, imageMode) => {
  const clean = {...item};
  delete clean.cover;
  delete clean.coverData;
  delete clean.coverFile;
  clean.coverOriginal = remoteCover(item);
  if (imageMode === 'embedded') clean.coverEmbedded = item.coverEmbedded || '';
  else delete clean.coverEmbedded;
  return clean;
};

export function buildStandaloneHtml(items, {imageMode = 'remote', exportedAt = new Date().toISOString()} = {}) {
  const payload = {
    version: 1,
    kind: 'watchlater-atlas-html',
    exportedAt,
    imageMode,
    items: items.map(item => prepareItem(item, imageMode))
  };
  const data = escapeJsonForHtml(payload);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Watchlater Atlas - 稍后再看快照</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#17202a;background:#f7f8fa;--accent:#ff6691}*{box-sizing:border-box}body{margin:0}.shell{min-height:100vh}header{min-height:64px;background:#fff;border-bottom:1px solid #e7ebef;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 30px;position:sticky;top:0;z-index:4}.brand{display:flex;align-items:center;gap:10px;font-weight:760}.mark{width:22px;height:22px;border:2px solid var(--accent);display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:3px}.mark i{background:var(--accent)}.snapshot{font-size:12px;color:#778390;text-align:right}main{max-width:1280px;margin:0 auto;padding:34px 30px 72px}.summary{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:26px}.eyebrow{font-size:11px;color:#8793a0;letter-spacing:1.5px;margin:0 0 8px}.summary h1{font-size:30px;line-height:1.2;margin:0 0 9px;letter-spacing:0}.summary p{margin:0;color:#6e7a86}.counts{display:flex;gap:18px;white-space:nowrap}.counts strong{font-size:24px}.counts span{display:block;color:#7b8793;font-size:11px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:14px}.search{width:min(520px,100%);height:42px;border:1px solid #dfe4ea;background:#fff;border-radius:7px;padding:0 12px}.search input{width:100%;height:100%;border:0;outline:0;font-size:14px;background:transparent}.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.seg{display:flex;background:#edf0f3;border-radius:7px;padding:3px}.seg button{border:0;background:transparent;color:#65717d;padding:7px 10px;border-radius:5px;cursor:pointer}.seg button.on{background:#fff;color:#17202a;box-shadow:0 1px 3px #d9dee3}.cover-toggle[hidden]{display:none}.tags{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:20px}.tags button{border:1px solid #dfe4ea;background:#fff;color:#63707d;border-radius:999px;padding:6px 10px;cursor:pointer;font-size:12px}.tags button.active{border-color:var(--accent);color:#d94270;background:#fff5f8}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}.card{background:#fff;border:1px solid #e4e8ed;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;min-width:0}.thumb{aspect-ratio:16/9;background:#eef1f4;position:relative;overflow:hidden}.thumb img{width:100%;height:100%;display:block;object-fit:cover}.placeholder{position:absolute;inset:0;display:grid;place-items:center;color:#aab4bf;font-weight:750;font-size:27px;letter-spacing:2px}.badge{position:absolute;right:8px;bottom:8px;background:#17202add;color:#fff;font-size:11px;padding:4px 6px;border-radius:4px}.body{padding:14px}.body h2{font-size:15px;line-height:1.45;margin:0 0 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.meta{font-size:12px;color:#7b8793;margin:0 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-tags{display:flex;gap:6px;min-height:23px;flex-wrap:wrap}.card-tags span{font-size:11px;color:#677482;background:#f0f3f5;padding:4px 7px;border-radius:4px}.actions{display:flex;align-items:center;gap:12px;margin-top:14px}.actions button,.actions a{border:0;background:transparent;color:#4e5b68;font-size:12px;padding:4px 0;cursor:pointer;text-decoration:none}.actions a{color:#df4d77}.empty{text-align:center;color:#8793a0;padding:80px 0}.pager{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:26px}.pager button{width:36px;height:34px;border:1px solid #dfe4ea;background:#fff;border-radius:6px;cursor:pointer}.pager button:disabled{opacity:.35;cursor:not-allowed}.pager span{min-width:110px;text-align:center;color:#687580;font-size:12px}.footer-note{text-align:center;color:#929ca6;font-size:11px;margin-top:40px}@media(max-width:760px){header{padding:12px 16px}.snapshot{display:none}main{padding:26px 16px 60px}.summary{display:block}.counts{margin-top:18px}.toolbar{display:block}.controls{margin-top:10px}.grid{grid-template-columns:1fr}.summary h1{font-size:25px}}
</style>
</head>
<body>
<div class="shell">
  <header><div class="brand"><span class="mark"><i></i><i></i><i></i><i></i></span>Watchlater Atlas</div><div class="snapshot" id="snapshot"></div></header>
  <main>
    <section class="summary"><div><p class="eyebrow">PORTABLE VIDEO LIBRARY</p><h1>稍后再看离线快照</h1><p>单文件 HTML，无需启动本地服务。</p></div><div class="counts"><div><strong id="total">0</strong><span>条视频</span></div><div><strong id="visible">0</strong><span>当前显示</span></div></div></section>
    <div class="toolbar"><div class="search"><input id="search" placeholder="搜索标题、作者、BV号或标签"></div><div class="controls"><div class="seg" id="views"><button data-view="all" class="on">全部</button><button data-view="inbox">待整理</button><button data-view="archived">已归档</button></div><div class="seg cover-toggle" id="coverToggle"><button data-cover="embedded">图片随文件</button><button data-cover="original">原站 CDN</button></div></div></div>
    <div class="tags" id="tags"></div>
    <div class="grid" id="grid"></div>
    <div class="empty" id="empty" hidden>没有匹配的视频</div>
    <div class="pager" id="pager"><button id="previousPage" title="上一页">‹</button><span id="pageStatus"></span><button id="nextPage" title="下一页">›</button></div>
    <div class="footer-note">此页面是导出时的数据快照。视频播放仍需访问 Bilibili。</div>
  </main>
</div>
<script id="watchlater-data" type="application/json">${data}</script>
<script>
(function(){
  'use strict';
  var payload=JSON.parse(document.getElementById('watchlater-data').textContent);
  var items=payload.items||[];
  var pageSize=48;
  var state={query:'',view:'all',tag:'全部',cover:payload.imageMode==='embedded'?'embedded':'original',page:1};
  var grid=document.getElementById('grid');
  var empty=document.getElementById('empty');
  var tagsRoot=document.getElementById('tags');
  var coverToggle=document.getElementById('coverToggle');
  var pager=document.getElementById('pager');
  var previousPage=document.getElementById('previousPage');
  var nextPage=document.getElementById('nextPage');
  document.getElementById('snapshot').textContent='导出于 '+new Date(payload.exportedAt).toLocaleString()+' · '+(payload.imageMode==='embedded'?'封面已内嵌':'封面使用原站地址');
  document.getElementById('total').textContent=String(items.length);
  if(payload.imageMode!=='embedded')coverToggle.hidden=true;
  function videoUrl(item){return 'https://www.bilibili.com/video/'+encodeURIComponent(item.id)+'/';}
  function coverUrl(item){return state.cover==='embedded'?(item.coverEmbedded||''):(item.coverOriginal||'');}
  function el(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function button(text,attributes){var node=el('button','',text);Object.keys(attributes||{}).forEach(function(key){node.dataset[key]=attributes[key];});return node;}
  function renderTags(){
    var all=['全部'];var seen={};
    items.forEach(function(item){(item.tags||[]).forEach(function(tag){if(!seen[tag]){seen[tag]=true;all.push(tag);}});});
    tagsRoot.replaceChildren();
    all.forEach(function(tag){var node=button(tag,{tag:tag});if(state.tag===tag)node.className='active';node.addEventListener('click',function(){state.tag=tag;state.page=1;renderTags();render();});tagsRoot.appendChild(node);});
  }
  function render(){
    var query=state.query.trim().toLowerCase();
    var filtered=items.filter(function(item){
      var statusOk=state.view==='all'||item.status===state.view;
      var tagOk=state.tag==='全部'||(item.tags||[]).indexOf(state.tag)!==-1;
      var haystack=[item.title,item.author,item.id,item.category,item.note].concat(item.tags||[],item.keywords||[],item.topics||[],item.collections||[]).join(' ').toLowerCase();
      return statusOk&&tagOk&&(!query||haystack.indexOf(query)!==-1);
    });
    var pageCount=Math.max(1,Math.ceil(filtered.length/pageSize));
    state.page=Math.min(state.page,pageCount);
    var pageItems=filtered.slice((state.page-1)*pageSize,state.page*pageSize);
    grid.replaceChildren();
    pageItems.forEach(function(item){
      var card=el('article','card');var thumb=el('div','thumb');var placeholder=el('div','placeholder',(item.id||'VIDEO').slice(0,4));var src=coverUrl(item);
      thumb.appendChild(placeholder);
      if(src){var img=document.createElement('img');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('load',function(){placeholder.hidden=true;});img.addEventListener('error',function(){img.remove();placeholder.hidden=false;});img.src=src;thumb.appendChild(img);}
      thumb.appendChild(el('span','badge',item.progress||'未播放'));
      var body=el('div','body');var title=el('h2','',item.title||'未命名视频');title.title=item.title||'';body.appendChild(title);
      body.appendChild(el('p','meta',(item.author||'未知作者')+' · '+(item.addedAt||'未知日期')+' · '+(item.views||'暂无播放量')));
      var cardTags=el('div','card-tags');(item.tags||[]).forEach(function(tag){cardTags.appendChild(el('span','',tag));});body.appendChild(cardTags);
      var actions=el('div','actions');var open=el('button','','B站网页窗口');open.addEventListener('click',function(){window.open(videoUrl(item),'watchlater_atlas_player','popup=yes,width=1280,height=860,resizable=yes,scrollbars=yes');});actions.appendChild(open);
      var link=el('a','','新标签');link.href=videoUrl(item);link.target='_blank';link.rel='noreferrer';actions.appendChild(link);body.appendChild(actions);card.appendChild(thumb);card.appendChild(body);grid.appendChild(card);
    });
    document.getElementById('visible').textContent=String(pageItems.length);empty.hidden=filtered.length!==0;pager.hidden=filtered.length===0;document.getElementById('pageStatus').textContent='第 '+state.page+' / '+pageCount+' 页 · 共 '+filtered.length+' 条';previousPage.disabled=state.page<=1;nextPage.disabled=state.page>=pageCount;
  }
  document.getElementById('search').addEventListener('input',function(event){state.query=event.target.value;state.page=1;render();});
  document.getElementById('views').addEventListener('click',function(event){var value=event.target.dataset.view;if(!value)return;state.view=value;state.page=1;Array.prototype.forEach.call(event.currentTarget.querySelectorAll('button'),function(node){node.classList.toggle('on',node.dataset.view===value);});render();});
  coverToggle.addEventListener('click',function(event){var value=event.target.dataset.cover;if(!value)return;state.cover=value;Array.prototype.forEach.call(event.currentTarget.querySelectorAll('button'),function(node){node.classList.toggle('on',node.dataset.cover===value);});render();});
  var initialCover=coverToggle.querySelector('[data-cover="'+state.cover+'"]');if(initialCover)initialCover.classList.add('on');
  previousPage.addEventListener('click',function(){state.page=Math.max(1,state.page-1);render();window.scrollTo({top:0,behavior:'smooth'});});
  nextPage.addEventListener('click',function(){state.page=state.page+1;render();window.scrollTo({top:0,behavior:'smooth'});});
  renderTags();render();
})();
</script>
</body>
</html>`;
}
