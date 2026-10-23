/**
 * Бэкенд теста для пар «Мы вдвоём» — Google Apps Script.
 *
 * Хранит ответы в Google-таблице, к которой привязан скрипт, и отправляет письма через MailApp
 * (письма уходят с аккаунта Google, от имени которого развёрнут скрипт).
 *
 * Вопросы и движок разбора не копируются сюда: скрипт загружает assets/questions.js, topics.js,
 * analysis.js и talks.js с сайта (SITE_URL), поэтому правки вопросов на сайте сразу действуют и здесь.
 *
 * Пара (лист pairs) — это два человека со своими токенами. Внутри пары есть модули:
 * «Портрет пары» (ответы в pairs) и темы раздела «Разговоры» (лист talks, строка на тему).
 * Модуль завершён, когда ответили оба; тогда обоим уходит разбор. Разбор темы учитывает
 * портрет и все темы, которые пара уже завершила (только то, что оба уже видели).
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
var TALK_COLS = ['id', 'pair', 'topic', 'created', 'answersA', 'answersB', 'completed', 'claude'];
var EVENT_COLS = ['time', 'name', 'sid', 'role', 'pair', 'utm', 'extra'];
var SHARED_FILES = ['questions.js', 'topics.js', 'analysis.js', 'talks.js'];
var SHARED_VERSION = '7'; // меняется вместе с ?v= на сайте — сбрасывает кеш файлов
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
  start: start_,
  cabinet: cabinet_,
  answer: answer_,
  talk: talk_,
  event: event_
};

// ───────────────────────── действия

// Первый партнёр отправил ответы: сохраняем, шлём ему копию и приглашение партнёру.
function create_(d) {
  loadShared_();
  return once_(d.rid, function () { return createPair_(d); });
}

// Повтор запроса с тем же rid (сайт повторяет, если ответ Google потерялся) возвращает
// сохранённый результат и не отправляет письма второй раз. Без rid — просто под блокировкой.
function once_(rid, fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ok = rid && /^[a-z0-9]{8,32}$/.test(String(rid));
    var cache = CacheService.getScriptCache(), key = 'rid_' + rid, hit = ok && cache.get(key);
    if (hit) return JSON.parse(hit);
    var res = fn();
    if (ok) { try { cache.put(key, JSON.stringify(res), 21600); } catch (e) { /* ответ больше 100 КБ — без кеша */ } }
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
  send_(emailA, CQA.mail.initiator(A, B, cabLink_(id, tokenA)));
  send_(emailB, CQA.mail.invite(A, B, siteUrl_() + '?p=' + id + '&t=' + tokenB));
  return { ok: true, id: id, t: tokenA };
}

// Новая пара начинает сразу с темы раздела «Разговоры» (без портрета).
function start_(d) {
  loadShared_();
  return once_(d.rid, function () {
    var topic = CQT.topic(d.topic);
    if (!topic) throw new Error('Тема не найдена.');
    var nameA = cleanName_(d.nameA), nameB = cleanName_(d.nameB);
    var emailA = cleanEmail_(d.emailA), emailB = cleanEmail_(d.emailB);
    if (!nameA || !nameB) throw new Error('Укажите имена.');
    if (!emailA || !emailB) throw new Error('Проверьте адреса email.');
    if (emailA === emailB) throw new Error('Email партнёра должен отличаться от вашего.');
    var mine = CQT.cleanTopic(topic, d);
    rateLimit_('a:' + emailA, 3);
    rateLimit_('b:' + emailB, 3);
    ensureQuota_(2);

    var id = 'p' + token_(9), tokenA = 't' + token_(15), tokenB = 't' + token_(15);
    var meta = { utm: d.meta && d.meta.utm || {}, sid: d.meta && d.meta.sid || '', start: topic.id };
    sheet_('pairs', PAIR_COLS).appendRow([id, new Date(), tokenA, nameA, emailA, '', tokenB, nameB, emailB, '', '', '', '', JSON.stringify(meta)]);
    sheet_('talks', TALK_COLS).appendRow(['s' + token_(9), id, topic.id, new Date(), JSON.stringify(mine), '', '', '']);

    var A = { name: nameA, email: emailA }, B = { name: nameB, email: emailB };
    send_(emailA, CQT.mail.topicStarted(A, B, topic, cabLink_(id, tokenA)));
    send_(emailB, CQT.mail.topicInvite(A, B, topic, cabLink_(id, tokenB) + '&topic=' + topic.id));
    return { ok: true, id: id, t: tokenA };
  });
}

