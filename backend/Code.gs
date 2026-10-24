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
 * Если задан ключ Claude, разбор по правилам сразу показывается на сайте, а письма уходят
 * через минуту-две — после того как Claude допишет свой раздел. Запросы к Claude выполняет
 * фоновая задача runJobs (лист jobs + таймер), чтобы не упираться в тайм-аут веб-запроса.
 * Там же готовится «общий разбор» по всем модулям, который пара запрашивает из кабинета.
 *
 * Свойства скрипта (Project Settings → Script properties):
 *   SITE_URL           обязательно, например https://chardymov.github.io/
 *   ANTHROPIC_API_KEY  необязательно — если задан, в разбор добавляется раздел, написанный Claude
 *   CLAUDE_MODEL       необязательно, по умолчанию claude-opus-5-5
 *   SENDER_NAME        необязательно, имя отправителя писем
 *
 * Установка — см. README.md в корне репозитория.
 */

var PAIR_COLS = ['id', 'created', 'tokenA', 'nameA', 'emailA', 'answersA', 'tokenB', 'nameB', 'emailB', 'answersB', 'completed', 'score', 'claude', 'meta', 'genderA', 'genderB', 'context'];
var TALK_COLS = ['id', 'pair', 'topic', 'created', 'answersA', 'answersB', 'completed', 'claude'];
var JOB_COLS = ['id', 'created', 'kind', 'pair', 'talk', 'status', 'attempts', 'updated', 'error'];
var OVERALL_COLS = ['pair', 'created', 'modules', 'text'];
var OVERALL_MIN = 3; // столько модулей нужно пройти вдвоём, чтобы запросить общий разбор
var EVENT_COLS = ['time', 'name', 'sid', 'role', 'pair', 'utm', 'extra'];
var SHARED_FILES = ['questions.js', 'topics.js', 'analysis.js', 'talks.js'];
var SHARED_VERSION = '10'; // меняется вместе с ?v= на сайте — сбрасывает кеш файлов
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
  context: context_,
  overall_request: overallRequest_,
  overall_view: overallView_,
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
  var gA = cleanGender_(d.genderA), gB = cleanGender_(d.genderB), ctx = CQA.cleanContext(d.context);
  sheet_('pairs', PAIR_COLS).appendRow([id, new Date(), tokenA, nameA, emailA, JSON.stringify(answers), tokenB, nameB, emailB, '', '', '', '', JSON.stringify(meta), gA, gB, ctx ? JSON.stringify(ctx) : '']);

  var A = { name: nameA, email: emailA, gender: gA, answers: answers }, B = { name: nameB, email: emailB, gender: gB };
  send_(emailA, CQA.mail.initiator(A, B, cabLink_(id, tokenA), ctx));
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
    var ctx = CQA.cleanContext(d.context);
    var mine = CQT.cleanTopic(topic, d, ctx);
    rateLimit_('a:' + emailA, 3);
    rateLimit_('b:' + emailB, 3);
    ensureQuota_(2);

    var id = 'p' + token_(9), tokenA = 't' + token_(15), tokenB = 't' + token_(15);
    var meta = { utm: d.meta && d.meta.utm || {}, sid: d.meta && d.meta.sid || '', start: topic.id };
    var gA = cleanGender_(d.genderA), gB = cleanGender_(d.genderB);
    sheet_('pairs', PAIR_COLS).appendRow([id, new Date(), tokenA, nameA, emailA, '', tokenB, nameB, emailB, '', '', '', '', JSON.stringify(meta), gA, gB, ctx ? JSON.stringify(ctx) : '']);
    sheet_('talks', TALK_COLS).appendRow(['s' + token_(9), id, topic.id, new Date(), JSON.stringify(mine), '', '', '']);

    var A = { name: nameA, email: emailA, gender: gA }, B = { name: nameB, email: emailB, gender: gB };
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
  var modules = (row.data.completed ? 1 : 0) + Object.keys(topics).filter(function (k) { return topics[k].done; }).length;
  var last = lastOverall_(row.data.id);
  return {
    ok: true, me: me, nameMe: row.data['name' + me], namePartner: row.data['name' + other], emailMe: row.data['email' + me],
    genderMe: row.data['gender' + me] || '', genderPartner: row.data['gender' + other] || '',
    context: json_(row.data.context),
    portrait: { me: !!row.data['answers' + me], partner: !!row.data['answers' + other], done: !!row.data.completed },
    topics: topics,
    ai: aiOn_(), modules: modules, overallMin: OVERALL_MIN,
    overall: { at: last ? fmtDate_(last.created) : '', modules: last ? Number(last.modules) : 0, pending: hasJob_(row.data.id, 'overall') }
  };
}

