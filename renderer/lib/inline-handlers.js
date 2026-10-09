// 内联事件属性（onclick="fn('x')" 等）的安全替代。
//
// 背景：页面 CSP 去掉了 script-src 'unsafe-inline'，浏览器因此不再执行任何内联脚本与内联事件属性，
// 但界面里有近百处 onclick="showView('x')" 这类写法（很多是拼进 innerHTML 的字符串）。
// 这里不用 eval / new Function，而是在 document 捕获阶段做事件委托：读取元素上的 on* 属性文本，
// 用一个只认「受限文法」的小解析器解析，再调用 window 上同名的函数。
//
// 受限文法：语句以 ; 分隔；语句只能是
//   event.stopPropagation() / event.preventDefault()
//   [window.]a.b.c(参数, …)                         —— 只能调用 window 上已有的函数
//   if(event.key==='Enter'){ 语句… }                 —— 键盘事件常用
// 参数只能是：字符串 / 数字 / true false null undefined NaN Infinity / this / this.value / this.checked / event
// 不满足的写法会被拒绝并在控制台报错，不会被执行。
(function (root) {
  'use strict';

  var BLOCKED = { constructor: 1, __proto__: 1, prototype: 1, eval: 1, Function: 1, __defineGetter__: 1, __defineSetter__: 1, __lookupGetter__: 1, __lookupSetter__: 1 };
  var NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  var IDENT_RE = /^[A-Za-z_$][\w$]*/;

  function fail(msg, src) { throw new Error('inline handler: ' + msg + ' in: ' + String(src).slice(0, 120)); }

  // 读取一个字符串字面量，返回 { value, end }（end 为结束引号之后的下标）
  function readString(s, i) {
    var q = s[i], out = '';
    i++;
    while (i < s.length) {
      var c = s[i];
      if (c === q) return { value: out, end: i + 1 };
      if (c === '\\') {
        var n = s[i + 1];
        if (n === 'u') {
          var hex = s.substr(i + 2, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape', s);
          out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        var map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        out += (n in map) ? map[n] : n;
        i += 2; continue;
      }
      out += c; i++;
    }
    return fail('unterminated string', s);
  }

  function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

  function readArg(s, i) {
    i = skipWs(s, i);
    var c = s[i];
    if (c === "'" || c === '"') { var r = readString(s, i); return { arg: { k: 'lit', v: r.value }, end: r.end }; }
    var m = NUM_RE.exec(s.slice(i));
    if (m) return { arg: { k: 'lit', v: Number(m[0]) }, end: i + m[0].length };
    var id = IDENT_RE.exec(s.slice(i));
    if (!id) fail('unexpected token', s);
    var rest = s.slice(i), j = i;
    var path = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(rest)[0];
    j = i + path.length;
    var LITS = { true: true, false: false, null: null, undefined: undefined, NaN: NaN, Infinity: Infinity };
    if (Object.prototype.hasOwnProperty.call(LITS, path)) return { arg: { k: 'lit', v: LITS[path] }, end: j };
    if (path === 'this') return { arg: { k: 'this' }, end: j };
    if (path === 'this.value') return { arg: { k: 'thisValue' }, end: j };
    if (path === 'this.checked') return { arg: { k: 'thisChecked' }, end: j };
    if (path === 'event') return { arg: { k: 'event' }, end: j };
    return fail('unsupported argument "' + path + '"', s);
  }

  function parseCall(stmt) {
    var m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(stmt);
    if (!m) fail('not a call', stmt);
    var path = m[1].split('.');
    if (path[0] === 'window' && path.length > 1) path.shift();
    for (var p = 0; p < path.length; p++) if (BLOCKED[path[p]]) fail('blocked name ' + path[p], stmt);
    if (path.length === 2 && path[0] === 'event') {
      if (path[1] !== 'stopPropagation' && path[1] !== 'preventDefault') fail('unsupported event method', stmt);
      var tail = stmt.slice(m[0].length).trim();
      if (tail !== ')') fail('event methods take no arguments', stmt);
      return { t: path[1] === 'stopPropagation' ? 'stop' : 'prevent' };
    }
    var i = m[0].length, args = [];
    i = skipWs(stmt, i);
    if (stmt[i] === ')') i++;
    else {
      for (;;) {
        var r = readArg(stmt, i);
        args.push(r.arg);
        i = skipWs(stmt, r.end);
        if (stmt[i] === ',') { i++; continue; }
        if (stmt[i] === ')') { i++; break; }
        fail('expected , or )', stmt);
      }
    }
    if (stmt.slice(i).trim() !== '') fail('trailing characters', stmt);
    return { t: 'call', path: path, args: args };
  }

  // 按顶层的 ; 切分（忽略字符串与括号 / 花括号内部的 ;）
  function splitStatements(s) {
    var out = [], depth = 0, start = 0, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === "'" || c === '"') { i = readString(s, i).end; continue; }
      if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') depth--;
      else if (c === ';' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
      i++;
    }
    out.push(s.slice(start));
    return out.map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function parseProgram(src) {
    var text = String(src).trim();
    var ifm = /^if\s*\(\s*event\.key\s*===\s*(?:'([^']*)'|"([^"]*)")\s*\)\s*\{([\s\S]*)\}$/.exec(text);
    if (ifm) {
      return [{ t: 'ifKey', key: ifm[1] !== undefined ? ifm[1] : ifm[2], body: parseProgram(ifm[3]) }];
    }
    return splitStatements(text).map(parseCall);
  }

  function resolve(path, win) {
    var obj = win, parent = win;
    for (var i = 0; i < path.length; i++) {
      parent = obj;
      if (obj === null || obj === undefined) fail('cannot resolve ' + path.join('.'), path.join('.'));
      obj = obj[path[i]];
    }
    if (typeof obj !== 'function') fail(path.join('.') + ' is not a function', path.join('.'));
    // 只允许调用：① 应用自己定义的全局函数（非原生）；② electronAPI 上 preload 暴露的方法。
    // 这样即使有人把 onclick="fetch('…')" 之类写进属性，也调不到 fetch / open / alert 等浏览器内置函数。
    if (path.length === 1) {
      if (/\[native code\]/.test(Function.prototype.toString.call(obj))) fail('native function ' + path[0] + ' is not allowed', path[0]);
    } else if (path[0] !== 'electronAPI') {
      fail('only electronAPI.* may be called with a dotted path', path.join('.'));
    }
    return { fn: obj, self: parent };
  }

  // 执行解析结果。返回 { stopped }：handler 里是否调用了 event.stopPropagation()
  function run(program, el, ev, win) {
    var state = { stopped: false };
    (function exec(stmts) {
      for (var i = 0; i < stmts.length; i++) {
        var st = stmts[i];
        if (st.t === 'stop') { state.stopped = true; if (ev && ev.stopPropagation) ev.stopPropagation(); }
        else if (st.t === 'prevent') { if (ev && ev.preventDefault) ev.preventDefault(); }
        else if (st.t === 'ifKey') { if (ev && ev.key === st.key) exec(st.body); }
        else if (st.t === 'call') {
          var args = st.args.map(function (a) {
            switch (a.k) {
              case 'lit': return a.v;
              case 'this': return el;
              case 'thisValue': return el.value;
              case 'thisChecked': return el.checked;
              case 'event': return ev;
              default: return undefined;
            }
          });
          var r = resolve(st.path, win);
          r.fn.apply(r.self, args);
        }
      }
    })(program);
    return state;
  }

  var EVENTS = ['click', 'change', 'input', 'keydown'];
  var cache = {};

  function install(doc, win) {
    function handle(ev) {
      var node = ev.target;
      if (node && node.nodeType === 3) node = node.parentElement;
      var type = ev.type, attrName = 'on' + type, dataName = 'data-on' + type;
      var chain = [];
      for (var el = node; el && el !== doc && el.getAttribute; el = el.parentElement) {
        // 首次见到：把 on* 属性挪到 data-on*，这样浏览器自己不会再尝试（并被 CSP 拒绝）执行它
        var raw = el.getAttribute(attrName);
        if (raw !== null) { el.setAttribute(dataName, raw); el.removeAttribute(attrName); }
        if (el.hasAttribute(dataName)) chain.push(el);
      }
      for (var i = 0; i < chain.length; i++) {
        var target = chain[i];
        if (target.disabled) continue;
        var src = target.getAttribute(dataName);
        try {
          var program = cache[src] || (cache[src] = parseProgram(src));
          var res = run(program, target, ev, win);
          if (res.stopped) break;
        } catch (e) {
          if (win.console) win.console.error('[inline-handlers]', e && e.message);
        }
      }
    }
    EVENTS.forEach(function (t) { doc.addEventListener(t, handle, true); });
    return handle;
  }

  var api = { parseProgram: parseProgram, run: run, install: install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document && root.addEventListener) {
    root.NTInlineHandlers = api;
    install(root.document, root);
  }
})(typeof window !== 'undefined' ? window : undefined);