// Кабинет пары: кто на что уже ответил.
function cabinet_(d) {
  var row = findPair_(d.id), me = roleOf_(row, d.t);
  if (!me) return { ok: false, error: 'not_found' };
  var other = me === 'A' ? 'B' : 'A', topics = {};
  latestTalks_(findTalks_(row.data.id)).forEach(function (s) {
    topics[s.data.topic] = { me: !!s.data['answers' + me], partner: !!s.data['answers' + other], done: !!s.data.completed };
  });
  return {
    ok: true, me: me, nameMe: row.data['name' + me], namePartner: row.data['name' + other], emailMe: row.data['email' + me],
    portrait: { me: !!row.data['answers' + me], partner: !!row.data['answers' + other], done: !!row.data.completed },
    topics: topics
  };
}

// Ответы одного из партнёров на модуль (портрет или тему) из кабинета.
// Если второй уже ответил — строим разбор и отправляем обоим, иначе зовём второго.
function answer_(d) {
  loadShared_();
  return once_(d.rid, function () {
    var row = findPair_(d.id), me = roleOf_(row, d.t);
    if (!me) return { ok: false, error: 'not_found' };
    var other = me === 'A' ? 'B' : 'A', P = row.data;
    var self = { name: P['name' + me], email: P['email' + me] }, partner = { name: P['name' + other], email: P['email' + other] };

    if (d.kind === 'portrait') {
      if (P['answers' + me]) return P.completed ? { ok: true, done: true, html: portraitHtml_(row) } : { ok: true, done: false };
      var answers = cleanAnswers_(d.answers);
      ensureQuota_(2);
      var set = {};
      set['answers' + me] = JSON.stringify(answers);
      if (!P['answers' + other]) {
        row.set(set);
        send_(partner.email, CQT.mail.portraitInvite(self, partner, cabLink_(P.id, P['token' + other]) + '&go=portrait'));
        return { ok: true, done: false };
      }
      var A = { name: P.nameA, email: P.emailA, answers: me === 'A' ? answers : JSON.parse(P.answersA) };
      var B = { name: P.nameB, email: P.emailB, answers: me === 'B' ? answers : JSON.parse(P.answersB) };
      var rep = CQA.report(A, B), narrative = '';
      try { narrative = claudeNarrative_(rep.text, PORTRAIT_PROMPT); } catch (err) { console.error('Claude: ' + err); }
      var html = withNarrative_(rep.html, narrative, 'Общий взгляд на вашу пару');
      set.completed = new Date(); set.score = rep.score; set.claude = narrative;
      row.set(set);
      var base = siteUrl_() + '?r=' + P.id + '&t=';
      send_(A.email, CQA.mail.result(A, B, html, base + P.tokenA, A.name, cabLink_(P.id, P.tokenA)));
      send_(B.email, CQA.mail.result(A, B, html, base + P.tokenB, B.name, cabLink_(P.id, P.tokenB)));
      return { ok: true, done: true, html: html };
    }

    var topic = CQT.topic(d.kind);
    if (!topic) return { ok: false, error: 'bad_topic' };
    var talks = findTalks_(P.id), s = latestTalks_(talks).filter(function (x) { return x.data.topic === topic.id; })[0];
    if (s && s.data['answers' + me]) return s.data.completed ? { ok: true, done: true, html: talkHtml_(row, talks, s, me) } : { ok: true, done: false };
    var mine = CQT.cleanTopic(topic, d);
    ensureQuota_(2);
    if (!s) {
      var tid = 's' + token_(9), vals = [tid, P.id, topic.id, new Date(), '', '', '', ''];
      vals[TALK_COLS.indexOf('answers' + me)] = JSON.stringify(mine);
      sheet_('talks', TALK_COLS).appendRow(vals);
      send_(partner.email, CQT.mail.topicInvite(self, partner, topic, cabLink_(P.id, P['token' + other]) + '&topic=' + topic.id));
      return { ok: true, done: false };
    }
    if (!s.data['answers' + other]) {
      var only = {};
      only['answers' + me] = JSON.stringify(mine);
      s.set(only);
      send_(partner.email, CQT.mail.topicInvite(self, partner, topic, cabLink_(P.id, P['token' + other]) + '&topic=' + topic.id));
      return { ok: true, done: false };
    }
    s.data['answers' + me] = JSON.stringify(mine);
    var r = buildTalk_(row, talks, s);
    var narr = '';
    try { narr = claudeNarrative_(r.text, TOPIC_PROMPT); } catch (err) { console.error('Claude: ' + err); }
    var done = { completed: new Date(), claude: narr };
    done['answers' + me] = s.data['answers' + me];
    s.set(done);
    var out = withNarrative_(r.html, narr, 'Взгляд психолога на этот разговор');
    send_(P.emailA, CQT.mail.topicResult(r.X, r.Y, topic, out, cabLink_(P.id, P.tokenA) + '&topic=' + topic.id, P.nameA));
    send_(P.emailB, CQT.mail.topicResult(r.X, r.Y, topic, out, cabLink_(P.id, P.tokenB) + '&topic=' + topic.id, P.nameB));
    return { ok: true, done: true, html: out };
  });
}