// Установочные вопросы о паре (из кабинета): сохраняем или меняем.
function context_(d) {
  loadShared_();
  var row = findPair_(d.id), me = roleOf_(row, d.t);
  if (!me) return { ok: false, error: 'not_found' };
  var ctx = CQA.cleanContext(d.context);
  if (!ctx) return { ok: false, error: 'Ответьте, пожалуйста, на все вопросы о паре.' };
  row.set({ context: JSON.stringify(ctx) });
  return { ok: true, context: ctx };
}

// Ответы одного из партнёров на модуль (портрет или тему) из кабинета.
// Если второй уже ответил — строим разбор и отправляем обоим, иначе зовём второго.
function answer_(d) {
  loadShared_();
  return once_(d.rid, function () {
    var row = findPair_(d.id), me = roleOf_(row, d.t);
    if (!me) return { ok: false, error: 'not_found' };
    var other = me === 'A' ? 'B' : 'A', P = row.data;
    var g = cleanGender_(d.gender);
    if (g && g !== P['gender' + me]) { var gs = {}; gs['gender' + me] = g; row.set(gs); }
    var self = person_(P, me), partner = person_(P, other);

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
      row.set(set);
      return finishPortrait_(row);
    }

    var topic = CQT.topic(d.kind);
    if (!topic) return { ok: false, error: 'bad_topic' };
    var talks = findTalks_(P.id), s = latestTalks_(talks).filter(function (x) { return x.data.topic === topic.id; })[0];
    if (s && s.data['answers' + me]) return s.data.completed ? { ok: true, done: true, html: talkHtml_(row, talks, s, me) } : { ok: true, done: false };
    var mine = CQT.cleanTopic(topic, d, ctx_(P));
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
    var done = { completed: new Date(), claude: '' };
    done['answers' + me] = JSON.stringify(mine);
    s.set(done);
    return finishTalk_(row, talks, s);
  });
}

// Модуль завершён. Без ключа Claude письма уходят сразу; с ключом — фоновая задача
// допишет раздел от Claude и разошлёт письма, а сайт пока показывает разбор по правилам.
function finishPortrait_(row) {
  var P = row.data, rep = CQA.report(personWith_(P, 'A'), personWith_(P, 'B'), { ctx: ctx_(P) });
  row.set({ completed: new Date(), score: rep.score, claude: '' });
  if (aiOn_()) { enqueue_('portrait', P.id, ''); return { ok: true, done: true, html: rep.html, aiPending: true }; }
  sendPortraitMails_(row, rep.html);
  return { ok: true, done: true, html: rep.html };
}
function finishTalk_(row, talks, s) {
  var r = buildTalk_(row, talks, s);
  if (aiOn_()) { enqueue_('talk', row.data.id, s.data.id); return { ok: true, done: true, html: r.html, aiPending: true }; }
  sendTalkMails_(row, s, r, r.html);
  return { ok: true, done: true, html: r.html };
}
function sendPortraitMails_(row, html) {
  var P = row.data, A = person_(P, 'A'), B = person_(P, 'B'), base = siteUrl_() + '?r=' + P.id + '&t=';
  send_(A.email, CQA.mail.result(A, B, html, base + P.tokenA, A.name, cabLink_(P.id, P.tokenA)));
  send_(B.email, CQA.mail.result(A, B, html, base + P.tokenB, B.name, cabLink_(P.id, P.tokenB)));
}
function sendTalkMails_(row, s, r, html) {
  var P = row.data, topic = CQT.topic(s.data.topic);
  send_(P.emailA, CQT.mail.topicResult(r.X, r.Y, topic, html, cabLink_(P.id, P.tokenA) + '&topic=' + topic.id, P.nameA));
  send_(P.emailB, CQT.mail.topicResult(r.X, r.Y, topic, html, cabLink_(P.id, P.tokenB) + '&topic=' + topic.id, P.nameB));
}

