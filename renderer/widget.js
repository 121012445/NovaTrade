window.onerror=function(m,u,l){console.error("[widget-err]",m,u,l);};
console.log("[widget] Loaded");

var pinned=false, bigMode=false;

function fmtPrice(p){if(!p)return'--';var n=parseFloat(p);if(n>=1000)return n.toFixed(2);if(n>=1)return n.toFixed(4);if(n>=0.01)return n.toFixed(6);return n.toFixed(8);}

// 信号门槛统一口径：与主界面 index.html 的 SIGNAL_LONG_MIN / SIGNAL_SHORT_MAX 保持一致（65/45）
var SIGNAL_LONG_MIN=65, SIGNAL_SHORT_MAX=45;

function escHtml(v){
  if(v===null||v===undefined)return'';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderCard(c,type){
  var up=c.change>=0;
  // 档位阈值与主界面 deriveLevels() 严格保持一致（5 档：70/65/45/30，门槛常量见顶部）
  var rec=c.rec || (c.score>=70?'强烈买入':c.score>=SIGNAL_LONG_MIN?'买入':c.score>=SIGNAL_SHORT_MAX?'持有':c.score>=30?'卖出':'强烈卖出');
  var bc=type==='buy'?'bbuy':'bsell';
  return '<div class="wcard" data-symbol="'+escHtml(c.symbol)+'">'+
    '<div class="wct"><span class="wsym">'+escHtml(c.symbol)+'</span><span class="wbadge '+bc+'">'+escHtml(rec)+'</span></div>'+
    '<div class="wcb"><span class="wprice">$'+fmtPrice(c.price)+'</span><span class="wchg '+(up?'cup':'cdown')+'">'+(up?'+':'')+c.change.toFixed(2)+'%</span></div>'+
    '</div>';
}

function updateWidget(data){
  var now=new Date();
  document.getElementById('wts').textContent=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  if(!data||!data.coins||data.coins.length===0){
    document.getElementById('bullList').innerHTML='<div class="wemp">暂无信号</div>';
    document.getElementById('bearList').innerHTML='<div class="wemp">暂无信号</div>';
    document.getElementById('wfoot').textContent='暂无数据';
    return;
  }
  var buys=data.coins.filter(function(c){return c.score>=SIGNAL_LONG_MIN;}).sort(function(a,b){return b.score-a.score;}).slice(0,bigMode?12:6);
  var sells=data.coins.filter(function(c){return c.score<SIGNAL_SHORT_MAX;}).sort(function(a,b){return a.score-b.score;}).slice(0,bigMode?12:6);
  console.log('[widget] Renders:', buys.length, 'buys,', sells.length, 'sells');
  document.getElementById('bullList').innerHTML=buys.length>0?buys.map(function(c){return renderCard(c,'buy');}).join(''):'<div class="wemp">暂无</div>';
  document.getElementById('bearList').innerHTML=sells.length>0?sells.map(function(c){return renderCard(c,'sell');}).join(''):'<div class="wemp">暂无</div>';
  document.getElementById('wfoot').textContent='共'+(data.total!=null?data.total:data.coins.length)+'个已分析';
}

document.getElementById('maxBtn').addEventListener('click',function(e){
  e.preventDefault();e.stopPropagation();
  bigMode=!bigMode;
  this.title=bigMode?'缩小':'放大';
  if(window.electronAPI&&window.electronAPI.resizeWidget) window.electronAPI.resizeWidget(bigMode?260:240,bigMode?520:320);
});
document.getElementById('pinBtn').addEventListener('click',function(e){
  e.preventDefault();e.stopPropagation();
  pinned=!pinned;
  this.style.opacity=pinned?'1':'0.4';
  this.style.background=pinned?'rgba(99,102,241,0.2)':'';
  if(window.electronAPI&&window.electronAPI.setWidgetAlwaysOnTop) window.electronAPI.setWidgetAlwaysOnTop(pinned);
});
document.getElementById('closeBtn').addEventListener('click',function(e){
  e.preventDefault();e.stopPropagation();
  if(window.electronAPI) window.electronAPI.closeWidget();
});

document.getElementById('bullList').addEventListener('click',function(e){
  var card=e.target.closest('.wcard');
  if(card){
    e.preventDefault();e.stopPropagation();
    console.log('[widget] Card clicked:',card.getAttribute('data-symbol'));
    if(window.electronAPI) window.electronAPI.showMain();
  }
});
document.getElementById('bearList').addEventListener('click',function(e){
  var card=e.target.closest('.wcard');
  if(card){
    e.preventDefault();e.stopPropagation();
    console.log('[widget] Card clicked:',card.getAttribute('data-symbol'));
    if(window.electronAPI) window.electronAPI.showMain();
  }
});

if(window.electronAPI&&window.electronAPI.onWidgetUpdate){
  window.electronAPI.onWidgetUpdate(function(data){
    console.log('[widget] IPC data received, coins:', data.coins?data.coins.length:0);
    updateWidget(data);
  });
  console.log('[widget] IPC listener registered');
}else{
  console.error('[widget] electronAPI not available');
}
