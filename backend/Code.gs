/**
 * Бэкенд теста для пар «Мы вдвоём» — Google Apps Script.
 *
 * Хранит ответы в Google-таблице, к которой привязан скрипт, и отправляет письма через MailApp
 * (письма уходят с аккаунта Google, от имени которого развёрнут скрипт).
 *
 * Вопросы и движок разбора не копируются сюда: скрипт загружает assets/questions.js и
 * assets/analysis.js с сайта (SITE_URL), поэтому правки вопросов на сайте сразу действуют и здесь.
 *
 * Свойства скрипта (Project Settings → Script properties):
 *   SITE_URL           обязательно, например https://chardymov.github.io/
 *   ANTHROPIC_API_KEY  необязательно — если задан, в разбор добавляется раздел, написанный Claude
 *   CLAUDE_MODEL       необязательно, по умолчанию claude-opus-5-5
 *   SENDER_NAME        необязательно, имя отправителя писем
 *
 * Установка — см. README.md в корне репозитория.
 */

var PAIR_COLS = ['id', 'created', 'tokenA', 'nameA', 'emailA', 'answersA', 'tokenB', 'nameB', 'emailB', 'answersB', 'completed', 'score', 'claude', 'meta'];
var EVENT_COLS = ['time', 'name', 'sid', 'role', 'pair', 'utm', 'extra'];
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ───────────────────────── вход

function doPost(e) {
  var out;
  try {
    var d = JSON.parse(e.postData.contents);
    var fn = ROUTES[d.action];
    out = fn ? fn(d) : { ok: false, error: 'unknown_action' };
  } catch (err) {
    console.error(err && err.stack || err);
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  // JSON, чтобы сайт распознал ответ, если Google превратил POST в GET, и повторил запрос.
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'retry', info: 'Couples quiz backend is running.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

var ROUTES = {
  create: create_,
  invite: invite_,
  complete: complete_,
  report: report_,
  event: event_
};

// ───────────────────────── действия

// Первый партнёр отправил ответы: сохраняем, шлём ему копию и приглашение партнёру.
function create_(d) {
  loadShared_();
  return once_(d.rid, function () { return createPair_(d); });
}

// Повтор запроса с тем же rid (сайт повторяет, если ответ Google потерялся) возвращает
// сохранённый результат и не отправляет письма второй раз.
function once_(rid, fn) {
  if (!rid || !/^[a-z0-9]{8,32}$/.test(String(rid))) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var cache = CacheService.getScriptCache(), key = 'rid_' + rid, hit = cache.get(key);
    if (hit) return JSON.parse(hit);
    var res = fn();
    cache.put(key, JSON.stringify(res), 21600);
    return res;
  } finally {
    lock.releaseLock();
  }
}

function createPair_(d) {
  var nameA = cleanName_(d.nameA), nameB = cleanName_(d.nameB);
  var emailA = cleanEmail_(d.emailA), emailB = cleanEmail_(d.emailB);
  if (!nameA || !nameB) throw new Error('Укажите имена.');
  if (!emailA || !emailB) throw new Error('Проверьте адреса email.');
  if (emailA === emailB) throw new Error('Email партнёра должен отличаться от вашего.');
  var answers = cleanAnswers_(d.answers);
  rateLimit_('a:' + emailA, 3);
  rateLimit_('b:' + emailB, 3);
  ensureQuota_(2);

  // Буквенный префикс — чтобы Google Таблицы не превратили токен в число.
  var id = 'p' + token_(9), tokenA = 't' + token_(15), tokenB = 't' + token_(15);
  var meta = { utm: d.meta && d.meta.utm || {}, sid: d.meta && d.meta.sid || '' };
  sheet_('pairs', PAIR_COLS).appendRow([id, new Date(), tokenA, nameA, emailA, JSON.stringify(answers), tokenB, nameB, emailB, '', '', '', '', JSON.stringify(meta)]);

  var A = { name: nameA, email: emailA, answers: answers }, B = { name: nameB, email: emailB };
  send_(emailA, CQA.mail.initiator(A, B));
  send_(emailB, CQA.mail.invite(A, B, siteUrl_() + '?p=' + id + '&t=' + tokenB));
  return { ok: true, id: id };
}

// Партнёр открыл ссылку-приглашение.
function invite_(d) {
  var row = findPair_(d.id);
  if (!row || d.t !== row.data.tokenB) return { ok: false, error: 'not_found' };
  return { ok: true, nameA: row.data.nameA, nameB: row.data.nameB, emailB: row.data.emailB, completed: !!row.data.completed };
}

// Партнёр ответил: строим разбор, отправляем обоим.
function complete_(d) {
  loadShared_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = findPair_(d.id);
    if (!row || d.t !== row.data.tokenB) return { ok: false, error: 'not_found' };
    if (row.data.completed) return { ok: false, error: 'already_completed' };
    var nameB = cleanName_(d.nameB) || row.data.nameB;
    var emailB = cleanEmail_(d.emailB) || row.data.emailB;
    if (emailB === row.data.emailA) throw new Error('Email должен отличаться от email партнёра.');
    var answersB = cleanAnswers_(d.answers);
    ensureQuota_(2);

    var A = { name: row.data.nameA, email: row.data.emailA, answers: JSON.parse(row.data.answersA) };
    var B = { name: nameB, email: emailB, answers: answersB };
    var rep = CQA.report(A, B);
    var narrative = '';
    try { narrative = claudeNarrative_(rep.text); } catch (err) { console.error('Claude: ' + err); }
    var html = withNarrative_(rep.html, narrative);

    row.set({ nameB: nameB, emailB: emailB, answersB: JSON.stringify(answersB), completed: new Date(), score: rep.score, claude: narrative });

    var base = siteUrl_() + '?r=' + row.data.id + '&t=';
    send_(A.email, CQA.mail.result(A, B, html, base + row.data.tokenA, A.name));
    send_(B.email, CQA.mail.result(A, B, html, base + row.data.tokenB, B.name));
    return { ok: true, html: html, score: rep.score };
  } finally {
    lock.releaseLock();
  }
}