// ───────────────────────── общий разбор

// Пара просит общий разбор из кабинета: ставим задачу, письмо придёт обоим.
function overallRequest_(d) {
  return once_(d.rid, function () {
    var row = findPair_(d.id), me = roleOf_(row, d.t);
    if (!me) return { ok: false, error: 'not_found' };
    if (!aiOn_()) return { ok: false, error: 'Общий разбор пока недоступен.' };
    var cab = cabinet_(d);
    if (cab.modules < OVERALL_MIN) return { ok: false, error: 'Общий разбор появится, когда вы вдвоём пройдёте хотя бы ' + OVERALL_MIN + ' модуля.' };
    if (cab.overall.pending) return { ok: true, queued: true };
    if (cab.overall.modules >= cab.modules) return { ok: false, error: 'Общий разбор уже учитывает всё, что вы прошли. Пройдите новую тему — и его можно будет обновить.' };
    rateLimit_('ov:' + row.data.id, 5);
    ensureQuota_(2);
    enqueue_('overall', row.data.id, '');
    return { ok: true, queued: true };
  });
}
function overallView_(d) {
  var row = findPair_(d.id), me = roleOf_(row, d.t);
  if (!me) return { ok: false, error: 'not_found' };
  var last = lastOverall_(row.data.id);
  if (!last) return { ok: false, error: 'not_ready' };
  loadShared_();
  return { ok: true, html: CQT.overallHtml(last.text, person_(row.data, 'A'), person_(row.data, 'B'), fmtDate_(last.created)) };
}
// Участники для общего разбора: портрет и все темы, которые прошли оба.
function overallPeople_(row) {
  var P = row.data, PA = person_(P, 'A'), PB = person_(P, 'B');
  PA.topics = {}; PB.topics = {};
  PA.portrait = P.completed && P.answersA ? JSON.parse(P.answersA) : null;
  PB.portrait = P.completed && P.answersB ? JSON.parse(P.answersB) : null;
  latestTalks_(findTalks_(P.id)).forEach(function (s) {
    if (!s.data.completed || !CQT.topic(s.data.topic)) return;
    PA.topics[s.data.topic] = JSON.parse(s.data.answersA);
    PB.topics[s.data.topic] = JSON.parse(s.data.answersB);
  });
  return [PA, PB];
}
function lastOverall_(pairId) {
  var sh = sheet_('overall', OVERALL_COLS);
  var cells = sh.getRange('A:A').createTextFinder(String(pairId)).matchEntireCell(true).findAll();
  return cells.length ? rowObj_(sh, OVERALL_COLS, cells[cells.length - 1].getRow()).data : null;
}

// ───────────────────────── фоновые задачи (Claude)

function aiOn_() { return !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'); }

function enqueue_(kind, pair, talk) {
  sheet_('jobs', JOB_COLS).appendRow(['j' + token_(9), new Date(), kind, pair, talk, 'new', 0, new Date(), '']);
  ensureTrigger_();
}
function hasJob_(pair, kind) {
  var sh = sheet_('jobs', JOB_COLS), vals = sh.getDataRange().getValues();
  return vals.slice(1).some(function (r) { return r[3] === pair && r[2] === kind && /^(new|retry|running)$/.test(r[5]); });
}
function ensureTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runJobs'; });
  if (!has) ScriptApp.newTrigger('runJobs').timeBased().after(15 * 1000).create();
}

