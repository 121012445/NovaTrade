'use strict';
// 诊断包与更新检查（纯逻辑，便于测试）。
//
// 诊断包：让用户一键导出一份可以发给开发者排查问题的文本。凭据一律脱敏：
// 机器人令牌、Bearer / sk- 密钥、URL 里的查询参数与账号密码、代理账号密码都会被替换。

function redactLog(text) {
  return String(text || '')
    .replace(/(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}/g, '<telegram-token>')                       // Telegram bot token
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '<api-key>')                              // OpenAI 风格密钥
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<token>')
    .replace(/(api[_-]?key|token|secret|signature|sign|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2<redacted>')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1<credentials>@')                        // scheme://user:pass@host
    .replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"')]+/g, '$1?<query>');                         // URL 查询参数
}

// 只取日志末尾（避免导出几十 MB），并按行整齐截断
function tail(text, maxBytes) {
  const s = String(text || '');
  if (s.length <= maxBytes) return s;
  const cut = s.slice(s.length - maxBytes);
  const nl = cut.indexOf('\n');
  return '…（已截断，仅保留末尾）\n' + (nl >= 0 ? cut.slice(nl + 1) : cut);
}

function buildReport(o) {
  const lines = [];
  lines.push('NovaTrade 诊断包');
  lines.push('生成时间: ' + new Date(o.now || Date.now()).toISOString());
  lines.push('');
  lines.push('[版本]');
  Object.keys(o.versions || {}).forEach((k) => lines.push(k + ': ' + o.versions[k]));
  lines.push('');
  lines.push('[代理]');
  const ps = o.proxyStatus || {};
  lines.push('mode: ' + (ps.mode || '-') + '  proxy: ' + (ps.proxy ? redactLog(ps.proxy) : '(none)') + '  error: ' + (ps.error || '-'));
  lines.push('');
  lines.push('[图形]');
  lines.push(JSON.stringify(o.gpu || {}));
  lines.push('');
  lines.push('[其它]');
  Object.keys(o.extra || {}).forEach((k) => lines.push(k + ': ' + redactLog(JSON.stringify(o.extra[k]))));
  lines.push('');
  lines.push('[error.log 末尾 ' + Math.round((o.maxLogBytes || 0) / 1024) + 'KB（已脱敏）]');
  lines.push(redactLog(tail(o.errorLog, o.maxLogBytes || 200 * 1024)));
  return lines.join('\n');
}

// 版本比较：返回 1 / 0 / -1；忽略前缀 v 与预发布后缀
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 检查 GitHub 最新发布。request(host, path) -> JSON（复用统一 HTTP 层）；仓库没有发布（404）视为「没有更新」。
async function checkUpdate(o) {
  let rel;
  try { rel = await o.request('api.github.com', '/repos/' + o.repo + '/releases/latest'); }
  catch (e) {
    if (e && e.status === 404) return { ok: true, current: o.current, latest: null, newer: false, none: true };
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
  const tag = rel && typeof rel.tag_name === 'string' ? rel.tag_name : '';
  if (!tag) return { ok: true, current: o.current, latest: null, newer: false, none: true };
  const url = typeof rel.html_url === 'string' && /^https:\/\/github\.com\//.test(rel.html_url) ? rel.html_url : 'https://github.com/' + o.repo + '/releases';
  return {
    ok: true, current: o.current, latest: tag.replace(/^v/i, ''), newer: compareVersions(tag, o.current) > 0, url,
    name: String(rel.name || tag).slice(0, 80), publishedAt: rel.published_at || null,
    notes: String(rel.body || '').slice(0, 1200)
  };
}

module.exports = { redactLog, tail, buildReport, compareVersions, checkUpdate };