// Просмотр разбора по ссылке из письма (подходит токен любого из партнёров).
function report_(d) {
  var row = findPair_(d.id);
  if (!row || (d.t !== row.data.tokenA && d.t !== row.data.tokenB)) return { ok: false, error: 'not_found' };
  if (!row.data.completed) return { ok: false, error: 'not_ready' };
  loadShared_();
  var A = { name: row.data.nameA, answers: JSON.parse(row.data.answersA) };
  var B = { name: row.data.nameB, answers: JSON.parse(row.data.answersB) };
  return { ok: true, html: withNarrative_(CQA.report(A, B).html, row.data.claude) };
}

// События воронки — для анализа гипотез.
function event_(d) {
  var name = String(d.name || '').slice(0, 40);
  if (!/^[a-z_]+$/.test(name)) return { ok: false, error: 'bad_event' };
  sheet_('events', EVENT_COLS).appendRow([
    new Date(), name, String(d.sid || '').slice(0, 20), String(d.role || '').slice(0, 2), String(d.pair || '').slice(0, 20),
    JSON.stringify(d.utm || {}).slice(0, 500), JSON.stringify(d.extra || {}).slice(0, 500)
  ]);
  return { ok: true };
}

// ───────────────────────── Claude (необязательно)

function claudeNarrative_(reportText) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) return '';
  var body = {
    model: props.getProperty('CLAUDE_MODEL') || 'claude-opus-5-5',
    max_tokens: 4000,
    // Низкое усилие — чтобы ответ уложился в тайм-аут UrlFetchApp (~60 с).
    output_config: { effort: 'low' },
    // Если запрос отклонят классификаторы, API сам повторит его на рекомендованной модели.
    fallbacks: 'default',
    system: [
      'Ты — опытный семейный психолог. Тебе дают ответы двух партнёров на тест для пар и уже найденные автоматически динамики.',
      'Напиши для пары короткий тёплый разбор на русском языке: 3–5 абзацев простым текстом, без markdown, списков и заголовков.',
      'Обращайся к паре на «вы», партнёров называй по именам. Пол партнёров неизвестен: не используй местоимения и глагольные формы, выдающие пол.',
      'Опирайся на конкретные сочетания ответов. Не пересказывай найденные динамики — добавь то, что видно из их сочетания: как различия могут усиливать друг друга и где у пары ресурс.',
      'Не ставь диагнозов и не давай оценок «совместимы / несовместимы». Последний абзац — одна-две практические идеи на ближайшую неделю.'
    ].join(' '),
    messages: [{ role: 'user', content: reportText }]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(body)
  });
  if (res.getResponseCode() !== 200) {
    console.error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    return '';
  }
  var j = JSON.parse(res.getContentText());
  if (j.stop_reason === 'refusal') return '';
  return (j.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n\n').trim();
}

function withNarrative_(html, narrative) {
  if (!narrative) return html;
  var paras = String(narrative).split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(String);
  var inner = '<div style="font:600 11px/1 sans-serif;letter-spacing:.06em;text-transform:uppercase;color:' + CQA.colors.accent + ';margin:0 0 10px">Взгляд психолога · написано ИИ</div>' +
    paras.map(function (t) { return CQA.p(CQA.esc(t)); }).join('') +
    CQA.muted('Этот раздел написал ИИ (Claude) по вашим ответам. Он может ошибаться — воспринимайте его как повод для разговора.');
  return html.replace('<!--CLAUDE-->', CQA.h2('Общий взгляд на вашу пару') + CQA.card(inner, CQA.colors.accentSoft, '#efcfdb'));
}

// ───────────────────────── общие файлы с сайта