// Просмотр разбора темы из кабинета.
function talk_(d) {
  var row = findPair_(d.id), me = roleOf_(row, d.t);
  if (!me) return { ok: false, error: 'not_found' };
  loadShared_();
  var talks = findTalks_(row.data.id);
  var s = latestTalks_(talks).filter(function (x) { return x.data.topic === d.topic; })[0];
  if (!s || !s.data.completed) return { ok: false, error: 'not_ready' };
  return { ok: true, html: talkHtml_(row, talks, s, me) };
}

// Собирает участников разговора: ответы темы + всё, что пара уже прошла вдвоём.
function buildTalk_(row, talks, s) {
  var P = row.data, topic = CQT.topic(s.data.topic), mods = [];
  var allA = {}, allB = {};
  function merge(dst, src) { Object.keys(src || {}).forEach(function (k) { dst[k] = src[k]; }); }
  if (P.completed && P.answersA && P.answersB) {
    mods.push('portrait');
    merge(allA, JSON.parse(P.answersA)); merge(allB, JSON.parse(P.answersB));
  }
  latestTalks_(talks).forEach(function (x) {
    if (x.data.id === s.data.id || !x.data.completed || !CQT.topic(x.data.topic)) return;
    mods.push(x.data.topic);
    merge(allA, JSON.parse(x.data.answersA).a); merge(allB, JSON.parse(x.data.answersB).a);
  });
  var a = JSON.parse(s.data.answersA), b = JSON.parse(s.data.answersB);
  merge(allA, a.a); merge(allB, b.a);
  var X = { name: P.nameA, email: P.emailA, a: a.a, g: a.g || {}, note: a.note || '', all: allA };
  var Y = { name: P.nameB, email: P.emailB, a: b.a, g: b.g || {}, note: b.note || '', all: allB };
  var r = CQT.report(topic.id, X, Y, { mods: mods });
  r.X = X; r.Y = Y;
  return r;
}
function talkHtml_(row, talks, s) {
  return withNarrative_(buildTalk_(row, talks, s).html, s.data.claude, 'Взгляд психолога на этот разговор');
}
function portraitHtml_(row) {
  var A = { name: row.data.nameA, answers: JSON.parse(row.data.answersA) };
  var B = { name: row.data.nameB, answers: JSON.parse(row.data.answersB) };
  return withNarrative_(CQA.report(A, B).html, row.data.claude, 'Общий взгляд на вашу пару');
}

