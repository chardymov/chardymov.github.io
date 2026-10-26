(function () {
  'use strict';

  var D = CQ_DATA, QS = D.questions;
  var BBY = {};
  D.blocks.forEach(function (b) { BBY[b.id] = b; });
  var app = document.getElementById('app');
  var esc = CQA.esc;
  var DEMO = !CONFIG.API_URL;
  var params = new URLSearchParams(location.search);

  // ───────────────────────── Telegram Mini App
  // Сайт открыт внутри Telegram: при запуске в адресе есть #tgWebAppData=… (подписанные данные
  // пользователя), при переходах внутри — сохранённая копия в sessionStorage. Подпись проверяет сервер.
  var sess = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  var TG = null; // { app: Telegram.WebApp | null, init, user, sp }
  var tgHash = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData');
  if (tgHash) sess.set('cq_tg_init', tgHash);
  function tgInit() {
    var w = window.Telegram && window.Telegram.WebApp;
    var init = (w && w.initData) || sess.get('cq_tg_init');
    if (!init) return;
    var q = new URLSearchParams(init), user = {};
    try { user = JSON.parse(q.get('user')) || {}; } catch (e) { /* ignore */ }
    TG = { app: w || null, init: init, user: user, sp: q.get('start_param') || '' };
    document.documentElement.classList.add('in-tg');
    if (w) { try { w.ready(); w.expand(); } catch (e) { /* старый клиент */ } }
    // Имя из Telegram — подсказка в формах.
    var c = store.get('cq_contact') || {};
    if (!c.nameSelf && user.first_name) store.set('cq_contact', Object.assign(c, { nameSelf: String(user.first_name).slice(0, 40) }));
    // Ссылки t.me открываем средствами Telegram, ссылки «в браузере» — во внешнем браузере.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || !TG.app) return;
      var href = a.getAttribute('href');
      if (/^https:\/\/t\.me\//.test(href)) { e.preventDefault(); TG.app.openTelegramLink(href); }
      else if (a.hasAttribute('data-ext')) { e.preventDefault(); TG.app.openLink(a.href); }
    });
  }

  // ───────────────────────── хранилище (может быть недоступно — тогда просто без сохранения)
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ───────────────────────── состояние
  var S = {
    role: 'A',          // A — заполняет первым, B — по приглашению; в кабинете — кто открыл
    ctx: 'new',         // портрет: new — с главной, invite — по старой ссылке-приглашению, cabinet — из кабинета
    pairId: null, token: null,
    invite: null,       // { nameA, nameB, emailB }
    cab: null,          // ответ cabinet: { me, nameMe, namePartner, portrait, topics, context }
    pc: null,           // контекст пары (установочные вопросы): { rel, live, dur, kids }
    answers: {}, idx: 0, skipSex: false
  };
  function progressKey() { return 'cq_progress_' + (S.ctx === 'cabinet' ? S.token : S.pairId || 'new'); }
  function saveProgress() { store.set(progressKey(), { answers: S.answers, idx: S.idx, skipSex: S.skipSex }); }
  function cabHref(extra) { return '?c=' + encodeURIComponent(S.pairId) + '&t=' + encodeURIComponent(S.token) + (extra || ''); }

  // ───────────────────────── аналитика воронки
  var utm = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref'].forEach(function (k) { if (params.get(k)) utm[k] = params.get(k); });
  if (Object.keys(utm).length) store.set('cq_utm', utm); else utm = store.get('cq_utm') || {};
  var sid = store.get('cq_sid') || Math.random().toString(36).slice(2, 10);
  store.set('cq_sid', sid);
  function track(name, extra) {
    var ev = { action: 'event', name: name, sid: sid, role: S.role, pair: S.pairId || '', utm: utm, extra: extra || {} };
    if (DEMO) { console.log('[event]', name, extra || ''); return; }
    try { fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify(ev), keepalive: true }).catch(function () {}); } catch (e) { /* ignore */ }
  }

  // ───────────────────────── API
  // Google Apps Script иногда отвечает не JSON (пустой ответ или служебная страница) —
  // такие ответы и сетевые сбои повторяем. Повтор безопасен: create, start и answer защищены
  // ключом rid, а повторный complete вернёт already_completed.
  var RETRIES = 3;
  var NO_REPLY = 'Сервер не ответил. Попробуйте, пожалуйста, ещё раз через минуту.';
  function api(action, data, attempt) {
    attempt = attempt || 0;
    data = Object.assign({ action: action }, data);
    if (TG && !data.tg) data.tg = TG.init;
    if (DEMO) return Demo.call(data);
    function retry(why) {
      console.warn('[api] ' + action + ': ' + why);
      if (attempt >= RETRIES) throw new Error(NO_REPLY);
      return new Promise(function (res) { setTimeout(res, 2000 * (attempt + 1)); })
        .then(function () { return api(action, data, attempt + 1); });
    }
    return fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify(data) })
      .then(function (r) { return r.text(); }, function (e) { return { netError: e }; })
      .then(function (txt) {
        if (txt && txt.netError) return retry('network ' + txt.netError.message);
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { /* не JSON */ }
        if (!j || typeof j.ok !== 'boolean' || j.error === 'retry') return retry('non-JSON reply: ' + String(txt).slice(0, 120));
        if (!j.ok) throw new Error(j.error || 'Что-то пошло не так');
        return j;
      });
  }
  function rid() { return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 16); }

  // ───────────────────────── рендер-помощники
  function render(html) {
    app.innerHTML = '<div class="fade">' + html + '</div>';
    window.scrollTo(0, 0);
  }
  function $(sel) { return app.querySelector(sel); }
  function on(sel, ev, fn) { var el = $(sel); if (el) el.addEventListener(ev, fn); }
  function spinner(text) { render('<div class="center"><div class="spinner"></div><p class="sub">' + esc(text) + '</p></div>'); }
  function errorScreen(msg, back) {
    render('<div class="panel center"><h2>Не получилось</h2><p>' + esc(msg) + '</p><a class="btn ghost" href="' + (back || './') + '">' + (back ? 'Вернуться' : 'На главную') + '</a></div>');
  }
  function progressBar(pct) {
    return '<div class="progress" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><div style="width:' + pct + '%"></div></div>';
  }
  var LETTER = { a: 'А', b: 'Б', c: 'В', d: 'Г', e: 'Д', f: 'Е', g: 'Ж' };
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function arr(v) { return CQA.arr(v); }

  // Экран вопроса — общий для портрета и тем.
  // o: { head, pct, kicker, text, q, sel, notice, guess, onBack, onSkip, onDone(keys) }
  function questionScreen(o) {
    var q = o.q, max = CQT.maxPick(q), sel = arr(o.sel).slice(), locked = false;
    var opts = Object.keys(q.options).map(function (k) {
      var on_ = sel.indexOf(k) >= 0;
      return '<button class="opt' + (on_ ? ' sel' : '') + '" data-k="' + k + '" aria-pressed="' + on_ + '"><span class="k">' + LETTER[k] + '</span><span>' + esc(q.options[k]) + '</span></button>';
    }).join('');
    var right = (o.onSkip ? '<button class="link" id="skip">Пропустить</button>' : '') +
      (max > 1 ? '<button class="btn small" id="next"' + (sel.length ? '' : ' disabled') + '>Далее</button>'
        : sel.length ? '<button class="link" id="next">Далее →</button>' : '');
    render(
      o.head + progressBar(o.pct) +
      (o.notice ? '<p class="error">' + esc(o.notice) + '</p>' : '') +
      '<div class="' + (o.guess ? 'guess-box' : '') + '">' +
        (o.kicker ? '<p class="kicker">' + o.kicker + '</p>' : '') +
        '<p class="q-text">' + esc(o.text) + '</p>' +
        (max > 1 ? '<p class="hint">Можно выбрать до ' + max + ' вариантов</p>' : '') +
        '<div class="opts">' + opts + '</div>' +
      '</div>' +
      '<div class="quiz-nav">' + (o.onBack ? '<button class="link" id="back">← Назад</button>' : '<span></span>') +
      '<span class="nav-right">' + right + '</span></div>'
    );
    function paint() {
      app.querySelectorAll('.opt').forEach(function (b) {
        var k = b.getAttribute('data-k'), s = sel.indexOf(k) >= 0;
        b.classList.toggle('sel', s);
        b.setAttribute('aria-pressed', String(s));
      });
      var n = $('#next');
      if (n && max > 1) n.disabled = !sel.length;
    }
    app.querySelectorAll('.opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-k');
        if (max === 1) {
          // Повторный клик до перехода (двойной тап) не должен перескакивать следующий вопрос.
          if (locked) return;
          locked = true;
          sel = [k]; paint();
          setTimeout(function () { o.onDone(sel); }, 220);
          return;
        }
        var i = sel.indexOf(k);
        if (i >= 0) sel.splice(i, 1);
        else { sel.push(k); if (sel.length > max) sel.shift(); }
        paint();
      });
    });
    on('#next', 'click', function () { if (sel.length) o.onDone(sel); });
    on('#back', 'click', function () { o.onBack(); });
    on('#skip', 'click', function () { o.onSkip(); });
  }
  function store1(q, keys) { return CQT.cleanKeys(q, keys); }

  // ───────────────────────── установочные вопросы о паре
  // o: { initial, onDone(ctx), onBack }
  function contextScreen(o) {
    var init = o.initial || {};
    render(
      (o.onBack ? '<p class="crumbs"><button class="link" id="ctx-back">← Назад</button></p>' : '') +
      '<form class="panel ctx" id="ctx" novalidate>' +
        '<p class="eyebrow">Перед началом</p><h2>О вашей паре</h2>' +
        '<p class="sub">Четыре коротких вопроса. По ним мы подстроим вопросы под вашу ситуацию — например, не будем спрашивать о совместном быте, если вы живёте отдельно. Ответ один на пару; его можно поменять в кабинете.</p>' +
        D.context.map(function (q) {
          var cur = CQA.arr(init[q.id]);
          return '<fieldset class="field seg"><legend>' + esc(q.title) + (q.hint ? ' <small>· ' + esc(q.hint) + '</small>' : '') + '</legend><div class="seg-row">' +
            Object.keys(q.options).map(function (k) {
              return '<label><input type="' + (q.multi ? 'checkbox' : 'radio') + '" name="' + q.id + '" value="' + k + '"' + (cur.indexOf(k) >= 0 ? ' checked' : '') + '><span>' + esc(q.options[k]) + '</span></label>';
            }).join('') + '</div></fieldset>';
        }).join('') +
        '<p class="error" id="err" hidden></p>' +
        '<button class="btn block" type="submit">Дальше</button>' +
      '</form>'
    );
    // «нет детей» исключает остальные варианты
    app.querySelectorAll('input[name=kids]').forEach(function (b) {
      b.addEventListener('change', function () {
        if (!b.checked) return;
        app.querySelectorAll('input[name=kids]').forEach(function (x) { if (x !== b && (b.value === 'none' || x.value === 'none')) x.checked = false; });
      });
    });
    on('#ctx-back', 'click', function () { o.onBack(); });
    on('#ctx', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, c = {};
      D.context.forEach(function (q) {
        var vals = [].slice.call(f.querySelectorAll('input[name="' + q.id + '"]:checked')).map(function (x) { return x.value; });
        c[q.id] = q.multi ? vals : vals[0];
      });
      var clean = CQA.cleanContext(c);
      if (!clean) { var err = $('#err'); err.textContent = 'Ответьте, пожалуйста, на все четыре вопроса.'; err.hidden = false; return; }
      track('context_set', clean);
      o.onDone(clean);
    });
  }
  // Сохраняет контекст пары на сервере (из кабинета) и продолжает.
  function saveContext(c, next) {
    spinner('Сохраняем…');
    api('context', { id: S.pairId, t: S.token, context: c })
      .then(function () { S.cab.context = c; S.pc = c; next(); })
      .catch(function (e) { errorScreen(e.message, cabHref()); });
  }
  // Контекст есть — сразу дальше; нет — спрашиваем (в кабинете — и сохраняем).
  function withContext(next, back) {
    if (S.pc) return next(S.pc);
    if (S.ctx === 'new') { var saved = store.get('cq_pc_new'); if (saved && CQA.cleanContext(saved)) { S.pc = saved; return next(S.pc); } }
    contextScreen({
      onBack: back,
      onDone: function (c) {
        if (S.ctx === 'cabinet') return saveContext(c, function () { next(c); });
        S.pc = c;
        if (S.ctx === 'new') store.set('cq_pc_new', c);
        next(c);
      }
    });
  }
  function contextLine(c) {
    if (!c) return '';
    return D.context.map(function (q) { return CQA.arr(c[q.id]).map(function (k) { return q.options[k]; }).join(', '); }).join(' · ');
  }

  // ───────────────────────── главная
  function landing() {
    track('view_landing');
    var cab = store.get('cq_cab');
    render(
      '<section class="hero">' +
        '<p class="eyebrow">Для пар' + (DEMO ? '<span class="demo-badge">демо-режим</span>' : '') + '</p>' +
        '<h1>Поговорите друг с другом — по-настоящему</h1>' +
        '<p class="lead">Каждый отвечает на вопросы сам, а потом вы оба получаете разбор: что вас объединяет, где вы видите вещи по-разному и с чего начать разговор.</p>' +
      '</section>' +
      (utm.ref && !(cab && cab.id) ? '<div class="banner"><span><b>Вам рекомендовали «Мы вдвоём»</b>Выберите тему на сегодня или пройдите портрет пары — это бесплатно.</span></div>' : '') +
      (cab && cab.id ? '<a class="banner" href="?c=' + encodeURIComponent(cab.id) + '&t=' + encodeURIComponent(cab.t) + '"><span><b>Кабинет пары</b>' +
        (cab.me ? esc(cab.me) + ' и ' + esc(cab.partner) : 'ваши темы и разборы') + '</span><span class="arrow">→</span></a>' : '') +
      (TG ? '<button class="banner" type="button" id="tg-find"><span><b>Уже проходили на сайте?</b>Найти мои пары по почте</span><span class="arrow">→</span></button>' : '') +
      '<div class="sections">' +
        '<section class="section-card">' +
          '<p class="eyebrow">Раздел 1</p><h2>Портрет пары</h2>' +
          '<p>' + QS.length + ' вопроса об общении, конфликтах, быте, деньгах, близости и будущем. Психологические портреты, ваши опоры, зоны договорённостей и рекомендации.</p>' +
          startCta('Пройти портрет', '≈ 10 минут · бесплатно') +
        '</section>' +
        '<section class="section-card">' +
          '<p class="eyebrow">Раздел 2</p><h2>Разговоры</h2>' +
          '<p>Темы для пар, которые давно вместе и хотят снова слышать друг друга. Выбираете одну тему на сегодня, отвечаете и угадываете ответы партнёра — и получаете план разговора на вечер.</p>' +
          '<a class="btn ghost" href="#topics">Выбрать тему</a>' +
        '</section>' +
      '</div>' +
      '<ol class="steps">' +
        '<li><b>Вы отвечаете</b><span>Можно отметить до двух вариантов. В темах — ещё и угадать, что ответит партнёр.</span></li>' +
        '<li><b>Партнёр получает ссылку</b><span>' + (TG ? 'Отправляете её партнёру в Telegram — он отвечает у себя.' : 'Указываете email — свой и партнёра. Партнёр отвечает со своего телефона.') + '</span></li>' +
        '<li><b>Разбор приходит обоим</b><span>Каждый новый разбор учитывает портрет и все темы, которые вы уже прошли.</span></li>' +
      '</ol>' +
      '<h2 id="topics">Темы для разговора</h2>' +
      topicGrid(null) +
      '<p class="note">Ваши ответы попадут только в разбор, который получите вы и ваш партнёр. Ответы партнёра вы увидите, только когда ответите оба.</p>'
    );
    bindStart();
    on('#tg-find', 'click', tgFind);
    bindTopicGrid(function (id) {
      if (cab && cab.id) { location.href = '?c=' + encodeURIComponent(cab.id) + '&t=' + encodeURIComponent(cab.t) + '&topic=' + id; return; }
      S.ctx = 'new';
      topicIntro(id);
    });
  }

  // Карточки тем; status — темы из кабинета (или null на главной)
  function topicGrid(status) {
    var live = CQT.topics.map(function (t) {
      var st = status && status[t.id] || {}, chip = '', label = 'Выбрать';
      if (status) {
        var again = st.was ? 'Повтор · ' : '';
        if (st.done) { chip = '<span class="chip good">Разбор готов</span>'; label = 'Открыть разбор'; }
        else if (st.me) { chip = '<span class="chip wait">' + again + 'Ждём ответа: ' + esc(S.cab ? S.cab.namePartner : 'партнёр') + '</span>'; label = 'Подробнее'; }
        else if (st.partner) { chip = '<span class="chip accent">' + again + 'Ваша очередь</span>'; label = 'Ответить'; }
        else label = 'Начать';
      }
      // Пройденную тему можно пройти снова; во время повтора прошлый разбор остаётся доступен.
      var extra = st.done ? '<button class="btn small again" data-retake="' + t.id + '">Пройти снова</button>'
        : st.was ? '<button class="btn small ghost" data-prev="' + t.id + '">Прошлый разбор</button>' : '';
      return '<div class="topic-card' + (st.partner && !st.me && !st.done ? ' hot' : st.me && !st.done ? ' waiting' : '') + '"><div class="topic-top"><h3>' + esc(t.title) + '</h3>' + chip + '</div>' +
        '<p>' + esc(t.lead) + '</p><div class="topic-foot"><small>' + t.questions.length + ' вопросов · ≈ ' + t.minutes + ' мин' + (t.adult ? ' · 18+' : t.deep ? ' · глубокая' : '') + '</small>' +
        '<span class="btns">' + extra + '<button class="btn small' + (st.done || st.me ? ' ghost' : '') + '" data-topic="' + t.id + '">' + label + '</button></span></div></div>';
    }).join('');
    var votes = store.get('cq_votes') || {};
    var soon = CQT.soon.map(function (t) {
      return '<div class="topic-card soon"><div class="topic-top"><h3>' + esc(t.title) + '</h3><span class="chip">скоро</span></div><p>' + esc(t.lead) + '</p>' +
        '<div class="topic-foot"><small>' + (votes[t.id] ? 'Спасибо! Учтём ваш голос' : 'Хотите эту тему раньше?') + '</small>' +
        (votes[t.id] ? '' : '<button class="btn small ghost" data-vote="' + t.id + '">Хочу эту тему</button>') + '</div></div>';
    }).join('');
    return '<div class="topic-grid">' + live + '</div>' + (soon ? '<h3 class="soon-h">Скоро</h3><div class="topic-grid">' + soon + '</div>' : '');
  }
  function bindTopicGrid(open) {
    app.querySelectorAll('[data-retake]').forEach(function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-retake'); track('topic_retake', { topic: id }); S.retake = id; topicIntro(id); });
    });
    app.querySelectorAll('[data-prev]').forEach(function (b) {
      b.addEventListener('click', function () { openPrev(b.getAttribute('data-prev')); });
    });
    app.querySelectorAll('[data-topic]').forEach(function (b) {
      b.addEventListener('click', function () { track('topic_pick', { topic: b.getAttribute('data-topic') }); open(b.getAttribute('data-topic')); });
    });
    app.querySelectorAll('[data-vote]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-vote'), votes = store.get('cq_votes') || {};
        votes[id] = 1; store.set('cq_votes', votes);
        track('vote_topic', { topic: id });
        var foot = b.parentNode;
        foot.querySelector('small').textContent = 'Спасибо! Учтём ваш голос';
        b.remove();
      });
    });
  }

  // ───────────────────────── портрет пары
  function inviteLanding() {
    spinner('Загружаем приглашение…');
    api('invite', { id: S.pairId, t: S.token }).then(function (r) {
      S.invite = r;
      S.pc = CQA.parseContext(r.context);
      track('invite_open');
      if (r.completed) {
        render('<div class="panel center"><div class="okmark">✓</div><h2>Вы уже ответили</h2><p>Разбор отправлен вам обоим на почту.</p>' +
          '<a class="btn" href="?r=' + encodeURIComponent(S.pairId) + '&t=' + encodeURIComponent(S.token) + '">Открыть разбор</a></div>');
        return;
      }
      render(
        '<section class="hero">' +
          '<p class="eyebrow">Приглашение' + (DEMO ? '<span class="demo-badge">демо-режим</span>' : '') + '</p>' +
          '<h1>' + esc(r.nameA) + ' приглашает вас пройти тест для пар</h1>' +
          '<p class="lead">' + esc(r.nameA) + ' уже ответил(а) на ' + QS.length + ' вопроса о ваших отношениях. Ответьте и вы — и вы оба сразу получите разбор пары на почту.</p>' +
          startCta('Начать', '≈ 10 минут') +
        '</section>' +
        '<p class="note">Отвечайте самостоятельно и честно — так разбор будет точнее. На некоторые вопросы можно выбрать до двух вариантов. Ответы ' + esc(r.nameA) + ' вы увидите только в итоговом разборе.</p>'
      );
      bindStart();
    }).catch(function (e) { errorScreen(e.message === 'not_found' ? 'Приглашение не найдено. Проверьте ссылку из письма.' : e.message); });
  }

  // Портрет из кабинета пары
  function portraitIntro() {
    var c = S.cab, again = S.retake === 'portrait' || c.portrait.was;
    render(
      '<p class="crumbs"><a href="' + cabHref() + '">← Кабинет пары</a></p>' +
      '<section class="hero">' +
        '<p class="eyebrow">Портрет пары' + (again ? ' · ещё раз' : '') + '</p>' +
        '<h1>' + QS.length + ' вопроса о вашей паре</h1>' +
        (again ? '<p class="note accent-note">Вы проходите портрет снова. Отвечайте, как чувствуете сейчас, — новый разбор покажет, что изменилось' + (c.portrait.was ? ' с ' + esc(c.portrait.was) : '') + ', а прошлый сохранится.</p>' : '') +
        '<p class="lead">' + (portraitPartnerIn() ? esc(c.namePartner) + ' уже ответил(а). Как только ответите вы, разбор придёт вам обоим.' :
          'Ответьте на вопросы — ' + esc(c.namePartner) + ' получит приглашение ответить со своей стороны, и разбор придёт вам обоим.') + '</p>' +
        startCta('Начать', '≈ 10 минут') +
      '</section>' +
      '<p class="note">Ответы портрета сделают точнее и разборы тем в разделе «Разговоры».</p>'
    );
    bindStart();
  }

  // Партнёр уже ответил в текущем прохождении портрета (после завершения текущего прохождения нет).
  function portraitPartnerIn() { var pt = S.cab && S.cab.portrait || {}; return !!pt.partner && !pt.done; }

  // Если в браузере остались ответы с прошлого раза — предлагаем продолжить или начать заново.
  function savedCount() {
    var saved = store.get(progressKey());
    return saved && saved.answers ? Object.keys(saved.answers).length : 0;
  }
  function startCta(label, note) {
    var n = savedCount();
    if (!n) return '<div class="cta"><button class="btn" id="go">' + label + '</button><small>' + note + '</small></div>';
    return '<div class="cta"><button class="btn" id="go">Продолжить</button><button class="btn ghost" id="restart">Начать заново</button>' +
      '<small>В этом браузере сохранены ответы: ' + n + ' из ' + QS.length + '</small></div>';
  }
  function bindStart() {
    on('#go', 'click', function () { track('start'); startQuiz(false); });
    on('#restart', 'click', function () { track('start', { restart: true }); startQuiz(true); });
  }

  function startQuiz(fresh) {
    if (!S.pc) return withContext(function () { startQuiz(fresh); }, S.ctx === 'cabinet' ? cabinetView : S.ctx === 'new' ? landing : null);
    if (fresh) {
      store.del(progressKey());
      S.answers = {}; S.idx = 0; S.skipSex = false; S.sexIntroSeen = false; S.fixing = false;
      return showQuestion();
    }
    var saved = store.get(progressKey());
    if (saved && saved.answers && Object.keys(saved.answers).length) {
      S.answers = saved.answers; S.idx = Math.min(saved.idx || 0, QS.length); S.skipSex = !!saved.skipSex;
    }
    showQuestion();
  }

  function showQuestion() {
    if (S.idx >= QS.length) return details();
    var q = QS[S.idx], bl = BBY[q.block];
    if (bl.optional && S.skipSex) { S.idx = QS.length; return details(); }
    var first = QS.findIndex(function (x) { return x.block === q.block; });
    if (bl.optional && S.idx === first && !S.sexIntroSeen) return sexIntro();

    var qi = S.idx, notice = S.notice, qa = CQA.adapt(q, S.pc) || q;
    S.notice = null;
    questionScreen({
      head: '<div class="quiz-head"><span><b>Блок ' + bl.n + '</b> · ' + esc(bl.title) + '</span><span>' + (qi + 1) + ' / ' + QS.length + '</span></div>',
      pct: Math.round(100 * qi / QS.length), text: qa.text, q: qa, sel: S.answers[q.id], notice: notice,
      onBack: qi > 0 ? goBack : null,
      onDone: function (keys) {
        S.answers[q.id] = store1(q, keys);
        // При дозаполнении пропусков — сразу к следующему пропуску (или к форме).
        S.idx = S.fixing ? QS.length : qi + 1;
        saveProgress();
        if (S.idx < QS.length && QS[S.idx].block !== q.block) track('block_done', { block: q.block });
        showQuestion();
      }
    });
  }

  function goBack() {
    S.fixing = false;
    S.idx = Math.max(0, S.idx - 1);
    var q = QS[S.idx];
    if (BBY[q.block].optional && S.skipSex) { S.skipSex = false; S.sexIntroSeen = false; S.idx = QS.findIndex(function (x) { return x.block === q.block; }); }
    saveProgress();
    showQuestion();
  }

  function sexIntro() {
    var bl = D.blocks.filter(function (b) { return b.optional; })[0];
    render(
      '<div class="quiz-head"><span><b>Блок ' + bl.n + '</b> · ' + esc(bl.title) + '</span><span>18+</span></div>' +
      progressBar(Math.round(100 * S.idx / QS.length)) +
      '<div class="panel stack"><h2>' + esc(bl.title) + '</h2><p>' + esc(bl.intro) + '</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px"><button class="btn" id="yes">Ответить на блок</button><button class="btn ghost" id="skip">Пропустить</button></div></div>' +
      '<div class="quiz-nav" style="margin-top:16px"><button class="link" id="back">← Назад</button><span></span></div>'
    );
    on('#yes', 'click', function () { S.sexIntroSeen = true; S.skipSex = false; showQuestion(); });
    on('#skip', 'click', function () {
      track('skip_sex');
      S.skipSex = true;
      QS.forEach(function (q) { if (BBY[q.block].optional) delete S.answers[q.id]; });
      S.idx = QS.length; saveProgress(); details();
    });
    on('#back', 'click', function () { goBack(); });
  }

  // Индекс первого вопроса без ответа (блок 7 не считается, если его пропустили).
  function firstMissing() {
    return QS.findIndex(function (q) { return !S.answers[q.id] && !(BBY[q.block].optional && S.skipSex); });
  }

  var CONSENT = '<label class="check"><input type="checkbox" name="consent"><span>Мне есть 18 лет. Я согласен(на), что мои ответы будут сохранены, обработаны (в том числе автоматически, с помощью ИИ) и включены в разбор, который получим я и мой партнёр.</span></label>';

  function details() {
    var miss = firstMissing();
    if (miss >= 0) {
      S.idx = miss;
      S.notice = 'Этот вопрос остался без ответа — выберите, пожалуйста, вариант.';
      S.fixing = true;
      return showQuestion();
    }
    S.fixing = false;
    track('view_details');
    var isB = S.ctx === 'invite', isCab = S.ctx === 'cabinet', inv = S.invite || {};
    var saved = store.get('cq_contact') || {};
    render(
      '<div class="quiz-head"><span><b>Почти готово</b></span><span>' + QS.length + ' / ' + QS.length + '</span></div>' +
      progressBar(100) +
      '<form class="panel" id="f" novalidate>' +
        (isCab
          ? '<h2>Отправить ответы?</h2><p class="sub">' + (portraitPartnerIn() ? 'Разбор придёт вам и ' + esc(S.cab.namePartner) + ' сразу после отправки.' : esc(S.cab.namePartner) + ' получит приглашение ответить, а разбор придёт вам обоим.') + '</p>' +
            (S.cab.genderMe ? '' : genderField('genderSelf', 'Как к вам обращаться в разборе', ''))
          : isB
            ? '<h2>Куда отправить разбор?</h2><p class="sub">Разбор придёт вам и ' + esc(inv.nameA) + ' сразу после отправки.</p>' +
              '<div class="grid2">' +
                field('nameSelf', 'Ваше имя', 'text', inv.nameB || '', 'given-name') +
                field('emailSelf', mailLabel('Ваш email'), 'email', inv.emailB || '', 'email') +
              '</div>' + genderField('genderSelf', 'Как к вам обращаться в разборе', inv.genderB || saved.genderSelf || '')
            : '<h2>' + (TG ? 'Кто вы двое?' : 'Кому отправить?') + '</h2><p class="sub">' + (TG ? TG_MAIL_NOTE : 'Вам придут ваши ответы, а партнёру — ссылка, чтобы ответить со своей стороны.') + '</p>' +
              '<div class="grid2">' +
                field('nameSelf', 'Ваше имя', 'text', saved.nameSelf || '', 'given-name') +
                field('emailSelf', mailLabel('Ваш email'), 'email', saved.emailSelf || '', 'email') +
                genderField('genderSelf', 'Как к вам обращаться', saved.genderSelf || '') +
                '<span class="grid-gap"></span>' +
                field('namePartner', 'Имя партнёра', 'text', '', 'off') +
                field('emailPartner', mailLabel('Email партнёра'), 'email', '', 'off') +
                genderField('genderPartner', 'Как обращаться к партнёру', '') +
              '</div>') +
        '<label class="hp" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label>' +
        CONSENT +
        '<p class="error" id="err" hidden></p>' +
        '<button class="btn block" type="submit">' + (isB || (isCab && portraitPartnerIn()) ? 'Получить разбор' : 'Отправить') + '</button>' +
        '<div class="quiz-nav" style="margin-top:8px"><button class="link" type="button" id="back">← Вернуться к вопросам</button><span></span></div>' +
      '</form>'
    );
    on('#back', 'click', function () { S.idx = QS.length; goBack(); });
    on('#f', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, v = function (n) { return (f.elements[n] && f.elements[n].value || '').trim(); };
      var err = $('#err');
      function fail(m) { err.textContent = m; err.hidden = false; }
      if (!isCab) {
        if (!v('nameSelf')) return fail('Укажите ваше имя.');
        if (!mailOk(v('emailSelf'))) return fail('Проверьте ваш email.');
      }
      if (!isB && !isCab) {
        if (!v('namePartner')) return fail('Укажите имя партнёра.');
        if (!mailOk(v('emailPartner'))) return fail('Проверьте email партнёра.');
        if (v('emailPartner') && v('emailPartner').toLowerCase() === v('emailSelf').toLowerCase()) return fail('Email партнёра должен отличаться от вашего.');
      }
      if (!f.elements.consent.checked) return fail('Подтвердите согласие, чтобы продолжить.');
      if (v('website')) return; // бот
      if (firstMissing() >= 0) return details();
      S.genderSelf = radio(f, 'genderSelf'); S.genderPartner = radio(f, 'genderPartner');
      if (isCab) return submitCabPortrait();
      store.set('cq_contact', { nameSelf: v('nameSelf'), emailSelf: v('emailSelf'), genderSelf: S.genderSelf });
      if (isB) submitB(v('nameSelf'), v('emailSelf'));
      else submitA(v('nameSelf'), v('emailSelf'), v('namePartner'), v('emailPartner'));
    });
  }
  // В Telegram почта необязательна: партнёра зовут ссылкой в чат, уведомления приходят от бота.
  var TG_MAIL_NOTE = 'Почта — по желанию: на неё придут разборы, и кабинет можно будет открыть с компьютера. Партнёра пригласите ссылкой в Telegram на следующем шаге.';
  function mailLabel(l) { return TG ? l + ' — по желанию' : l; }
  function mailOk(x) { return (TG && !x) || emailRe.test(x); }
  // Как обращаться: он / она / без разницы. Значения m / f / n.
  function genderField(name, label, val) {
    var opts = [['m', 'он'], ['f', 'она'], ['n', 'без разницы']];
    return '<fieldset class="field seg"><legend>' + label + '</legend><div class="seg-row">' + opts.map(function (o) {
      return '<label><input type="radio" name="' + name + '" value="' + o[0] + '"' + (val === o[0] ? ' checked' : '') + '><span>' + o[1] + '</span></label>';
    }).join('') + '</div></fieldset>';
  }
  function radio(f, name) { var el = f.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }
  function field(name, label, type, val, ac) {
    return '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + type + '" value="' + esc(val) + '" autocomplete="' + ac + '"' + (type === 'email' ? ' inputmode="email"' : '') + ' maxlength="80" required></label>';
  }
  function lostReply(email) {
    return 'Сервер не успел ответить, но ответы могли уйти. Проверьте почту ' + email + ' (и «Спам»): если письмо пришло, всё в порядке — партнёр уже получил приглашение. Если письма нет через 5 минут, отправьте ответы ещё раз.';
  }

  function submitA(nameA, emailA, nameB, emailB) {
    spinner('Отправляем ответы и приглашение…');
    api('create', { rid: rid(), nameA: nameA, emailA: emailA, nameB: nameB, emailB: emailB, genderA: S.genderSelf, genderB: S.genderPartner, context: S.pc, answers: S.answers, meta: { utm: utm, sid: sid } })
      .then(function (r) {
        track('submit_a');
        store.del(progressKey());
        if (r.t) store.set('cq_cab', { id: r.id, t: r.t, me: nameA, partner: nameB });
        var me = { name: nameA, gender: S.genderSelf, answers: S.answers };
        store.del('cq_pc_new');
        render(
          '<div class="center"><div class="okmark">✓</div><h2>Готово!</h2>' +
          (TG ? tgSentText(nameB, emailA, emailB, 'разбор')
            : '<p>Ваши ответы отправлены на <b>' + esc(emailA) + '</b>, а <b>' + esc(nameB) + '</b> получит приглашение на ' + esc(emailB) + '.<br>Как только партнёр ответит, разбор придёт вам обоим.</p>' + mailNote()) +
          tgRow(r.inviteTg || r.invite, inviteText(null), TG ? 'Отправить ссылку партнёру' : 'Отправить ссылку в Telegram', r.tg) +
          (r.t ? '<p><a class="btn ghost" href="?c=' + encodeURIComponent(r.id) + '&t=' + encodeURIComponent(r.t) + '">Пока ждёте — выбрать тему для разговора</a></p>' : '') +
          '</div>' +
          '<h2 style="margin-top:32px">Ваш личный портрет</h2>' +
          '<div class="paper">' + CQA.portraitHtml(me) + '</div>'
        );
      })
      .catch(function (e) {
        // Ответ мог потеряться уже после отправки писем — не провоцируем повторную отправку.
        errorScreen(e.message === NO_REPLY ? lostReply(emailA) : e.message);
      });
  }
  // Подпись над готовым разбором: с ИИ письмо приходит чуть позже.
  function readyNote() { return 'Разбор готов и отправлен вам обоим на почту.'; }

  // Раздел от ИИ к разбору — только по просьбе пары. kind: 'portrait' или id темы.
  function aiPanel(ai) {
    if (ai && !ai.on && ai.overall && S.pairId && S.token) return overallHint();
    if (!ai || !ai.on || ai.state === 'done') return '';
    if (ai.state === 'pending') return '<div class="panel ai-panel" id="ai-panel"><h3>ИИ пишет взгляд психолога</h3><p class="sub">Обычно это 1–2 минуты. Когда раздел будет готов, вам обоим придёт уведомление — он появится в этом разборе.</p></div>';
    return '<div class="panel ai-panel" id="ai-panel"><h3>Взгляд психолога от ИИ</h3><p class="sub">ИИ посмотрит на ваши ответы вместе с портретом и всеми пройденными темами и напишет несколько абзацев: что видно в сочетании ваших ответов и с чего начать разговор. Раздел увидите вы оба.</p>' +
      '<button class="btn again" id="ai-ask">Попросить разбор от ИИ</button></div>';
  }
  // ИИ пишет только общий разбор по всем модулям — подсказка, где его запросить.
  function overallHint() {
    return '<div class="panel ai-panel"><h3>Взгляд психолога от ИИ</h3><p class="sub">ИИ пишет общий разбор по всем темам и портрету, которые вы прошли вдвоём. Запросить его можно в кабинете пары.</p>' +
      '<a class="btn small again" href="' + cabHref() + '">В кабинет пары</a></div>';
  }
  function bindAi(kind) {
    on('#ai-ask', 'click', function () {
      var b = $('#ai-ask');
      b.disabled = true; b.textContent = 'Отправляем…';
      api('ai_request', { rid: rid(), id: S.pairId, t: S.token, kind: kind })
        .then(function (r) { track('ai_request', { kind: kind }); $('#ai-panel').outerHTML = aiPanel(r.ai); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Попросить разбор от ИИ'; alert(e.message); });
    });
  }
  function mailNote() {
    return DEMO ? '<p class="sub">Демо-режим: письма не отправляются, их можно посмотреть в «Демо-почте» внизу справа.</p>' : '<p class="sub">Не видите письмо? Проверьте папку «Спам» и «Промоакции».</p>';
  }

  function submitB(nameB, emailB) {
    spinner('Сравниваем ваши ответы и готовим разбор…');
    api('complete', { id: S.pairId, t: S.token, nameB: nameB, emailB: emailB, genderB: S.genderSelf, context: S.pc, answers: S.answers })
      .then(function (r) {
        track('submit_b');
        store.del(progressKey());
        showReport(r.html, readyNote(r), r.ai);
      })
      .catch(function (e) {
        if (e.message !== 'already_completed') return errorScreen(e.message);
        // Ответы уже приняты (например, первый запрос дошёл, а ответ потерялся) — просто показываем разбор.
        store.del(progressKey());
        api('report', { id: S.pairId, t: S.token })
          .then(function (r) { showReport(r.html, 'Разбор готов и отправлен вам обоим на почту.', r.ai); })
          .catch(function () { errorScreen('Ваши ответы приняты, разбор отправлен на почту.'); });
      });
  }

  function submitCabPortrait() {
    spinner(portraitPartnerIn() ? 'Сравниваем ваши ответы и готовим разбор…' : 'Отправляем ответы…');
    api('answer', { rid: rid(), id: S.pairId, t: S.token, kind: 'portrait', gender: S.genderSelf, answers: S.answers, retake: S.retake === 'portrait' })
      .then(function (r) {
        track('submit_portrait', { done: r.done });
        S.retake = null;
        store.del(progressKey());
        if (S.genderSelf) S.cab.genderMe = S.genderSelf;
        if (r.done) return showReport(r.html, readyNote(r), r.ai);
        render(
          '<div class="center"><div class="okmark">✓</div><h2>Готово!</h2>' +
          '<p>' + esc(S.cab.namePartner) + ' получит письмо с приглашением ответить. Как только это случится, разбор придёт вам обоим.</p>' + mailNote() +
          tgRow(partnerLink('portrait'), inviteText(null), 'Напомнить в Telegram', S.cab.tg) +
          '<p><a class="btn ghost" href="' + cabHref() + '">В кабинет пары</a></p></div>' +
          '<h2 style="margin-top:32px">Ваш личный портрет</h2>' +
          '<div class="paper">' + CQA.portraitHtml({ name: S.cab.nameMe, gender: S.cab.genderMe, answers: S.answers }) + '</div>'
        );
      })
      .catch(function (e) { errorScreen(e.message === NO_REPLY ? 'Сервер не успел ответить. Откройте кабинет пары через пару минут — если ответы приняты, это будет видно там.' : e.message, cabHref()); });
  }

  function cabinetCta() {
    if (!S.pairId || !S.token) return '';
    return '<div class="panel cab-cta"><h3>Продолжите разговор</h3><p>В кабинете пары — 21 тема для глубоких разговоров — от детства и первых свиданий до денег, доверия, ценностей и пережитых кризисов. Каждый новый разбор учитывает этот портрет.</p>' +
      '<a class="btn" href="' + cabHref() + '">Открыть кабинет пары</a></div>';
  }
  function showReport(html, note, ai) {
    render((note ? '<div class="center"><div class="okmark">✓</div><p>' + esc(note) + '</p></div>' : '') + aiPanel(ai) + '<div class="paper">' + html + '</div>' + cabinetCta() +
      '<div class="center" style="margin-top:28px"><p class="sub">Хотите пройти тест с кем-то ещё или повторить через пару месяцев?</p><a class="btn ghost" href="./">На главную</a></div>' +
      recommendBlock());
    bindAi('portrait');
    bindRecommend();
  }

  function reportView() {
    spinner('Загружаем разбор…');
    api('report', { id: S.pairId, t: S.token })
      .then(function (r) { track('view_report'); showReport(r.html, '', r.ai); })
      .catch(function (e) { errorScreen(e.message === 'not_ready' ? 'Партнёр ещё не ответил — разбор появится, как только это произойдёт.' : e.message === 'not_found' ? 'Разбор не найден. Проверьте ссылку из письма.' : e.message); });
  }

  // ───────────────────────── кабинет пары
  function cabinet() {
    spinner('Открываем кабинет пары…');
    api('cabinet', { id: S.pairId, t: S.token }).then(function (r) {
      S.cab = r; S.role = r.me; S.ctx = 'cabinet'; S.pc = CQA.parseContext(r.context);
      // Мини-приложение открыли по ссылке, а бот ещё не может писать этому человеку — спросим разрешение.
      if (TG && TG.app && !TG.user.allows_write_to_pm && !sess.get('cq_tg_wa') && TG.app.requestWriteAccess) {
        sess.set('cq_tg_wa', '1');
        try {
          // После согласия бот присылает приветствие с кнопкой кабинета — иначе чат с ботом остаётся пустым.
          TG.app.requestWriteAccess(function (granted) { if (granted) api('tg_welcome', { id: S.pairId, t: S.token }).catch(function () {}); });
        } catch (e) { /* старый клиент */ }
      }
      store.set('cq_cab', { id: S.pairId, t: S.token, me: r.nameMe, partner: r.namePartner });
      var tp = params.get('topic'), go = params.get('go');
      if (tp && CQT.topic(tp)) return openTopic(tp);
      if (go === 'portrait' && !r.portrait.me) return portraitIntro();
      if (go === 'overall' && r.overall && r.overall.at) return overallView();
      cabinetView();
    }).catch(function (e) { errorScreen(e.message === 'not_found' ? 'Кабинет не найден. Проверьте ссылку из письма.' : e.message); });
  }

  function cabinetView() {
    var c = S.cab, pt = c.portrait;
    track('view_cabinet');
    var again = pt.was ? 'Повтор · ' : '';
    var pState = pt.done ? '<span class="chip good">Разбор готов</span>' : pt.me ? '<span class="chip wait">' + again + 'Ждём ответа: ' + esc(c.namePartner) + '</span>' : pt.partner ? '<span class="chip accent">' + again + 'Ваша очередь</span>' : '';
    var pReport = '?r=' + encodeURIComponent(S.pairId) + '&t=' + encodeURIComponent(S.token);
    // Портрет можно пройти снова; пока идёт повтор, прошлый разбор открывается по той же ссылке.
    var pBtn = pt.done ? '<span class="btns"><button class="btn small again" id="portrait-retake">Пройти снова</button><a class="btn small ghost" href="' + pReport + '">Открыть разбор</a></span>'
      : '<span class="btns">' + (pt.was ? '<a class="btn small ghost" href="' + pReport + '">Прошлый разбор</a>' : '') +
        (pt.me ? tgShare(partnerLink('portrait'), inviteText(null), 'Напомнить в Telegram') : '<button class="btn small" id="portrait">' + (pt.partner ? 'Ответить' : 'Пройти') + '</button>') + '</span>';
    var doneTopics = CQT.topics.filter(function (t) { return c.topics[t.id] && c.topics[t.id].done; }).length;
    render(
      '<section class="hero cab-hero">' +
        '<p class="eyebrow">Кабинет пары' + (DEMO ? '<span class="demo-badge">демо-режим</span>' : '') + '</p>' +
        '<h1><span class="a">' + esc(c.nameMe) + '</span> &amp; <span class="b">' + esc(c.namePartner) + '</span></h1>' +
        '<p class="lead">Выберите, о чём хотите поговорить сегодня. Каждый новый разбор учитывает ваш портрет и все темы, которые вы уже прошли вдвоём' +
          (doneTopics || pt.done ? ' — сейчас это ' + [pt.done ? 'портрет' : '', doneTopics ? doneTopics + ' ' + plural(doneTopics, 'тема', 'темы', 'тем') : ''].filter(Boolean).join(' и ') : '') + '.</p>' +
      '</section>' +
      contextCard(c) +
      (TG ? '<p class="ctx-line"><button class="link" id="tg-pairs">Мои пары</button> · <button class="link" id="tg-find">Найти пары с сайта по почте</button></p>' : '') +
      overallCard(c) +
      (c.notMine ? '<div class="topic-card wide waiting"><p>Похоже, это ссылка для ' + esc(c.nameMe) + ', а ваш аккаунт Telegram уже связан с ' + esc(c.namePartner) + '. Перешлите её партнёру — если ответить здесь, ответы засчитаются за ' + esc(c.nameMe) + '.</p></div>' : '') +
      tgCard(c.tg) + partnerTgCard(c) + emailCard(c) +
      '<div class="topic-card wide' + (pt.partner && !pt.me ? ' hot' : pt.me && !pt.done ? ' waiting' : '') + '"><div class="topic-top"><h3>Портрет пары</h3>' + pState + '</div>' +
        '<p>' + QS.length + ' вопроса об общении, конфликтах, быте, деньгах, близости и будущем — основа для всех разговоров.</p>' +
        '<div class="topic-foot"><small>≈ 10 минут</small>' + pBtn + '</div></div>' +
      '<h2>Разговоры</h2>' +
      topicGrid(c.topics) +
      (TG ? '<p class="note">Этот же кабинет открывается на сайте — <a data-ext href="' + esc(location.origin + location.pathname + cabHref()) + '">открыть в браузере</a>.</p>'
        : c.tg && c.tg.linked ? '<p class="note">✓ Уведомления приходят в Telegram — <a href="https://t.me/' + esc(c.tg.bot) + '" target="_blank" rel="noopener">открыть бота</a>.</p>' : '') +
      '<p class="note">Ответы партнёра вы увидите, только когда ответите оба. Эта страница открывается по личной ссылке из письма — не пересылайте её посторонним.</p>'
    );
    on('#portrait', 'click', function () { portraitIntro(); });
    on('#portrait-retake', 'click', function () { track('portrait_retake'); S.retake = 'portrait'; portraitIntro(); });
    on('#ov-open', 'click', overallView);
    on('#ctx-edit', 'click', function () {
      contextScreen({ initial: S.pc, onBack: cabinetView, onDone: function (cx) { saveContext(cx, cabinetView); } });
    });
    on('#ov-ask', 'click', overallAsk);
    on('#em', 'submit', saveEmail);
    on('#tg-find', 'click', tgFind);
    on('#tg-pairs', 'click', function () {
      spinner('Загружаем ваши пары…');
      api('tg_session', {}).then(function (r) { tgPick(r.pairs); }).catch(tgFail);
    });
    bindTopicGrid(openTopic);
  }

  // Пара начата в Telegram без почты: предлагаем добавить — письма с разборами и вход с сайта.
  function emailCard(c) {
    if (c.emailMe || DEMO) return '';
    return '<div class="topic-card wide"><div class="topic-top"><h3>Почта — по желанию</h3></div>' +
      '<p>Разборы будут приходить и на почту, а этот кабинет можно будет открыть с компьютера — со всеми темами и разборами.</p>' +
      '<form id="em" class="em-row" novalidate><input name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" maxlength="80" aria-label="Ваш email">' +
      '<button class="btn small" type="submit">Сохранить</button></form><p class="error" id="em-err" hidden></p></div>';
  }
  function saveEmail(e) {
    e.preventDefault();
    var v = e.target.elements.email.value.trim(), err = $('#em-err');
    if (!emailRe.test(v)) { err.textContent = 'Проверьте адрес email.'; err.hidden = false; return; }
    var b = e.target.querySelector('button');
    b.disabled = true; b.textContent = 'Сохраняем…';
    api('set_email', { id: S.pairId, t: S.token, email: v })
      .then(function (r) { track('set_email'); S.cab.emailMe = r.email; cabinetView(); })
      .catch(function (x) { b.disabled = false; b.textContent = 'Сохранить'; err.textContent = x.message; err.hidden = false; });
  }

  // Сводка «О вашей паре» в кабинете (или просьба ответить, если её ещё нет).
  function contextCard() {
    if (!S.pc) return '<div class="topic-card wide waiting"><div class="topic-top"><h3>Расскажите о вашей паре</h3><span class="chip wait">4 вопроса</span></div>' +
      '<p>Где вы живёте, сколько вместе, есть ли дети — чтобы вопросы в темах подходили именно вам.</p>' +
      '<div class="topic-foot"><small>≈ 30 секунд</small><button class="btn small" id="ctx-edit">Ответить</button></div></div>';
    return '<p class="ctx-line"><span>' + esc(contextLine(S.pc)) + '</span> <button class="link" id="ctx-edit">Изменить</button></p>';
  }

  // ───────────────────────── Telegram: ссылка партнёру и уведомления от бота
  function inviteText(topic) {
    return topic ? 'Давай поговорим на тему ' + CQT.quoted(topic.title) + ' в «Мы вдвоём»: ответь на вопросы — и мы получим разбор и план разговора.'
      : 'Пройди со мной «Портрет пары» в «Мы вдвоём»: ответь на вопросы — и мы получим разбор на двоих.';
  }
  // Ссылка партнёра уходит в выбранный чат Telegram — та же, что в его письме.
  // Ссылка партнёра на модуль: в мини-приложение (если у бота оно включено) или на сайт.
  function partnerLink(what) {
    var c = S.cab;
    if (c.partnerTg) return c.partnerTg + '-' + what;
    return c.partnerLink ? c.partnerLink + (what === 'portrait' ? '&go=portrait' : '&topic=' + what) : '';
  }
  function tgShare(link, text, label, main) {
    if (!link) return '';
    return '<a class="btn ' + (main ? '' : 'small ghost') + '" target="_blank" rel="noopener" href="https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text) + '">' + esc(label) + '</a>';
  }
  function tgConnect(tg) {
    return tg && !tg.linked && !TG ? '<a class="btn small ghost" target="_blank" rel="noopener" href="' + esc(tg.link) + '">Получать уведомления в Telegram</a>' : '';
  }
  function tgRow(link, text, label, tg) {
    var b = tgShare(link, text, label, !!TG) + tgConnect(tg);
    return b ? '<p class="tg-row">' + b + '</p>' + (link ? '<p class="sub">Ссылка личная — отправьте её только партнёру.</p>' : '') : '';
  }
  // Партнёр ещё не открывал кабинет в Telegram: ссылка откроет мини-приложение сразу в его кабинете
  // и свяжет его аккаунт (та же личная ссылка, что в его письмах).
  function partnerTgCard(c) {
    if (!c.tg || c.partnerLinked) return '';
    var link = c.partnerTg || c.partnerLink;
    if (!link) return '';
    var text = 'Наш кабинет в «Мы вдвоём» теперь открывается в Telegram — все темы и разборы. Открой по ссылке, и уведомления будут приходить сюда.';
    return '<div class="topic-card wide"><div class="topic-top"><h3>' + esc(c.namePartner) + ' — в Telegram</h3></div>' +
      '<p>' + esc(c.namePartner) + ' откроет ваш общий кабинет прямо в Telegram — и будет получать уведомления, когда вы ответили и когда готов разбор.</p>' +
      '<div class="topic-foot"><small>Ссылка личная — только для партнёра</small>' + tgShare(link, text, 'Отправить ссылку', true).replace('class="btn "', 'class="btn small"') + '</div></div>';
  }
  function tgSentText(name, emailA, emailB, what) {
    return '<p>Ответы сохранены. Теперь пригласите <b>' + esc(name) + '</b> — отправьте ссылку в Telegram. Когда ответите оба, ' + what + ' откроется здесь, а бот пришлёт уведомление.</p>' +
      (emailB ? '<p class="sub">Приглашение ушло и на ' + esc(emailB) + '.</p>' : '') + (emailA ? '<p class="sub">Копия — на ' + esc(emailA) + '.</p>' : '');
  }
  function tgCard(tg) {
    if (!tg || tg.linked || TG) return '';
    return '<div class="topic-card wide"><div class="topic-top"><h3>Уведомления в Telegram</h3></div>' +
      '<p>Бот напишет, когда ' + esc(S.cab.namePartner) + ' ответит и когда будет готов разбор, — не нужно ждать письма. Ответы в Telegram не отправляются.</p>' +
      '<div class="topic-foot"><small>≈ 10 секунд</small><a class="btn small" target="_blank" rel="noopener" href="' + esc(tg.link) + '">Подключить</a></div></div>';
  }

  // ───────────────────────── «Рекомендовать другой паре»
  // Ссылка — не в кабинет, а на главную с меткой ref (номер пары + кто рекомендовал). Метка сохраняется
  // в meta новой пары (utm.ref) — по ней позже можно будет давать бонус за рекомендацию.
  var REC_TEXT = 'Мы попробовали «Мы вдвоём»: каждый отвечает на вопросы сам, а потом вы получаете разбор на двоих и план разговора на вечер. Попробуйте вдвоём:';
  function refCode() { return S.pairId ? String(S.pairId) + (S.cab && S.cab.me ? S.cab.me.toLowerCase() : '') : ''; }
  function recLinks() {
    var code = refCode(), site = location.origin + location.pathname + '?ref=' + encodeURIComponent(code) + '&utm_source=referral';
    var tg = S.cab && S.cab.tg && S.cab.partnerTg ? 'https://t.me/' + S.cab.tg.bot + '?startapp=ref_' + code : '';
    return { site: site, share: tg || site };
  }
  function recommendBlock() {
    if (!refCode()) return '';
    var L = recLinks();
    return '<div class="panel center recommend"><h3>Понравилось? Порекомендуйте другой паре</h3>' +
      '<p class="sub">Отправьте ссылку друзьям — это не ваш кабинет, а приглашение попробовать сервис. Ваши ответы и разборы никто не увидит.</p>' +
      '<p class="tg-row">' + tgShare(L.share, REC_TEXT, 'Отправить в Telegram', true) +
      '<button class="btn ghost" type="button" id="rec-copy">Скопировать ссылку</button></p>' +
      '<p class="sub" id="rec-ok" hidden>Ссылка скопирована — вставьте её в любой мессенджер.</p></div>';
  }
  function bindRecommend() {
    var box = $('.recommend');
    if (!box) return;
    var a = box.querySelector('a');
    if (a) a.addEventListener('click', function () { track('recommend_share', { via: 'telegram' }); });
    on('#rec-copy', 'click', function () {
      var text = REC_TEXT + ' ' + recLinks().site, ok = $('#rec-ok');
      track('recommend_share', { via: 'copy' });
      function done() { ok.hidden = false; }
      try { navigator.clipboard.writeText(text).then(done, function () { window.prompt('Скопируйте ссылку:', text); }); }
      catch (e) { window.prompt('Скопируйте ссылку:', text); }
    });
  }

  // ───────────────────────── общий разбор (только когда на сервере подключён Claude)
  function overallCard(c) {
    if (!c.ai) return '';
    var o = c.overall || {}, n = c.modules, min = c.overallMin || 3, fresh = n > (o.modules || 0);
    var text, btns = '';
    if (o.pending) text = 'Готовится — придёт вам обоим на почту через несколько минут.';
    else if (n < min) text = 'Станет доступен, когда вы вдвоём пройдёте хотя бы ' + min + ' модуля. Сейчас пройдено: ' + n + '.';
    else if (o.at) text = 'Последний разбор — от ' + esc(o.at) + ', по ' + o.modules + ' ' + plural(o.modules, 'модулю', 'модулям', 'модулям') + '.' + (fresh ? ' С тех пор вы прошли ещё — его можно обновить.' : '');
    else text = 'ИИ посмотрит на всё, что вы прошли вдвоём (' + n + ' ' + plural(n, 'модуль', 'модуля', 'модулей') + '), и напишет общий разбор: сквозные линии каждого, где вы промахиваетесь и с чего начать разговор.';
    if (o.at) btns += '<button class="btn small ghost" id="ov-open">Открыть</button>';
    if (!o.pending && n >= min && fresh) btns += '<button class="btn small" id="ov-ask">' + (o.at ? 'Обновить' : 'Получить разбор') + '</button>';
    return '<div class="topic-card wide overall"><div class="topic-top"><h3>Общий разбор от ИИ</h3>' + (o.pending ? '<span class="chip wait">Готовится</span>' : '') + '</div>' +
      '<p>' + text + '</p>' + (btns ? '<div class="topic-foot"><small>по всем модулям</small><span class="btns">' + btns + '</span></div>' : '') + '</div>';
  }
  function overallAsk() {
    var b = $('#ov-ask');
    if (b) { b.disabled = true; b.textContent = 'Отправляем…'; }
    api('overall_request', { rid: rid(), id: S.pairId, t: S.token })
      .then(function () {
        track('overall_request');
        S.cab.overall = Object.assign({}, S.cab.overall, { pending: true });
        cabinetView();
      })
      .catch(function (e) { if (b) { b.disabled = false; b.textContent = 'Получить разбор'; } alert(e.message); });
  }
  function overallView() {
    spinner('Загружаем общий разбор…');
    api('overall_view', { id: S.pairId, t: S.token })
      .then(function (r) {
        track('view_overall');
        render('<p class="crumbs"><a href="' + cabHref() + '">← Кабинет пары</a></p><div class="paper">' + r.html + '</div>' +
          '<div class="center" style="margin-top:28px"><a class="btn" href="' + cabHref() + '">В кабинет пары</a></div>' + recommendBlock());
        bindRecommend();
      })
      .catch(function (e) { errorScreen(e.message === 'not_ready' ? 'Общий разбор ещё готовится — он придёт на почту.' : e.message, cabHref()); });
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  }

  function openTopic(id) {
    var st = S.cab && S.cab.topics[id] || {};
    var t = CQT.topic(id);
    if (st.done) {
      spinner('Загружаем разбор…');
      return api('talk', { id: S.pairId, t: S.token, topic: id })
        .then(function (r) { track('view_talk', { topic: id }); showTalk(r.html, t, '', true, r.ai); })
        .catch(function (e) { errorScreen(e.message, cabHref()); });
    }
    if (st.me) {
      return render('<p class="crumbs"><a href="' + cabHref() + '">← Кабинет пары</a></p>' +
        '<div class="panel center"><div class="okmark">✓</div><h2>' + esc(t.title) + '</h2><p>Вы уже ответили. Как только ' + esc(S.cab.namePartner) + ' ответит, разбор и план разговора придут вам обоим на почту.' +
          (st.was ? ' В разборе будет видно, что изменилось с ' + esc(st.was) + '.' : '') + '</p>' +
        tgRow(partnerLink(id), inviteText(t), 'Напомнить в Telegram', S.cab.tg) +
        (st.was ? '<p><button class="btn ghost" id="prev">Прошлый разбор</button></p>' : '') +
        '<a class="btn ghost" href="' + cabHref() + '">Выбрать другую тему</a></div>');
      on('#prev', 'click', function () { openPrev(id); });
      return;
    }
    topicIntro(id);
  }
  // Последний завершённый разбор темы (пока идёт повторное прохождение).
  function openPrev(id) {
    spinner('Загружаем прошлый разбор…');
    api('talk', { id: S.pairId, t: S.token, topic: id })
      .then(function (r) { track('view_talk', { topic: id, prev: true }); showTalk(r.html, CQT.topic(id), '', false, r.ai); })
      .catch(function (e) { errorScreen(e.message, cabHref()); });
  }
  // Партнёр уже ответил в текущем прохождении темы (у пройденной темы текущего прохождения ещё нет).
  function partnerIn(id) { var st = S.cab && S.cab.topics[id] || {}; return !!st.partner && !st.done; }

  function showTalk(html, t, note, canRetake, ai) {
    render('<p class="crumbs"><a href="' + cabHref() + '">← Кабинет пары</a></p>' +
      (note ? '<div class="center"><div class="okmark">✓</div><p>' + esc(note) + '</p></div>' : '') + aiPanel(ai) +
      '<div class="paper">' + html + '</div>' +
      '<div class="center" style="margin-top:28px"><p class="sub">Поговорили? Выберите следующую тему, когда будете готовы.</p><a class="btn" href="' + cabHref() + '">Другие темы</a></div>' +
      (canRetake ? '<div class="panel center" style="margin-top:20px"><h3>Пройти тему ещё раз</h3><p class="sub">Через несколько месяцев интересно ответить снова: новый разбор покажет, что изменилось у каждого и насколько лучше вы угадываете друг друга. Этот разбор сохранится.</p>' +
        '<button class="btn again" id="retake">Пройти снова</button></div>' : '') +
      recommendBlock());
    bindRecommend();
    on('#retake', 'click', function () { track('topic_retake', { topic: t.id }); S.retake = t.id; topicIntro(t.id); });
    bindAi(t.id);
  }

  // ───────────────────────── тема: вопросы, догадки, фраза партнёру
  var T = null;
  function topicKey(id) { return 'cq_topic_' + (S.ctx === 'cabinet' ? S.token : 'new') + '_' + id; }
  function saveTopic() { store.set(topicKey(T.topic.id), { a: T.a, g: T.g, note: T.note, idx: T.idx, nameSelf: T.nameSelf, namePartner: T.namePartner, genderSelf: T.genderSelf, genderPartner: T.genderPartner, pc: T.pc }); }
  // Шаги темы с учётом пары: вопросы подстроены, неподходящие пропущены.
  function steps(topic, pc) {
    var out = [], i = 0;
    topic.questions.forEach(function (q0) {
      var q = CQA.adapt(q0, pc);
      if (!q) return;
      out.push({ q: q, i: i, guess: false });
      if (q.guess) out.push({ q: q, i: i, guess: true });
      i++;
    });
    out.total = i;
    return out;
  }

  function topicIntro(id) {
    var topic = CQT.topic(id), saved = store.get(topicKey(id)), isNew = S.ctx !== 'cabinet';
    var contact = store.get('cq_contact') || {};
    var n = saved && saved.a ? Object.keys(saved.a).length : 0;
    var partner = isNew ? 'партнёр' : S.cab.namePartner;
    var partnerAnswered = !isNew && partnerIn(id);
    var stI = !isNew && S.cab.topics[id] || {}, retakeNote = S.retake === id ? 'Вы проходите эту тему снова. Отвечайте, как чувствуете сейчас, — новый разбор покажет, что изменилось, а прошлый сохранится.'
      : stI.was ? 'Это повторное прохождение темы (прошлый раз — ' + stI.was + '): новый разбор покажет, что изменилось.' : '';
    track('topic_open', { topic: id });
    render(
      '<p class="crumbs"><a href="' + (isNew ? './' : cabHref()) + '">← ' + (isNew ? 'На главную' : 'Кабинет пары') + '</a></p>' +
      '<section class="hero">' +
        '<p class="eyebrow">Разговор · ≈ ' + topic.minutes + ' минут</p>' +
        '<h1>' + esc(topic.title) + '</h1>' +
        '<p class="lead">' + esc(topic.intro) + '</p>' +
      '</section>' +
      (retakeNote ? '<p class="note accent-note">' + esc(retakeNote) + '</p>' : '') +
      (partnerAnswered ? '<p class="note accent-note">' + esc(partner) + ' уже ответил(а) на эту тему. Ваша очередь — после этого разбор придёт вам обоим.</p>' : '') +
      '<ul class="howto">' +
        '<li><b>Отвечайте за себя.</b> Можно выбрать до двух вариантов, любой вопрос — пропустить.</li>' +
        '<li><b>Угадайте партнёра.</b> На ' + topic.questions.filter(function (q) { return q.guess; }).length + ' вопросах нужно предположить, что ответит ' + esc(partner) + '.</li>' +
        '<li><b>Получите план разговора.</b> Разбор покажет, где вы угадали друг друга, свяжет ответы с прошлыми темами и предложит вопросы на вечер.</li>' +
      '</ul>' +
      (isNew
        ? '<form class="panel" id="names" novalidate><div class="grid2">' +
            field('nameSelf', 'Ваше имя', 'text', saved && saved.nameSelf || contact.nameSelf || '', 'given-name') +
            field('namePartner', 'Имя партнёра', 'text', saved && saved.namePartner || '', 'off') +
            genderField('genderSelf', 'Как к вам обращаться', saved && saved.genderSelf || contact.genderSelf || '') +
            genderField('genderPartner', 'Как обращаться к партнёру', saved && saved.genderPartner || '') +
          '</div><p class="error" id="err" hidden></p>' + topicCta(n, topic) + '</form>'
        : topicCta(n, topic))
    );
    function begin(fresh) {
      var nameSelf = isNew ? ($('[name=nameSelf]').value || '').trim() : S.cab.nameMe;
      var namePartner = isNew ? ($('[name=namePartner]').value || '').trim() : S.cab.namePartner;
      if (isNew && (!nameSelf || !namePartner)) { var e = $('#err'); e.textContent = 'Укажите оба имени — они нужны для вопросов-догадок.'; e.hidden = false; return; }
      if (fresh) store.del(topicKey(id));
      var sv = fresh ? null : store.get(topicKey(id));
      var f = $('#names');
      var gs = f ? radio(f, 'genderSelf') : '', gp = f ? radio(f, 'genderPartner') : '';
      if (sv && sv.pc && !S.pc) S.pc = sv.pc;
      withContext(function (pc) {
        T = { topic: topic, pc: pc, steps: steps(topic, pc), a: sv && sv.a || {}, g: sv && sv.g || {}, note: sv && sv.note || '', idx: sv && sv.idx || 0, nameSelf: nameSelf, namePartner: namePartner,
          genderSelf: gs, genderPartner: gp };
        track('topic_start', { topic: id, restart: !!fresh });
        topicStep();
      }, function () { topicIntro(id); });
    }
    if (isNew) on('#names', 'submit', function (e) { e.preventDefault(); begin(false); });
    on('#go', 'click', function (e) { e.preventDefault(); begin(false); });
    on('#restart', 'click', function (e) { e.preventDefault(); begin(true); });
  }
  function topicCta(n, topic) {
    if (!n) return '<div class="cta"><button class="btn" id="go">Начать</button><small>' + topic.questions.length + ' вопросов</small></div>';
    return '<div class="cta"><button class="btn" id="go">Продолжить</button><button class="btn ghost" type="button" id="restart">Начать заново</button>' +
      '<small>Сохранены ответы: ' + n + ' из ' + topic.questions.length + '</small></div>';
  }

  function topicStep() {
    var st = T.steps;
    // Догадку пропущенного вопроса не задаём
    while (T.idx < st.length && st[T.idx].guess && !T.a[st[T.idx].q.id]) T.idx++;
    if (T.idx >= st.length) return topicNote();
    var s = st[T.idx], q = s.q, total = st.total;
    var layer = CQ_TOPICS.layers[q.layer] || '';
    questionScreen({
      head: '<div class="quiz-head"><span><b>' + esc(T.topic.title) + '</b> · ' + esc(layer) + '</span><span>' + (s.i + 1) + ' / ' + total + '</span></div>',
      pct: Math.round(100 * T.idx / st.length),
      kicker: s.guess ? 'А что ответит <b>' + esc(T.namePartner) + '</b>? Угадайте' : '',
      guess: s.guess, text: q.text, q: q,
      sel: s.guess ? T.g[q.id] : T.a[q.id],
      onBack: T.idx > 0 ? function () {
        T.idx--;
        while (T.idx > 0 && st[T.idx].guess && !T.a[st[T.idx].q.id]) T.idx--;
        saveTopic(); topicStep();
      } : null,
      onSkip: s.guess ? null : function () {
        delete T.a[q.id]; delete T.g[q.id];
        T.idx++; saveTopic(); topicStep();
      },
      onDone: function (keys) {
        if (s.guess) T.g[q.id] = store1(q, keys); else T.a[q.id] = store1(q, keys);
        T.idx++; saveTopic(); topicStep();
      }
    });
  }

  function topicNote() {
    var isNew = S.ctx !== 'cabinet', topic = T.topic;
    var answered = Object.keys(T.a).length, total = T.steps.total, need = Math.ceil(total / 2);
    var contact = store.get('cq_contact') || {};
    var partnerDone = !isNew && partnerIn(topic.id);
    track('topic_note_view', { topic: topic.id });
    render(
      '<div class="quiz-head"><span><b>' + esc(topic.title) + '</b></span><span>Почти готово</span></div>' + progressBar(100) +
      '<form class="panel" id="f" novalidate>' +
        '<h2>Одна фраза для партнёра</h2>' +
        '<p class="sub">Необязательно. То, что давно хотелось сказать по этой теме, — ' + esc(T.namePartner) + ' увидит фразу в разборе.</p>' +
        '<label class="field"><textarea name="note" rows="3" maxlength="300" placeholder="Например: «Спасибо, что ты рядом, даже когда мне трудно говорить»">' + esc(T.note) + '</textarea></label>' +
        (isNew ? '<div class="grid2">' +
            field('emailSelf', mailLabel('Ваш email'), 'email', contact.emailSelf || '', 'email') +
            field('emailPartner', mailLabel('Email: ' + esc(T.namePartner)), 'email', '', 'off') +
          '</div><p class="sub">' + (TG ? TG_MAIL_NOTE : 'Вам придёт ссылка на кабинет пары, а ' + esc(T.namePartner) + ' получит приглашение ответить на эту тему.') + '</p>'
          : S.cab.genderMe ? '' : genderField('genderSelf', 'Как к вам обращаться в разборе', '')) +
        '<label class="hp" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label>' +
        CONSENT +
        '<p class="error" id="err"' + (answered < need ? '' : ' hidden') + '>' + (answered < need ? 'Ответьте хотя бы на ' + need + ' вопросов из ' + total + ' — сейчас ' + answered + '.' : '') + '</p>' +
        '<button class="btn block" type="submit">' + (partnerDone ? 'Получить разбор' : 'Отправить') + '</button>' +
        '<div class="quiz-nav" style="margin-top:8px"><button class="link" type="button" id="back">← Вернуться к вопросам</button><span></span></div>' +
      '</form>'
    );
    on('[name=note]', 'input', function (e) { T.note = e.target.value; saveTopic(); });
    on('#back', 'click', function () {
      T.idx = T.steps.length - 1;
      // к первому пропущенному вопросу, если ответов мало
      if (Object.keys(T.a).length < need) T.idx = T.steps.findIndex(function (s) { return !s.guess && !T.a[s.q.id]; });
      saveTopic(); topicStep();
    });
    on('#f', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, v = function (n) { return (f.elements[n] && f.elements[n].value || '').trim(); };
      var err = $('#err');
      function fail(m) { err.textContent = m; err.hidden = false; }
      if (Object.keys(T.a).length < need) return fail('Ответьте хотя бы на ' + need + ' вопросов из ' + total + '.');
      if (isNew) {
        if (!mailOk(v('emailSelf'))) return fail('Проверьте ваш email.');
        if (!mailOk(v('emailPartner'))) return fail('Проверьте email партнёра.');
        if (v('emailPartner') && v('emailPartner').toLowerCase() === v('emailSelf').toLowerCase()) return fail('Email партнёра должен отличаться от вашего.');
      }
      if (!f.elements.consent.checked) return fail('Подтвердите согласие, чтобы продолжить.');
      if (v('website')) return;
      T.note = v('note');
      if (!isNew && !S.cab.genderMe) T.genderSelf = radio(f, 'genderSelf');
      if (isNew) {
        store.set('cq_contact', { nameSelf: T.nameSelf, emailSelf: v('emailSelf'), genderSelf: T.genderSelf });
        submitStart(v('emailSelf'), v('emailPartner'));
      } else submitTopic();
    });
  }

  function topicPayload() { return { answers: T.a, guesses: T.g, note: T.note }; }

  function submitStart(emailA, emailB) {
    var topic = T.topic;
    spinner('Отправляем ответы и приглашение…');
    api('start', Object.assign({ rid: rid(), topic: topic.id, nameA: T.nameSelf, emailA: emailA, nameB: T.namePartner, emailB: emailB, genderA: T.genderSelf, genderB: T.genderPartner, context: T.pc, meta: { utm: utm, sid: sid } }, topicPayload()))
      .then(function (r) {
        track('topic_submit', { topic: topic.id, ctx: 'new' });
        store.del(topicKey(topic.id));
        store.del('cq_pc_new');
        S.pairId = r.id; S.token = r.t;
        store.set('cq_cab', { id: r.id, t: r.t, me: T.nameSelf, partner: T.namePartner });
        render('<div class="panel center"><div class="okmark">✓</div><h2>Готово!</h2>' +
          (TG ? tgSentText(T.namePartner, emailA, emailB, 'разбор и план разговора')
            : '<p><b>' + esc(T.namePartner) + '</b> получит приглашение на ' + esc(emailB) + '. Как только ответы будут у обоих, разбор и план разговора придут вам на почту.</p>' +
              '<p>Ссылку на ваш кабинет пары мы отправили на <b>' + esc(emailA) + '</b>. Там можно выбрать следующую тему или пройти портрет пары.</p>' + mailNote()) +
          tgRow(r.inviteTg || r.invite, inviteText(topic), TG ? 'Отправить ссылку партнёру' : 'Отправить ссылку в Telegram', r.tg) +
          '<a class="btn" href="' + cabHref() + '">Открыть кабинет пары</a></div>');
      })
      .catch(function (e) { errorScreen(e.message === NO_REPLY ? lostReply(emailA) : e.message); });
  }

  function submitTopic() {
    var topic = T.topic, partnerDone = partnerIn(topic.id);
    spinner(partnerDone ? 'Сравниваем ответы и готовим разбор…' : 'Отправляем ответы…');
    api('answer', Object.assign({ rid: rid(), id: S.pairId, t: S.token, kind: topic.id, gender: T.genderSelf, retake: S.retake === topic.id }, topicPayload()))
      .then(function (r) {
        track('topic_submit', { topic: topic.id, ctx: 'cabinet', done: r.done });
        S.retake = null;
        store.del(topicKey(topic.id));
        if (T.genderSelf) S.cab.genderMe = T.genderSelf;
        if (r.done) return showTalk(r.html, topic, readyNote(r), false, r.ai);
        render('<p class="crumbs"><a href="' + cabHref() + '">← Кабинет пары</a></p>' +
          '<div class="panel center"><div class="okmark">✓</div><h2>Готово!</h2>' +
          '<p>' + esc(S.cab.namePartner) + ' получит письмо с приглашением ответить на тему ' + esc(CQT.quoted(topic.title)) + '. Как только это случится, разбор и план разговора придут вам обоим.</p>' + mailNote() +
          tgRow(partnerLink(topic.id), inviteText(topic), 'Напомнить в Telegram', S.cab.tg) +
          '<a class="btn ghost" href="' + cabHref() + '">Выбрать ещё тему</a></div>');
      })
      .catch(function (e) { errorScreen(e.message === NO_REPLY ? 'Сервер не успел ответить. Откройте кабинет пары через пару минут — если ответы приняты, это будет видно там.' : e.message, cabHref()); });
  }

  // ───────────────────────── демо-бэкенд (localStorage) — для проверки без Apps Script
  // Повторяет логику backend/Code.gs.
  var Demo = {
    pairs: function () { return store.get('cq_demo_pairs') || {}; },
    save: function (p) { var all = Demo.pairs(); all[p.id] = p; store.set('cq_demo_pairs', all); },
    mails: function () { return store.get('cq_demo_mail') || []; },
    send: function (to, m) { var l = Demo.mails(); l.unshift({ to: to, subject: m.subject, html: m.html, at: new Date().toLocaleTimeString('ru') }); store.set('cq_demo_mail', l.slice(0, 40)); DemoUI.refresh(); },
    rnd: function () { return Math.random().toString(36).slice(2, 10); },
    base: function () { return location.origin + location.pathname; },
    cab: function (p, who) { return Demo.base() + '?c=' + p.id + '&t=' + p['t' + who]; },
    call: function (d) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(Demo[d.action](d)); } catch (e) { reject(e); }
        }, 400);
      });
    },
    find: function (d) {
      var p = Demo.pairs()[d.id];
      if (!p || (d.t !== p.tA && d.t !== p.tB)) throw new Error('not_found');
      p.talks = p.talks || {};
      return p;
    },
    role: function (p, t) { return t === p.tA ? 'A' : 'B'; },
    cleanPortrait: function (a) {
      var out = {};
      QS.forEach(function (q) { var v = CQT.cleanKeys(q, a && a[q.id]); if (v) out[q.id] = v; });
      return out;
    },
    newPair: function (d) {
      if (d.emailA.toLowerCase() === d.emailB.toLowerCase()) throw new Error('Email партнёра должен отличаться от вашего.');
      return { id: Demo.rnd(), tA: Demo.rnd(), tB: Demo.rnd(), context: CQA.cleanContext(d.context), A: { name: d.nameA, email: d.emailA, gender: d.genderA || '' }, B: { name: d.nameB, email: d.emailB, gender: d.genderB || '' }, talks: {} };
    },
    create: function (d) {
      var p = Demo.newPair(d);
      p.A.answers = Demo.cleanPortrait(d.answers);
      Demo.save(p);
      Demo.send(d.emailA, CQA.mail.initiator(p.A, p.B, Demo.cab(p, 'A'), p.context));
      Demo.send(d.emailB, CQA.mail.invite(p.A, p.B, Demo.base() + '?p=' + p.id + '&t=' + p.tB));
      return { ok: true, id: p.id, t: p.tA, invite: Demo.base() + '?p=' + p.id + '&t=' + p.tB, tg: null };
    },
    start: function (d) {
      var topic = CQT.topic(d.topic), p = Demo.newPair(d);
      p.talks[topic.id] = { A: CQT.cleanTopic(topic, d, p.context) };
      Demo.save(p);
      Demo.send(d.emailA, CQT.mail.topicStarted(p.A, p.B, topic, Demo.cab(p, 'A')));
      Demo.send(d.emailB, CQT.mail.topicInvite(p.A, p.B, topic, Demo.cab(p, 'B') + '&topic=' + topic.id));
      return { ok: true, id: p.id, t: p.tA, invite: Demo.cab(p, 'B') + '&topic=' + topic.id, tg: null };
    },
    invite: function (d) {
      var p = Demo.find(d);
      if (d.t !== p.tB || !p.A.answers) throw new Error('not_found');
      return { ok: true, nameA: p.A.name, nameB: p.B.name, emailB: p.B.email, genderB: p.B.gender || '', context: p.context || null, completed: !!p.completed };
    },
    portraitDone: function (p) {
      var r = CQA.report(p.A, p.B, { ctx: p.context, prev: p.prevPortrait || null });
      p.completed = true; p.doneAt = new Date().toLocaleDateString('ru'); Demo.save(p);
      Demo.send(p.A.email, CQA.mail.result(p.A, p.B, r.html, Demo.base() + '?r=' + p.id + '&t=' + p.tA, p.A.name, Demo.cab(p, 'A')));
      Demo.send(p.B.email, CQA.mail.result(p.A, p.B, r.html, Demo.base() + '?r=' + p.id + '&t=' + p.tB, p.B.name, Demo.cab(p, 'B')));
      return r.html;
    },
    complete: function (d) {
      var p = Demo.find(d);
      if (p.completed) throw new Error('already_completed');
      p.B = { name: d.nameB, email: d.emailB, gender: d.genderB || p.B.gender || '', answers: Demo.cleanPortrait(d.answers) };
      if (!p.context) p.context = CQA.cleanContext(d.context);
      return { ok: true, html: Demo.portraitDone(p) };
    },
    report: function (d) {
      var p = Demo.find(d);
      if (!p.completed) throw new Error('not_ready');
      return { ok: true, html: CQA.report(p.A, p.B, { ctx: p.context, prev: p.prevPortrait || null }).html };
    },
    context: function (d) {
      var p = Demo.find(d), c = CQA.cleanContext(d.context);
      if (!c) throw new Error('Ответьте на все вопросы о паре.');
      p.context = c; Demo.save(p);
      return { ok: true };
    },
    cabinet: function (d) {
      var p = Demo.find(d), me = Demo.role(p, d.t), other = me === 'A' ? 'B' : 'A', topics = {};
      Object.keys(p.talks).forEach(function (k) { var s = p.talks[k]; topics[k] = { me: !!s[me], partner: !!s[other], done: !!s.completed, was: !s.completed && s.last ? s.last.at : '' }; });
      return { ok: true, me: me, nameMe: p[me].name, namePartner: p[other].name, emailMe: p[me].email, genderMe: p[me].gender || '', genderPartner: p[other].gender || '', context: p.context || null, ai: false,
        portrait: p.retake ? { me: !!p.retake[me], partner: !!p.retake[other], done: false, was: p.doneAt || '' }
          : { me: !!p[me].answers, partner: !!p[other].answers, done: !!p.completed }, topics: topics,
        modules: (p.completed ? 1 : 0) + Object.keys(topics).filter(function (k) { return topics[k].done || topics[k].was; }).length,
        partnerLink: Demo.cab(p, other), tg: null }; // в демо бота нет
    },
    talkReport: function (p, id) {
      var mods = [], allA = {}, allB = {};
      function merge(dst, src) { Object.keys(src || {}).forEach(function (k) { dst[k] = src[k]; }); }
      if (p.completed) { mods.push('portrait'); merge(allA, p.A.answers); merge(allB, p.B.answers); }
      function doneOf(x) { return x.completed ? x : x.last || null; }
      Object.keys(p.talks).forEach(function (k) {
        var x = doneOf(p.talks[k]);
        if (k === id || !x) return;
        mods.push(k); merge(allA, x.A.a); merge(allB, x.B.a);
      });
      var cur = p.talks[id], s = doneOf(cur), last = cur.completed && cur.last;
      merge(allA, s.A.a); merge(allB, s.B.a);
      var X = { name: p.A.name, email: p.A.email, gender: p.A.gender, a: s.A.a, g: s.A.g, note: s.A.note, all: allA };
      var Y = { name: p.B.name, email: p.B.email, gender: p.B.gender, a: s.B.a, g: s.B.g, note: s.B.note, all: allB };
      var prev = last ? { at: last.at, X: { a: last.A.a, g: last.A.g }, Y: { a: last.B.a, g: last.B.g } } : null;
      var r = CQT.report(id, X, Y, { mods: mods, ctx: p.context, prev: prev });
      r.X = X; r.Y = Y;
      return r;
    },
    answer: function (d) {
      var p = Demo.find(d), me = Demo.role(p, d.t), other = me === 'A' ? 'B' : 'A';
      if (d.gender) p[me].gender = d.gender;
      if (d.kind === 'portrait') {
        if (p.completed && (d.retake || p.retake)) {
          p.retake = p.retake || {};
          if (p.retake[me]) return { ok: true, done: false };
          p.retake[me] = Demo.cleanPortrait(d.answers);
          if (!p.retake[other]) {
            Demo.save(p);
            Demo.send(p[other].email, CQT.mail.portraitInvite(p[me], p[other], Demo.cab(p, other) + '&go=portrait'));
            return { ok: true, done: false };
          }
          p.prevPortrait = { at: p.doneAt || '', A: p.A.answers, B: p.B.answers };
          p.A.answers = p.retake.A; p.B.answers = p.retake.B; delete p.retake;
          return { ok: true, done: true, html: Demo.portraitDone(p) };
        }
        if (p[me].answers) return p.completed ? { ok: true, done: true, html: CQA.report(p.A, p.B, { ctx: p.context }).html } : { ok: true, done: false };
        p[me].answers = Demo.cleanPortrait(d.answers);
        if (!p[other].answers) {
          Demo.save(p);
          Demo.send(p[other].email, CQT.mail.portraitInvite(p[me], p[other], Demo.cab(p, other) + '&go=portrait'));
          return { ok: true, done: false };
        }
        return { ok: true, done: true, html: Demo.portraitDone(p) };
      }
      var topic = CQT.topic(d.kind);
      if (!topic) throw new Error('bad_topic');
      var s = p.talks[topic.id] || (p.talks[topic.id] = {});
      if (s.completed && d.retake) s = p.talks[topic.id] = { last: { A: s.A, B: s.B, at: new Date().toLocaleDateString('ru') } };
      if (s[me]) return s.completed ? { ok: true, done: true, html: Demo.talkReport(p, topic.id).html } : { ok: true, done: false };
      s[me] = CQT.cleanTopic(topic, d, p.context);
      if (!s[other]) {
        Demo.save(p);
        Demo.send(p[other].email, CQT.mail.topicInvite(p[me], p[other], topic, Demo.cab(p, other) + '&topic=' + topic.id));
        return { ok: true, done: false };
      }
      s.completed = true; Demo.save(p);
      var r = Demo.talkReport(p, topic.id);
      Demo.send(p.A.email, CQT.mail.topicResult(r.X, r.Y, topic, r.html, Demo.cab(p, 'A') + '&topic=' + topic.id, p.A.name));
      Demo.send(p.B.email, CQT.mail.topicResult(r.X, r.Y, topic, r.html, Demo.cab(p, 'B') + '&topic=' + topic.id, p.B.name));
      return { ok: true, done: true, html: r.html };
    },
    talk: function (d) {
      var p = Demo.find(d), s = p.talks[d.topic];
      if (!s || !(s.completed || s.last)) throw new Error('not_ready');
      return { ok: true, html: Demo.talkReport(p, d.topic).html };
    }
  };

  var DemoUI = {
    el: null,
    init: function () {
      if (!DEMO) return;
      DemoUI.el = document.createElement('div');
      DemoUI.el.className = 'demo-bar';
      document.body.appendChild(DemoUI.el);
      DemoUI.refresh();
    },
    refresh: function () {
      if (!DemoUI.el) return;
      var n = Demo.mails().length;
      DemoUI.el.innerHTML = n ? '<button class="btn" type="button">✉ Демо-почта · ' + n + '</button>' : '';
      var b = DemoUI.el.querySelector('button');
      if (b) b.onclick = DemoUI.open;
    },
    open: function () {
      var mails = Demo.mails();
      var m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = '<div class="modal-box" role="dialog" aria-label="Демо-почта"><div class="modal-head"><b>Демо-почта — письма, которые ушли бы адресатам</b><button class="link" data-close>Закрыть</button></div>' +
        '<div class="modal-body"><ul class="mail-list">' + mails.map(function (x, i) {
          return '<li><button data-i="' + i + '"><b>' + esc(x.subject) + '</b><small>Кому: ' + esc(x.to) + ' · ' + esc(x.at) + '</small></button></li>';
        }).join('') + '</ul><p class="sub" style="padding:0 20px 16px"><button class="link" data-clear>Очистить демо-данные</button></p></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', function (e) {
        var t = e.target.closest('[data-i],[data-close],[data-clear],[data-back]');
        if (e.target === m || (t && t.hasAttribute('data-close'))) return m.remove();
        if (!t) return;
        if (t.hasAttribute('data-clear')) { ['cq_demo_mail', 'cq_demo_pairs', 'cq_cab'].forEach(store.del); m.remove(); DemoUI.refresh(); return; }
        if (t.hasAttribute('data-back')) { m.remove(); DemoUI.open(); return; }
        var x = mails[+t.getAttribute('data-i')];
        m.querySelector('.modal-head b').textContent = x.subject;
        m.querySelector('.modal-head').insertAdjacentHTML('afterbegin', '<button class="link" data-back>← Все письма</button>');
        var body = m.querySelector('.modal-body');
        body.innerHTML = '<iframe class="mail-frame" title="Письмо"></iframe>';
        var fr = body.querySelector('iframe');
        fr.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_top"><body style="margin:0">' + x.html + '</body>';
      });
    }
  };

  // ───────────────────────── маршрутизация
  // Мини-приложение без ссылки: по ссылке-приглашению (startapp) — в кабинет партнёра,
  // иначе — в кабинет пары, связанной с этим аккаунтом Telegram (один раз за запуск).
  function tgHome() {
    var rf = /^ref_([a-z0-9]{4,24})$/.exec(TG.sp);
    if (rf && !utm.ref) { utm.ref = rf[1]; utm.utm_source = utm.utm_source || 'referral'; store.set('cq_utm', utm); }
    var m = /^c-([a-z0-9]+)-([a-z0-9]+)(?:-([a-z0-9]+))?$/.exec(TG.sp);
    if (m && sess.get('cq_tg_sp') !== TG.sp) {
      sess.set('cq_tg_sp', TG.sp);
      return location.replace('?c=' + m[1] + '&t=' + m[2] + (m[3] === 'portrait' ? '&go=portrait' : m[3] ? '&topic=' + m[3] : ''));
    }
    if (sess.get('cq_tg_home')) return landing();
    sess.set('cq_tg_home', '1');
    spinner('Открываем…');
    api('tg_session', {}).then(function (r) {
      if (r.pairs.length === 1) return location.replace('?c=' + encodeURIComponent(r.pairs[0].id) + '&t=' + encodeURIComponent(r.pairs[0].t));
      if (!r.pairs.length) return landing();
      tgPick(r.pairs);
    }).catch(tgFail);
  }
  function tgFail(e) {
    if (e.message !== 'tg_auth') return landing();
    errorScreen('Не получилось войти через Telegram. Закройте приложение и откройте его снова из бота.', './');
  }
  function tgPick(pairs) {
    track('tg_pick');
    render('<section class="hero"><p class="eyebrow">Мы вдвоём</p><h1>Ваши пары</h1><p class="lead">Выберите кабинет — или начните с новым партнёром.</p></section>' +
      pairs.slice(-6).reverse().map(function (x) {
        return '<a class="banner" href="?c=' + encodeURIComponent(x.id) + '&t=' + encodeURIComponent(x.t) + '"><span><b>' + esc(x.nameMe) + ' и ' + esc(x.namePartner) + '</b>Кабинет пары</span><span class="arrow">→</span></a>';
      }).join('') +
      '<p style="margin-top:20px" class="tg-row"><button class="btn ghost" id="new">Начать с новым партнёром</button><button class="btn ghost" id="tg-find">Найти другие по почте</button></p>');
    on('#new', 'click', landing);
    on('#tg-find', 'click', tgFind);
  }
  // Пары с сайта связаны только с почтой: код на email связывает их с этим аккаунтом Telegram.
  function tgFind() {
    track('tg_find_view');
    render('<p class="crumbs"><a href="./">← Назад</a></p><form class="panel" id="f" novalidate><h2>Найти мои пары по почте</h2>' +
      '<p class="sub">Если вы уже проходили тесты на сайте, укажите почту, на которую приходили разборы. Пришлём код — и ваши кабинеты откроются здесь, в Telegram.</p>' +
      field('email', 'Ваш email', 'email', (store.get('cq_contact') || {}).emailSelf || '', 'email') +
      '<p class="error" id="err" hidden></p><button class="btn block" type="submit">Прислать код</button></form>');
    on('#f', 'submit', function (e) {
      e.preventDefault();
      var email = e.target.elements.email.value.trim(), err = $('#err');
      if (!emailRe.test(email)) { err.textContent = 'Проверьте адрес email.'; err.hidden = false; return; }
      spinner('Отправляем код…');
      api('tg_find', { email: email }).then(function () { tgCode(email); }).catch(function (x) { x.message === 'tg_auth' ? tgFail(x) : errorScreen(x.message, './'); });
    });
  }
  function tgCode(email) {
    render('<form class="panel" id="f" novalidate><h2>Введите код из письма</h2>' +
      '<p class="sub">Если на ' + esc(email) + ' проходили тесты, туда пришёл код из 6 цифр (проверьте «Спам»). Код действует 15 минут.</p>' +
      '<label class="field"><span>Код</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>' +
      '<p class="error" id="err" hidden></p><button class="btn block" type="submit">Подтвердить</button>' +
      '<div class="quiz-nav" style="margin-top:8px"><button class="link" type="button" id="again">Другой адрес</button><span></span></div></form>');
    on('#again', 'click', tgFind);
    on('#f', 'submit', function (e) {
      e.preventDefault();
      var b = e.target.querySelector('button[type=submit]'), err = $('#err');
      b.disabled = true; b.textContent = 'Проверяем код…'; err.hidden = true;
      api('tg_verify', { code: e.target.elements.code.value }).then(function (r) {
        track('tg_find_ok', { n: r.pairs.length });
        if (r.pairs.length === 1) return location.replace('?c=' + encodeURIComponent(r.pairs[0].id) + '&t=' + encodeURIComponent(r.pairs[0].t));
        if (!r.pairs.length) return errorScreen('Пар с этой почтой не нашлось. Проверьте адрес или начните новую пару.', './');
        tgPick(r.pairs);
      }).catch(function (x) { b.disabled = false; b.textContent = 'Подтвердить'; err.textContent = x.message; err.hidden = false; });
    });
  }

  function route() {
    DemoUI.init();
    if (TG && !params.get('c') && !params.get('p') && !params.get('r')) {
      tgHome();
    } else if (params.get('c') && params.get('t')) {
      S.pairId = params.get('c'); S.token = params.get('t'); S.ctx = 'cabinet';
      cabinet();
    } else if (params.get('p') && params.get('t')) {
      S.role = 'B'; S.ctx = 'invite'; S.pairId = params.get('p'); S.token = params.get('t');
      inviteLanding();
    } else if (params.get('r') && params.get('t')) {
      S.pairId = params.get('r'); S.token = params.get('t');
      reportView();
    } else {
      landing();
    }
  }

  // Внутри Telegram сначала подгружаем его библиотеку (кнопки, ссылки, разрешения), затем запускаемся.
  if (tgHash || sess.get('cq_tg_init')) {
    var started = false, go = function () { if (started) return; started = true; tgInit(); route(); };
    var sdk = document.createElement('script');
    sdk.src = 'https://telegram.org/js/telegram-web-app.js';
    sdk.onload = go; sdk.onerror = go;
    setTimeout(go, 4000);
    document.head.appendChild(sdk);
  } else {
    route();
  }
})();