function loadShared_() {
  if (typeof CQA !== 'undefined') return; // файлы уже вставлены в проект или загружены
  var cache = CacheService.getScriptCache();
  var src = ['questions.js', 'analysis.js'].map(function (f) {
    var key = 'src_' + f, code = cache.get(key);
    if (!code) {
      var res = UrlFetchApp.fetch(siteUrl_() + 'assets/' + f + '?v=' + Date.now(), { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('Не удалось загрузить ' + f + ' с сайта (' + res.getResponseCode() + ')');
      code = res.getContentText();
      try { cache.put(key, code, 600); } catch (e) { /* больше 100 КБ — просто без кеша */ }
    }
    return code;
  }).join('\n;\n');
  (0, eval)(src); // объявляет глобальные CQ_DATA и CQA
}

// ───────────────────────── таблица

function sheet_(name, cols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(cols);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
  }
  return sh;
}

function findPair_(id) {
  if (!id || !/^[a-z0-9]{6,20}$/.test(String(id))) return null;
  var sh = sheet_('pairs', PAIR_COLS);
  var cell = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!cell) return null;
  var r = cell.getRow();
  var vals = sh.getRange(r, 1, 1, PAIR_COLS.length).getValues()[0];
  var data = {};
  PAIR_COLS.forEach(function (c, i) { data[c] = vals[i]; });
  return {
    data: data,
    set: function (obj) {
      Object.keys(obj).forEach(function (k) {
        sh.getRange(r, PAIR_COLS.indexOf(k) + 1).setValue(obj[k]);
        data[k] = obj[k];
      });
    }
  };
}

// ───────────────────────── проверки и утилиты

function cleanName_(s) {
  // Без начальных = + - @ — чтобы значение не стало формулой в таблице.
  return String(s || '').replace(/[<>\r\n\t]/g, '').replace(/\s+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, 40);
}
function cleanEmail_(s) {
  s = String(s || '').trim().toLowerCase();
  return EMAIL_RE.test(s) && !/^[=+\-@]/.test(s) && s.length <= 100 ? s : '';
}
function cleanAnswers_(a) {
  var out = {}, n = 0;
  a = a || {};
  CQ_DATA.questions.forEach(function (q) {
    var v = a[q.id] || a[String(q.id)];
    if (v && q.options[v]) { out[q.id] = v; n++; }
  });
  var required = CQ_DATA.questions.filter(function (q) { return !CQ_DATA.blocks.some(function (b) { return b.id === q.block && b.optional; }); });
  var missing = required.some(function (q) { return !out[q.id]; });
  if (missing) throw new Error('Ответьте, пожалуйста, на все вопросы.');
  return out;
}
function token_(len) {
  var s = '';
  while (s.length < len) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, len);
}
function siteUrl_() {
  var u = PropertiesService.getScriptProperties().getProperty('SITE_URL');
  if (!u) throw new Error('Не задано свойство скрипта SITE_URL');
  return u.replace(/\/?$/, '/');
}
// Не больше `max` действий на один адрес за 6 часов — защита от рассылки спама через форму.
function rateLimit_(key, max) {
  var cache = CacheService.getScriptCache();
  var k = 'rl_' + Utilities.base64EncodeWebSafe(key).slice(0, 200);
  var n = Number(cache.get(k) || 0);
  if (n >= max) throw new Error('Слишком много попыток с этим адресом. Попробуйте позже.');
  cache.put(k, String(n + 1), 21600);
}
function ensureQuota_(n) {
  if (MailApp.getRemainingDailyQuota() < n) throw new Error('На сегодня лимит писем исчерпан. Попробуйте завтра.');
}
function send_(to, m) {
  MailApp.sendEmail({
    to: to,
    subject: m.subject,
    htmlBody: m.html,
    body: CQA.plain(m.html.replace(/<\/(p|div|h2|li|tr)>/g, '\n')),
    name: PropertiesService.getScriptProperties().getProperty('SENDER_NAME') || 'Мы вдвоём · тест для пар'
  });
}

// ───────────────────────── ручные проверки из редактора

// Запустите один раз из редактора: создаст листы и попросит разрешения (таблица, почта, внешние запросы).
function setup() {
  sheet_('pairs', PAIR_COLS);
  sheet_('events', EVENT_COLS);
  loadShared_();
  console.log('Готово. Вопросов: ' + CQ_DATA.questions.length + '. Писем осталось на сегодня: ' + MailApp.getRemainingDailyQuota());
}

// Отправляет себе пример разбора по случайным ответам — чтобы посмотреть, как выглядит письмо.
function sendTestReport() {
  loadShared_();
  function rnd() {
    var a = {};
    CQ_DATA.questions.forEach(function (q) { var k = Object.keys(q.options); a[q.id] = k[Math.floor(Math.random() * k.length)]; });
    return a;
  }
  var me = Session.getActiveUser().getEmail();
  var A = { name: 'Аня', email: me, answers: rnd() }, B = { name: 'Макс', email: me, answers: rnd() };
  var rep = CQA.report(A, B);
  var html = withNarrative_(rep.html, claudeNarrative_(rep.text));
  send_(me, CQA.mail.result(A, B, html, '', A.name));
  console.log('Отправлено на ' + me + ', индекс ' + rep.score + '%');
}