// Запускается по таймеру. Берёт задачи по одной; Claude вызывается без блокировки таблицы.
function runJobs() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runJobs') ScriptApp.deleteTrigger(t); });
  loadShared_();
  var started = Date.now(), left = false;
  while (Date.now() - started < 4 * 60 * 1000) {
    var job = claimJob_();
    if (!job) break;
    if (job === 'wait') { left = true; break; }
    try {
      runJob_(job.data);
      job.set({ status: 'done', updated: new Date(), error: '' });
    } catch (err) {
      console.error('Задача ' + job.data.id + ': ' + (err && err.stack || err));
      var failed = Number(job.data.attempts) >= 3;
      job.set({ status: failed ? 'failed' : 'retry', updated: new Date(), error: String(err && err.message || err).slice(0, 300) });
      if (failed) { try { giveUp_(job.data); } catch (e2) { console.error(e2); } }
    }
  }
  if (left || claimJob_(true)) ensureTrigger_();
}
// Следующая задача: новая, на повторе (через минуту после ошибки) или зависшая «running».
// peek = true — только проверить, есть ли ещё работа.
function claimJob_(peek) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_('jobs', JOB_COLS), vals = sh.getDataRange().getValues(), now = Date.now(), wait = false;
    for (var i = 1; i < vals.length; i++) {
      var st = vals[i][5], upd = new Date(vals[i][7]).getTime() || 0;
      var ready = st === 'new' || (st === 'retry' && now - upd > 60 * 1000) || (st === 'running' && now - upd > 10 * 60 * 1000);
      if (st === 'retry' && !ready) wait = true;
      if (!ready) continue;
      if (peek) return true;
      var job = rowObj_(sh, JOB_COLS, i + 1);
      job.set({ status: 'running', attempts: Number(job.data.attempts || 0) + 1, updated: new Date() });
      return job;
    }
    return peek ? wait : wait ? 'wait' : null;
  } finally {
    lock.releaseLock();
  }
}
function runJob_(j) {
  var row = findPair_(j.pair);
  if (!row) return;
  if (j.kind === 'portrait') {
    var rep = CQA.report(personWith_(row.data, 'A'), personWith_(row.data, 'B'), { ctx: ctx_(row.data) });
    var narrative = claudeCall_(rep.text, PORTRAIT_PROMPT);
    row.set({ claude: narrative });
    sendPortraitMails_(row, withNarrative_(rep.html, narrative, 'Общий взгляд на вашу пару'));
  } else if (j.kind === 'talk') {
    var talks = findTalks_(j.pair), s = talks.filter(function (x) { return x.data.id === j.talk; })[0];
    if (!s) return;
    var r = buildTalk_(row, talks, s), narr = claudeCall_(r.text, TOPIC_PROMPT);
    s.set({ claude: narr });
    sendTalkMails_(row, s, r, withNarrative_(r.html, narr, 'Взгляд психолога на этот разговор'));
  } else if (j.kind === 'overall') {
    var ppl = overallPeople_(row), inp = CQT.overallInput(ppl[0], ppl[1], ctx_(row.data));
    var text = claudeCall_(inp.text, OVERALL_PROMPT);
    if (!text) throw new Error('Claude не вернул текст общего разбора');
    var at = new Date();
    sheet_('overall', OVERALL_COLS).appendRow([j.pair, at, inp.mods.length, text]);
    var P = row.data, html = CQT.overallHtml(text, ppl[0], ppl[1], fmtDate_(at));
    send_(P.emailA, CQT.mail.overall(ppl[0], ppl[1], html, cabLink_(P.id, P.tokenA) + '&go=overall', P.nameA));
    send_(P.emailB, CQT.mail.overall(ppl[0], ppl[1], html, cabLink_(P.id, P.tokenB) + '&go=overall', P.nameB));
  }
}
// Claude так и не ответил: письма о модуле всё равно отправляем — без его раздела.
function giveUp_(j) {
  var row = findPair_(j.pair);
  if (!row) return;
  if (j.kind === 'portrait') sendPortraitMails_(row, CQA.report(personWith_(row.data, 'A'), personWith_(row.data, 'B'), { ctx: ctx_(row.data) }).html);
  if (j.kind === 'talk') {
    var talks = findTalks_(j.pair), s = talks.filter(function (x) { return x.data.id === j.talk; })[0];
    if (s) { var r = buildTalk_(row, talks, s); sendTalkMails_(row, s, r, r.html); }
  }
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
  var X = { name: P.nameA, email: P.emailA, gender: P.genderA || '', a: a.a, g: a.g || {}, note: a.note || '', all: allA };
  var Y = { name: P.nameB, email: P.emailB, gender: P.genderB || '', a: b.a, g: b.g || {}, note: b.note || '', all: allB };
  var r = CQT.report(topic.id, X, Y, { mods: mods, ctx: ctx_(P) });
  r.X = X; r.Y = Y;
  return r;
}
function talkHtml_(row, talks, s) {
  return withNarrative_(buildTalk_(row, talks, s).html, s.data.claude, 'Взгляд психолога на этот разговор');
}
function portraitHtml_(row) {
  return withNarrative_(CQA.report(personWith_(row.data, 'A'), personWith_(row.data, 'B'), { ctx: ctx_(row.data) }).html, row.data.claude, 'Общий взгляд на вашу пару');
}
function ctx_(P) { return CQA.parseContext(P.context); }
function json_(v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function person_(P, L) { return { name: P['name' + L], email: P['email' + L], gender: P['gender' + L] || '' }; }
function personWith_(P, L) { var x = person_(P, L); x.answers = P['answers' + L] ? JSON.parse(P['answers' + L]) : {}; return x; }

// Партнёр открыл ссылку-приглашение.
function invite_(d) {
  var row = findPair_(d.id);
  // Пары, начатые с темы, приглашают партнёра в кабинет, а не по этой ссылке.
  if (!row || d.t !== row.data.tokenB || !row.data.answersA) return { ok: false, error: 'not_found' };
  return { ok: true, nameA: row.data.nameA, nameB: row.data.nameB, emailB: row.data.emailB, genderB: row.data.genderB || '', context: json_(row.data.context), completed: !!row.data.completed };
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
    var set = { nameB: nameB, emailB: emailB, answersB: JSON.stringify(answersB) };
    var gB = cleanGender_(d.genderB);
    if (gB) set.genderB = gB;
    var ctx = !row.data.context && CQA.cleanContext(d.context);
    if (ctx) set.context = JSON.stringify(ctx);
    row.set(set);
    return finishPortrait_(row);
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
  'Обращайся к паре на «вы», партнёров называй по именам. Если у имени указано «он» или «она», пиши об этом человеке в соответствующем роде; если не указано — не используй местоимения и глагольные формы, выдающие пол.',
  'Опирайся на конкретные сочетания ответов. Не пересказывай найденные динамики — добавь то, что видно из их сочетания: как различия могут усиливать друг друга и где у пары ресурс.',
  'Не ставь диагнозов и не давай оценок «совместимы / несовместимы». Последний абзац — одна-две практические идеи на ближайшую неделю.'
].join(' ');

var TOPIC_PROMPT = [
  'Ты — опытный семейный психолог. Пара, которая давно вместе и разучилась разговаривать, прошла одну тему для разговора.',
  'Каждый ответил на вопросы сам и на часть вопросов попробовал угадать ответ партнёра. Тебе дают их ответы, догадки, связи с портретом пары и прошлыми темами, оси и ответы из ранее пройденных модулей.',
  'Напиши для пары тёплый разбор на русском языке: 3–4 абзаца простым текстом, без markdown, списков и заголовков.',
  'Обращайся к паре на «вы», партнёров называй по именам. Если у имени указано «он» или «она», пиши об этом человеке в соответствующем роде; если не указано — не используй местоимения и глагольные формы, выдающие пол.',
  'Главное — помочь им начать разговор, а не оценить их. Свяжи ответы этой темы с тем, что уже известно из портрета и прошлых тем: какие сквозные мотивы видны у каждого, откуда может расти поведение, которое мешает паре.',
  'Отдельно отметь, где догадки не совпали с ответами: это места, где представления друг о друге устарели, — подай это с любопытством, без упрёка.',
  'Не пересказывай ответы списком и не ставь диагнозов. Если видишь признаки серьёзной боли, мягко упомяни, что с этим может помочь семейный психолог.',
  'Закончи одним открытым вопросом, с которого паре стоит начать разговор сегодня вечером.'
].join(' ');

var OVERALL_PROMPT = [
  'Ты — опытный семейный психолог. Пара прошла несколько модулей: портрет пары и темы для разговора.',
  'Тебе дают все их ответы, догадки друг о друге, найденные автоматически динамики и связи, а также оси.',
  'Напиши общий разбор на русском языке: 8–12 абзацев. Можно короткие подзаголовки — каждый отдельной строкой, без точки в конце. Никакой разметки: без #, *, списков и нумерации.',
  'Структура: что держит пару (опоры) → сквозная линия каждого партнёра (откуда растёт и в чём проявляется в разных темах) → как вы встречаетесь и где промахиваетесь (с опорой на догадки) → две-три темы, которые пока не проговорены → три конкретных шага и один вопрос, с которого начать сегодня.',
  'Обращайся к паре на «вы», партнёров называй по именам. Если у имени указано «он» или «она», пиши об этом человеке в соответствующем роде; если не указано — не используй местоимения и глагольные формы, выдающие пол.',
  'Опирайся на ответы, не делай выводов о вине и не ставь диагнозов. Если видишь признаки серьёзной боли, мягко предложи обратиться к семейному психологу.'
].join(' ');

// Без ключа — пустая строка. При ошибке API бросает исключение (фоновая задача повторит запрос),
// при отказе модели возвращает пустую строку — тогда письма уходят без раздела от Claude.
function claudeCall_(text, system) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) return '';
  var body = {
    model: props.getProperty('CLAUDE_MODEL') || 'claude-opus-5-5',
    max_tokens: 16000,
    // Низкое усилие: разборы — не сложная задача, а ответ должен уложиться в тайм-аут UrlFetchApp.
    output_config: { effort: 'low' },
    // Если запрос отклонят классификаторы, API сам повторит его на рекомендованной модели.
    fallbacks: 'default',
    system: system || PORTRAIT_PROMPT,
    messages: [{ role: 'user', content: text }]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(body)
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  var j = JSON.parse(res.getContentText());
  if (j.stop_reason === 'refusal') return '';
  return (j.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n\n').trim();
}
// Для ручных проверок: ошибки не бросает.
function claudeNarrative_(text, system) {
  try { return claudeCall_(text, system); } catch (err) { console.error(err); return ''; }
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
  } else if (!SHEET_OK[name]) {
    // В старой таблице может не быть новых колонок (например, genderA/genderB) — дописываем заголовок.
    var have = sh.getLastColumn();
    if (have < cols.length) sh.getRange(1, have + 1, 1, cols.length - have).setValues([cols.slice(have)]).setFontWeight('bold');
  }
  SHEET_OK[name] = true;
  return sh;
}
var SHEET_OK = {};

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
function cleanGender_(g) { return /^(m|f|n)$/.test(String(g || '')) ? String(g) : ''; }
function fmtDate_(d) { return d ? Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'dd.MM.yyyy') : ''; }
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
  sheet_('jobs', JOB_COLS);
  sheet_('overall', OVERALL_COLS);
  ScriptApp.getProjectTriggers(); // запросит разрешение на таймеры для фоновых задач
  loadShared_();
  console.log('Готово. Вопросов портрета: ' + CQ_DATA.questions.length + ', тем: ' + CQT.topics.length + '. Писем осталось на сегодня: ' + MailApp.getRemainingDailyQuota());
}

// Отправляет себе пример разбора по случайным ответам — чтобы посмотреть, как выглядит письмо.
function sendTestReport() {
  loadShared_();
  var me = Session.getActiveUser().getEmail();
  var A = { name: 'Аня', gender: 'f', email: me, answers: rndAnswers_(CQ_DATA.questions) }, B = { name: 'Макс', gender: 'm', email: me, answers: rndAnswers_(CQ_DATA.questions) };
  var rep = CQA.report(A, B);
  var html = withNarrative_(rep.html, claudeNarrative_(rep.text, PORTRAIT_PROMPT), 'Общий взгляд на вашу пару');
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
    return { name: name, gender: name === 'Аня' ? 'f' : 'm', email: me, a: a, g: g, note: '', all: all };
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