// Партнёр открыл ссылку-приглашение.
function invite_(d) {
  var row = findPair_(d.id);
  // Пары, начатые с темы, приглашают партнёра в кабинет, а не по этой ссылке.
  if (!row || d.t !== row.data.tokenB || !row.data.answersA) return { ok: false, error: 'not_found' };
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
    try { narrative = claudeNarrative_(rep.text, PORTRAIT_PROMPT); } catch (err) { console.error('Claude: ' + err); }
    var html = withNarrative_(rep.html, narrative, 'Общий взгляд на вашу пару');

    row.set({ nameB: nameB, emailB: emailB, answersB: JSON.stringify(answersB), completed: new Date(), score: rep.score, claude: narrative });

    var base = siteUrl_() + '?r=' + row.data.id + '&t=';
    send_(A.email, CQA.mail.result(A, B, html, base + row.data.tokenA, A.name, cabLink_(row.data.id, row.data.tokenA)));
    send_(B.email, CQA.mail.result(A, B, html, base + row.data.tokenB, B.name, cabLink_(row.data.id, row.data.tokenB)));
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
  return { ok: true, html: portraitHtml_(row) };
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

var PORTRAIT_PROMPT = [
  'Ты — опытный семейный психолог. Тебе дают ответы двух партнёров на тест для пар и уже найденные автоматически динамики.',
  'На некоторые вопросы человек мог выбрать два варианта — они перечислены через точку с запятой.',
  'Напиши для пары короткий тёплый разбор на русском языке: 3–5 абзацев простым текстом, без markdown, списков и заголовков.',
  'Обращайся к паре на «вы», партнёров называй по именам. Пол партнёров неизвестен: не используй местоимения и глагольные формы, выдающие пол.',
  'Опирайся на конкретные сочетания ответов. Не пересказывай найденные динамики — добавь то, что видно из их сочетания: как различия могут усиливать друг друга и где у пары ресурс.',
  'Не ставь диагнозов и не давай оценок «совместимы / несовместимы». Последний абзац — одна-две практические идеи на ближайшую неделю.'
].join(' ');

var TOPIC_PROMPT = [
  'Ты — опытный семейный психолог. Пара, которая давно вместе и разучилась разговаривать, прошла одну тему для разговора.',
  'Каждый ответил на вопросы сам и на часть вопросов попробовал угадать ответ партнёра. Тебе дают их ответы, догадки, связи с портретом пары и прошлыми темами, оси и ответы из ранее пройденных модулей.',
  'Напиши для пары тёплый разбор на русском языке: 3–4 абзаца простым текстом, без markdown, списков и заголовков.',
  'Обращайся к паре на «вы», партнёров называй по именам. Пол партнёров неизвестен: не используй местоимения и глагольные формы, выдающие пол.',
  'Главное — помочь им начать разговор, а не оценить их. Свяжи ответы этой темы с тем, что уже известно из портрета и прошлых тем: какие сквозные мотивы видны у каждого, откуда может расти поведение, которое мешает паре.',
  'Отдельно отметь, где догадки не совпали с ответами: это места, где представления друг о друге устарели, — подай это с любопытством, без упрёка.',
  'Не пересказывай ответы списком и не ставь диагнозов. Если видишь признаки серьёзной боли, мягко упомяни, что с этим может помочь семейный психолог.',
  'Закончи одним открытым вопросом, с которого паре стоит начать разговор сегодня вечером.'
].join(' ');

function claudeNarrative_(reportText, system) {
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
    system: system || PORTRAIT_PROMPT,
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

function withNarrative_(html, narrative, heading) {
  if (!narrative) return html;
  var paras = String(narrative).split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(String);
  var inner = '<div style="font:600 11px/1 sans-serif;letter-spacing:.06em;text-transform:uppercase;color:' + CQA.colors.accent + ';margin:0 0 10px">Взгляд психолога · написано ИИ</div>' +
    paras.map(function (t) { return CQA.p(CQA.esc(t)); }).join('') +
    CQA.muted('Этот раздел написал ИИ (Claude) по вашим ответам. Он может ошибаться — воспринимайте его как повод для разговора.');
  return html.replace('<!--CLAUDE-->', CQA.h2(heading || 'Общий взгляд на вашу пару') + CQA.card(inner, CQA.colors.accentSoft, '#efcfdb'));
}

// ───────────────────────── общие файлы с сайта

function loadShared_() {
  if (typeof CQT !== 'undefined') return; // файлы уже вставлены в проект или загружены
  var cache = CacheService.getScriptCache();
  var src = SHARED_FILES.map(function (f) {
    var key = 'src' + SHARED_VERSION + '_' + f, code = cache.get(key);
    if (!code) {
      var res = UrlFetchApp.fetch(siteUrl_() + 'assets/' + f + '?v=' + Date.now(), { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error('Не удалось загрузить ' + f + ' с сайта (' + res.getResponseCode() + ')');
      code = res.getContentText();
      try { cache.put(key, code, 600); } catch (e) { /* больше 100 КБ — просто без кеша */ }
    }
    return code;
  }).join('\n;\n');
  (0, eval)(src); // объявляет глобальные CQ_DATA, CQ_TOPICS, CQA и CQT
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

// Все строки тем пары (по одной на тему; на случай дублей берём последнюю).
function findTalks_(pairId) {
  var sh = sheet_('talks', TALK_COLS);
  return sh.getRange('B:B').createTextFinder(String(pairId)).matchEntireCell(true).findAll().map(function (cell) {
    return rowObj_(sh, TALK_COLS, cell.getRow());
  });
}
function latestTalks_(talks) {
  var by = {};
  talks.forEach(function (s) { by[s.data.topic] = s; });
  return Object.keys(by).map(function (k) { return by[k]; });
}
function rowObj_(sh, cols, r) {
  var vals = sh.getRange(r, 1, 1, cols.length).getValues()[0];
  var data = {};
  cols.forEach(function (c, i) { data[c] = vals[i]; });
  return {
    data: data,
    set: function (obj) {
      Object.keys(obj).forEach(function (k) {
        sh.getRange(r, cols.indexOf(k) + 1).setValue(obj[k]);
        data[k] = obj[k];
      });
    }
  };
}
function roleOf_(row, t) {
  if (!row || !t) return null;
  return t === row.data.tokenA ? 'A' : t === row.data.tokenB ? 'B' : null;
}
function cabLink_(id, token) { return siteUrl_() + '?c=' + id + '&t=' + token; }

function findPair_(id) {
  if (!id || !/^[a-z0-9]{6,20}$/.test(String(id))) return null;
  var sh = sheet_('pairs', PAIR_COLS);
  var cell = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  if (!cell) return null;
  return rowObj_(sh, PAIR_COLS, cell.getRow());
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
  var out = {};
  a = a || {};
  CQ_DATA.questions.forEach(function (q) {
    var v = CQT.cleanKeys(q, a[q.id] || a[String(q.id)]);
    if (v) out[q.id] = v;
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
  sheet_('talks', TALK_COLS);
  sheet_('events', EVENT_COLS);
  loadShared_();
  console.log('Готово. Вопросов портрета: ' + CQ_DATA.questions.length + ', тем: ' + CQT.topics.length + '. Писем осталось на сегодня: ' + MailApp.getRemainingDailyQuota());
}

// Отправляет себе пример разбора по случайным ответам — чтобы посмотреть, как выглядит письмо.
function sendTestReport() {
  loadShared_();
  var me = Session.getActiveUser().getEmail();
  var A = { name: 'Аня', email: me, answers: rndAnswers_(CQ_DATA.questions) }, B = { name: 'Макс', email: me, answers: rndAnswers_(CQ_DATA.questions) };
  var rep = CQA.report(A, B);
  var html = withNarrative_(rep.html, claudeNarrative_(rep.text, PORTRAIT_PROMPT));
  send_(me, CQA.mail.result(A, B, html, '', A.name));
  console.log('Отправлено на ' + me + ', индекс ' + rep.score + '%');
}

// Пример разбора темы «Страхи и уязвимость» (с портретом) на случайных ответах.
function sendTestTalk() {
  loadShared_();
  var me = Session.getActiveUser().getEmail(), topic = CQT.topic('fears');
  function person(name) {
    var all = rndAnswers_(CQ_DATA.questions), a = rndAnswers_(topic.questions), g = rndAnswers_(topic.questions.filter(function (q) { return q.guess; }));
    Object.keys(a).forEach(function (k) { all[k] = a[k]; });
    return { name: name, email: me, a: a, g: g, note: '', all: all };
  }
  var X = person('Аня'), Y = person('Макс');
  var r = CQT.report(topic.id, X, Y, { mods: ['portrait'] });
  var html = withNarrative_(r.html, claudeNarrative_(r.text, TOPIC_PROMPT), 'Взгляд психолога на этот разговор');
  send_(me, CQT.mail.topicResult(X, Y, topic, html, '', X.name));
  console.log('Отправлено на ' + me);
}

function rndAnswers_(qs) {
  var a = {};
  qs.forEach(function (q) {
    var k = Object.keys(q.options), n = 1 + Math.floor(Math.random() * (q.multi || 1)), s = [];
    while (s.length < n) { var x = k[Math.floor(Math.random() * k.length)]; if (s.indexOf(x) < 0) s.push(x); }
    a[q.id] = (q.multi || 1) > 1 ? s : s[0];
  });
  return a;
}
