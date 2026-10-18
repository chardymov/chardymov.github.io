(function () {
  'use strict';

  var D = CQ_DATA, QS = D.questions;
  var BBY = {};
  D.blocks.forEach(function (b) { BBY[b.id] = b; });
  var app = document.getElementById('app');
  var esc = CQA.esc;
  var DEMO = !CONFIG.API_URL;
  var params = new URLSearchParams(location.search);

  // ───────────────────────── хранилище (может быть недоступно — тогда просто без сохранения)
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ───────────────────────── состояние
  var S = {
    role: 'A',          // A — заполняет первым, B — по приглашению
    pairId: null, token: null,
    invite: null,       // { nameA, nameB, emailB }
    answers: {}, idx: 0, skipSex: false
  };
  function progressKey() { return 'cq_progress_' + (S.pairId || 'new'); }
  function saveProgress() { store.set(progressKey(), { answers: S.answers, idx: S.idx, skipSex: S.skipSex }); }

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
  // такие ответы и сетевые сбои повторяем. Повтор безопасен: create защищён ключом rid,
  // а повторный complete вернёт already_completed.
  var RETRIES = 3;
  var NO_REPLY = 'Сервер не ответил. Попробуйте, пожалуйста, ещё раз через минуту.';
  function api(action, data, attempt) {
    attempt = attempt || 0;
    data = Object.assign({ action: action }, data);
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
  function errorScreen(msg) {
    render('<div class="panel center"><h2>Не получилось</h2><p>' + esc(msg) + '</p><a class="btn ghost" href="./">На главную</a></div>');
  }
  var LETTER = { a: 'А', b: 'Б', c: 'В', d: 'Г', e: 'Д' };
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // ───────────────────────── экраны
  function landing() {
    track('view_landing');
    var blocks = D.blocks.map(function (b) { return '<li>' + esc(b.title) + '</li>'; }).join('');
    render(
      '<section class="hero">' +
        '<p class="eyebrow">Тест для пар' + (DEMO ? '<span class="demo-badge">демо-режим</span>' : '') + '</p>' +
        '<h1>Насколько хорошо вы понимаете друг друга?</h1>' +
        '<p class="lead">' + QS.length + ' вопроса о вашей паре. Каждый отвечает отдельно, а потом вы оба получаете на почту психологический разбор: портреты, ваши опоры, зоны договорённостей и рекомендации.</p>' +
        startCta('Пройти тест', '≈ 10 минут · бесплатно') +
      '</section>' +
      '<ol class="steps">' +
        '<li><b>Вы отвечаете</b><span>Выбираете варианты, которые ближе всего вам. Правильных ответов нет.</span></li>' +
        '<li><b>Партнёр получает ссылку</b><span>Указываете email — свой и партнёра. Партнёр отвечает со своего телефона.</span></li>' +
        '<li><b>Разбор приходит обоим</b><span>Сравнение ответов, портреты, динамики пары и что с этим делать.</span></li>' +
      '</ol>' +
      '<h3>Что внутри</h3><ul class="chips">' + blocks + '</ul>' +
      '<p class="note">Блок о сексуальности можно пропустить. Ваши ответы попадут только в итоговый разбор, который получите вы и ваш партнёр.</p>'
    );
    bindStart();
  }

  function inviteLanding() {
    spinner('Загружаем приглашение…');
    api('invite', { id: S.pairId, t: S.token }).then(function (r) {
      S.invite = r;
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
        '<p class="note">Отвечайте самостоятельно и честно — так разбор будет точнее. Ответы ' + esc(r.nameA) + ' вы увидите только в итоговом разборе.</p>'
      );
      bindStart();
    }).catch(function (e) { errorScreen(e.message === 'not_found' ? 'Приглашение не найдено. Проверьте ссылку из письма.' : e.message); });
  }

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

    var qi = S.idx, answered = false;
    var pct = Math.round(100 * qi / QS.length);
    var cur = S.answers[q.id];
    var notice = S.notice ? '<p class="error">' + esc(S.notice) + '</p>' : '';
    S.notice = null;
    var opts = Object.keys(q.options).map(function (k) {
      return '<button class="opt' + (cur === k ? ' sel' : '') + '" data-k="' + k + '"><span class="k">' + LETTER[k] + '</span><span>' + esc(q.options[k]) + '</span></button>';
    }).join('');
    render(
      '<div class="quiz-head"><span><b>Блок ' + bl.n + '</b> · ' + esc(bl.title) + '</span><span>' + (S.idx + 1) + ' / ' + QS.length + '</span></div>' +
      '<div class="progress" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><div style="width:' + pct + '%"></div></div>' +
      notice + '<p class="q-text">' + esc(q.text) + '</p>' +
      '<div class="opts">' + opts + '</div>' +
      '<div class="quiz-nav">' + (S.idx > 0 ? '<button class="link" id="back">← Назад</button>' : '<span></span>') +
      (cur ? '<button class="link" id="next">Далее →</button>' : '') + '</div>'
    );
    app.querySelectorAll('.opt').forEach(function (b) {
      b.addEventListener('click', function () {
        // Повторный клик до перехода (двойной тап) не должен перескакивать следующий вопрос.
        if (answered) return;
        answered = true;
        app.querySelectorAll('.opt').forEach(function (x) { x.classList.remove('sel'); });
        b.classList.add('sel');
        S.answers[q.id] = b.getAttribute('data-k');
        var prevBlock = q.block;
        // При дозаполнении пропусков — сразу к следующему пропуску (или к форме).
        S.idx = S.fixing ? QS.length : qi + 1;
        saveProgress();
        if (S.idx < QS.length && QS[S.idx].block !== prevBlock) track('block_done', { block: prevBlock });
        setTimeout(showQuestion, 220);
      });
    });
    on('#back', 'click', function () { goBack(); });
    on('#next', 'click', function () { S.idx = S.fixing ? QS.length : qi + 1; saveProgress(); showQuestion(); });
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
      '<div class="progress"><div style="width:' + Math.round(100 * S.idx / QS.length) + '%"></div></div>' +
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
    var isB = S.role === 'B', inv = S.invite || {};
    var saved = store.get('cq_contact') || {};
    render(
      '<div class="quiz-head"><span><b>Почти готово</b></span><span>' + QS.length + ' / ' + QS.length + '</span></div>' +
      '<div class="progress"><div style="width:100%"></div></div>' +
      '<form class="panel" id="f" novalidate>' +
        (isB
          ? '<h2>Куда отправить разбор?</h2><p class="sub">Разбор придёт вам и ' + esc(inv.nameA) + ' сразу после отправки.</p>' +
            '<div class="grid2">' +
              field('nameSelf', 'Ваше имя', 'text', inv.nameB || '', 'given-name') +
              field('emailSelf', 'Ваш email', 'email', inv.emailB || '', 'email') +
            '</div>'
          : '<h2>Кому отправить?</h2><p class="sub">Вам придут ваши ответы, а партнёру — ссылка, чтобы ответить со своей стороны.</p>' +
            '<div class="grid2">' +
              field('nameSelf', 'Ваше имя', 'text', saved.nameSelf || '', 'given-name') +
              field('emailSelf', 'Ваш email', 'email', saved.emailSelf || '', 'email') +
              field('namePartner', 'Имя партнёра', 'text', '', 'off') +
              field('emailPartner', 'Email партнёра', 'email', '', 'off') +
            '</div>') +
        '<label class="hp" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label>' +
        '<label class="check"><input type="checkbox" name="consent"><span>Мне есть 18 лет. Я согласен(на), что мои ответы будут сохранены, обработаны (в том числе автоматически, с помощью ИИ) и включены в разбор, который получим я и мой партнёр.</span></label>' +
        '<p class="error" id="err" hidden></p>' +
        '<button class="btn block" type="submit">' + (isB ? 'Получить разбор' : 'Отправить') + '</button>' +
        '<div class="quiz-nav" style="margin-top:8px"><button class="link" type="button" id="back">← Вернуться к вопросам</button><span></span></div>' +
      '</form>'
    );
    on('#back', 'click', function () { S.idx = QS.length; goBack(); });
    on('#f', 'submit', function (e) {
      e.preventDefault();
      var f = e.target, v = function (n) { return (f.elements[n] && f.elements[n].value || '').trim(); };
      var err = $('#err');
      function fail(m) { err.textContent = m; err.hidden = false; }
      if (!v('nameSelf')) return fail('Укажите ваше имя.');
      if (!emailRe.test(v('emailSelf'))) return fail('Проверьте ваш email.');
      if (!isB) {
        if (!v('namePartner')) return fail('Укажите имя партнёра.');
        if (!emailRe.test(v('emailPartner'))) return fail('Проверьте email партнёра.');
        if (v('emailPartner').toLowerCase() === v('emailSelf').toLowerCase()) return fail('Email партнёра должен отличаться от вашего.');
      }
      if (!f.elements.consent.checked) return fail('Подтвердите согласие, чтобы продолжить.');
      if (v('website')) return; // бот
      if (firstMissing() >= 0) return details();
      store.set('cq_contact', { nameSelf: v('nameSelf'), emailSelf: v('emailSelf') });
      if (isB) submitB(v('nameSelf'), v('emailSelf'));
      else submitA(v('nameSelf'), v('emailSelf'), v('namePartner'), v('emailPartner'));
    });
  }
  function field(name, label, type, val, ac) {
    return '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + type + '" value="' + esc(val) + '" autocomplete="' + ac + '"' + (type === 'email' ? ' inputmode="email"' : '') + ' maxlength="80" required></label>';
  }

  function submitA(nameA, emailA, nameB, emailB) {
    spinner('Отправляем ответы и приглашение…');
    api('create', { rid: rid(), nameA: nameA, emailA: emailA, nameB: nameB, emailB: emailB, answers: S.answers, meta: { utm: utm, sid: sid } })
      .then(function () {
        track('submit_a');
        store.del(progressKey());
        var me = { name: nameA, answers: S.answers };
        render(
          '<div class="center"><div class="okmark">✓</div><h2>Готово!</h2>' +
          '<p>Ваши ответы отправлены на <b>' + esc(emailA) + '</b>, а <b>' + esc(nameB) + '</b> получит приглашение на ' + esc(emailB) + '.<br>Как только партнёр ответит, разбор придёт вам обоим.</p>' +
          (DEMO ? '<p class="sub">Демо-режим: письма не отправляются, их можно посмотреть в «Демо-почте» внизу справа.</p>' : '<p class="sub">Не видите письмо? Проверьте папку «Спам» и «Промоакции».</p>') +
          '</div>' +
          '<h2 style="margin-top:32px">Пока ждёте — ваш личный портрет</h2>' +
          '<div class="paper">' + CQA.portraitHtml(me) + '</div>'
        );
      })
      .catch(function (e) {
        // Ответ мог потеряться уже после отправки писем — не провоцируем повторную отправку.
        errorScreen(e.message === NO_REPLY
          ? 'Сервер не успел ответить, но ответы могли уйти. Проверьте почту ' + emailA + ' (и «Спам»): если письмо с вашими ответами пришло, всё в порядке — партнёр уже получил приглашение. Если письма нет через 5 минут, отправьте ответы ещё раз.'
          : e.message);
      });
  }

  function submitB(nameB, emailB) {
    spinner('Сравниваем ваши ответы и готовим разбор…');
    api('complete', { id: S.pairId, t: S.token, nameB: nameB, emailB: emailB, answers: S.answers })
      .then(function (r) {
        track('submit_b');
        store.del(progressKey());
        showReport(r.html, 'Разбор готов и отправлен вам обоим на почту.');
      })
      .catch(function (e) {
        if (e.message !== 'already_completed') return errorScreen(e.message);
        // Ответы уже приняты (например, первый запрос дошёл, а ответ потерялся) — просто показываем разбор.
        store.del(progressKey());
        api('report', { id: S.pairId, t: S.token })
          .then(function (r) { showReport(r.html, 'Разбор готов и отправлен вам обоим на почту.'); })
          .catch(function () { errorScreen('Ваши ответы приняты, разбор отправлен на почту.'); });
      });
  }

  function showReport(html, note) {
    render((note ? '<div class="center"><div class="okmark">✓</div><p>' + esc(note) + '</p></div>' : '') + '<div class="paper">' + html + '</div>' +
      '<div class="center" style="margin-top:28px"><p class="sub">Хотите пройти тест с кем-то ещё или повторить через пару месяцев?</p><a class="btn ghost" href="./">Пройти тест заново</a></div>');
  }

  function reportView() {
    spinner('Загружаем разбор…');
    api('report', { id: S.pairId, t: S.token })
      .then(function (r) { track('view_report'); showReport(r.html); })
      .catch(function (e) { errorScreen(e.message === 'not_ready' ? 'Партнёр ещё не ответил — разбор появится, как только это произойдёт.' : e.message === 'not_found' ? 'Разбор не найден. Проверьте ссылку из письма.' : e.message); });
  }

  // ───────────────────────── демо-бэкенд (localStorage) — для проверки без Apps Script
  var Demo = {
    pairs: function () { return store.get('cq_demo_pairs') || {}; },
    save: function (p) { store.set('cq_demo_pairs', p); },
    mails: function () { return store.get('cq_demo_mail') || []; },
    send: function (to, m) { var l = Demo.mails(); l.unshift({ to: to, subject: m.subject, html: m.html, at: new Date().toLocaleTimeString('ru') }); store.set('cq_demo_mail', l.slice(0, 30)); DemoUI.refresh(); },
    rnd: function () { return Math.random().toString(36).slice(2, 10); },
    base: function () { return location.origin + location.pathname; },
    call: function (d) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          try { resolve(Demo[d.action](d)); } catch (e) { reject(e); }
        }, 500);
      });
    },
    create: function (d) {
      var all = Demo.pairs(), id = Demo.rnd();
      var p = { id: id, tA: Demo.rnd(), tB: Demo.rnd(), A: { name: d.nameA, email: d.emailA, answers: d.answers }, B: { name: d.nameB, email: d.emailB } };
      all[id] = p; Demo.save(all);
      Demo.send(d.emailA, CQA.mail.initiator(p.A, p.B));
      Demo.send(d.emailB, CQA.mail.invite(p.A, p.B, Demo.base() + '?p=' + id + '&t=' + p.tB));
      return { ok: true, id: id };
    },
    find: function (d) {
      var p = Demo.pairs()[d.id];
      if (!p || (d.t !== p.tA && d.t !== p.tB)) throw new Error('not_found');
      return p;
    },
    invite: function (d) {
      var p = Demo.find(d);
      return { ok: true, nameA: p.A.name, nameB: p.B.name, emailB: p.B.email, completed: !!p.B.answers };
    },
    complete: function (d) {
      var all = Demo.pairs(), p = Demo.find(d);
      if (p.B.answers) throw new Error('already_completed');
      p.B = { name: d.nameB, email: d.emailB, answers: d.answers };
      all[p.id] = p; Demo.save(all);
      var r = CQA.report(p.A, p.B);
      Demo.send(p.A.email, CQA.mail.result(p.A, p.B, r.html, Demo.base() + '?r=' + p.id + '&t=' + p.tA, p.A.name));
      Demo.send(p.B.email, CQA.mail.result(p.A, p.B, r.html, Demo.base() + '?r=' + p.id + '&t=' + p.tB, p.B.name));
      return { ok: true, html: r.html };
    },
    report: function (d) {
      var p = Demo.find(d);
      if (!p.B.answers) throw new Error('not_ready');
      return { ok: true, html: CQA.report(p.A, p.B).html };
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
        if (t.hasAttribute('data-clear')) { store.del('cq_demo_mail'); store.del('cq_demo_pairs'); m.remove(); DemoUI.refresh(); return; }
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
  DemoUI.init();
  if (params.get('p') && params.get('t')) {
    S.role = 'B'; S.pairId = params.get('p'); S.token = params.get('t');
    inviteLanding();
  } else if (params.get('r') && params.get('t')) {
    S.pairId = params.get('r'); S.token = params.get('t');
    reportView();
  } else {
    landing();
  }
})();
