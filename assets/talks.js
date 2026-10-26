/*
 * Движок раздела «Разговоры»: разбор одной темы с учётом портрета пары и прошлых тем.
 * Чистые функции без DOM — файл исполняется и в браузере, и в Google Apps Script.
 * Зависит от CQ_DATA (questions.js), CQ_TOPICS (topics.js) и CQA (analysis.js).
 *
 * Участник разговора:
 *   { name, a: { r1: ['a','c'], … }, g: { r2: ['b'], … }, note: 'фраза партнёру',
 *     all: { 1: 'a', 3: ['a','f'], r1: [...], s2: [...] } }  // все ответы из модулей, пройденных обоими
 *   a — ответы по текущей теме, g — догадки об ответах партнёра.
 * ctx.mods — модули, которые пара прошла целиком ('portrait', 'roots', …), включая текущую тему.
 */
var CQT = (function (DATA, TOP, A) {
  'use strict';

  var C = A.colors, FONT = A.font, esc = A.esc, fill = A.fill, h2 = A.h2, p = A.p, muted = A.muted, card = A.card;
  var arr = A.arr, inter = A.inter, sameSet = A.sameSet, mean = A.mean, joinAnd = A.joinAnd, G = A.genderize;

  var TOPICS = TOP.topics, TBY = {}, REG = {};
  DATA.questions.forEach(function (q) { REG[String(q.id)] = { q: q, mod: 'portrait' }; });
  TOPICS.forEach(function (t) {
    TBY[t.id] = t;
    t.questions.forEach(function (q) { REG[q.id] = { q: q, mod: t.id }; });
  });
  var LAYER_ORDER = { far: 0, past: 1, us: 2 };

  // «Мечты и „если бы“» — вложенные кавычки-лапки
  function quoted(t) { return '«' + String(t).replace(/«/g, '„').replace(/»/g, '“') + '»'; }
  function modTitle(mod) { return mod === 'portrait' ? 'портрет пары' : 'тема ' + quoted(TBY[mod].title); }

  // ───────────────────────── проверка ответов (общая для сайта в демо-режиме и бэкенда)
  function maxPick(q) { return q.multi || 1; }
  function cleanKeys(q, v) {
    var out = [];
    arr(v).forEach(function (k) {
      k = String(k);
      if (q.options[k] && out.indexOf(k) < 0) out.push(k);
    });
    out = out.slice(0, maxPick(q));
    if (!out.length) return null;
    return maxPick(q) > 1 ? out : out[0];
  }
  function cleanNote(s) {
    // Без начальных = + - @ — чтобы значение не стало формулой в таблице.
    return String(s || '').replace(/[<>\u0000-\u0008\u000b-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, 300);
  }
  // Ответы на тему: { a, g, note }. Вопросы можно пропускать, но не больше половины.
  function cleanTopic(topic, d, pairCtx) {
    var a = {}, g = {}, n = 0;
    d = d || {};
    var qs = topic.questions.filter(function (q) { return A.adapt(q, pairCtx) !== null; });
    qs.forEach(function (q) {
      var v = cleanKeys(q, d.answers && d.answers[q.id]);
      if (v) { a[q.id] = v; n++; }
      if (q.guess && v) {
        var gv = cleanKeys(q, d.guesses && d.guesses[q.id]);
        if (gv) g[q.id] = gv;
      }
    });
    if (n < Math.ceil(qs.length / 2)) throw new Error('Ответьте, пожалуйста, хотя бы на половину вопросов.');
    return { a: a, g: g, note: cleanNote(d.note) };
  }

  // ───────────────────────── ответы
  function keys(map, id) { return arr(map && map[String(id)]); }
  function has(map, id, set) { return keys(map, id).some(function (k) { return set.indexOf(k) >= 0; }); }
  // Пока строится разбор — контекст пары (вопросы и варианты показываются с учётом подстройки).
  var CUR = null;
  function qv(q) { return CUR ? A.adapt(q, CUR) || q : q; }
  function optText(id, ks) {
    var q = qv(REG[String(id)].q), base = REG[String(id)].q;
    ks = arr(ks);
    return ks.length ? ks.map(function (k) { return q.options[k] || base.options[k]; }).join('; ') : '—';
  }

  // ───────────────────────── оси: портрет + темы
  var DEEP = {
    anx: { title: 'Спокойствие ↔ тревога в близости', lo: 'спокойствие', hi: 'тревога',
      hiT: '{X} остро чувствует всё, что может угрожать связи: отказ, холодность, дистанцию. Это не «мнительность», а чувствительность — ей особенно помогают ясные слова и предсказуемость.',
      midT: '{X} в целом спокойно чувствует себя в отношениях, но в некоторых ситуациях тревога просыпается — важно знать, в каких.',
      loT: '{X} чувствует себя в отношениях спокойно и уверенно: отказ или пауза не воспринимаются как угроза. Это ресурс для пары — и повод внимательнее относиться к тревоге партнёра, если она есть.' },
    self: { title: 'Опора на партнёра ↔ опора на себя', lo: 'на партнёра', hi: 'на себя',
      hiT: '{X} привык(ла) справляться сам(а) и не нагружать других. Это делает человека надёжным, но в трудную минуту партнёр может даже не узнать, что нужна помощь.',
      midT: '{X} умеет и справляться сам(а), и опираться на партнёра — в зависимости от ситуации.',
      loT: '{X} легко делится трудностями и опирается на партнёра. Это знак доверия; важно лишь, чтобы и у партнёра оставались силы.' },
    novel: { title: 'Стабильность ↔ новизна', lo: 'стабильность', hi: 'новизна',
      hiT: '{X} подпитывается новым: места, проекты, впечатления. Рутина для такого человека быстро становится тесной.',
      midT: '{X} ценит и привычный уклад, и новые впечатления — в разумной пропорции.',
      loT: '{X} ценит стабильность и предсказуемость: дом, привычные ритуалы, понятное завтра. Перемены — только когда в них есть смысл.' },
    recog: { title: 'Потребность в признании', lo: 'спокойная', hi: 'высокая',
      hiT: '{X} особенно нуждается в том, чтобы его (её) замечали и ценили: слова признания, гордость, интерес к делам. Без этого даже большая любовь может казаться невидимой.',
      midT: '{X} ценит признание, но не зависит от него.',
      loT: '{X} не нуждается в постоянном подтверждении — признание приятно, но не обязательно.' }
  };
  var AXES = {};
  Object.keys(A.axes).forEach(function (k) { AXES[k] = A.axes[k]; });
  Object.keys(DEEP).forEach(function (k) { AXES[k] = DEEP[k]; });
  var TALK_AXES = ['anx', 'self', 'open', 'close', 'novel', 'recog'];

  function axisScore(map, ax) {
    var sum = 0, n = 0;
    Object.keys(REG).forEach(function (id) {
      var q = REG[id].q;
      if (!q.ax || !q.ax[ax]) return;
      var v = mean(keys(map, id).map(function (k) { return q.ax[ax][k]; }));
      if (v != null) { sum += v; n++; }
    });
    return n ? sum / n : null;
  }

  // ───────────────────────── догадки
  function guessRes(guess, actual) {
    guess = arr(guess); actual = arr(actual);
    if (!guess.length || !actual.length) return null;
    if (sameSet(guess, actual)) return 'hit';
    return inter(guess, actual).length ? 'part' : 'miss';
  }
  var GUESS_PTS = { hit: 1, part: 0.5, miss: 0 };
  function guessScore(topic, X, Y) {
    var pts = 0, n = 0;
    topic.questions.forEach(function (q) {
      var r = guessRes(X.g[q.id], Y.a[q.id]);
      if (r) { pts += GUESS_PTS[r]; n++; }
    });
    return { pts: pts, n: n, pct: n ? Math.round(100 * pts / n) : null };
  }

  // ───────────────────────── сквозные наблюдения
  function condsHold(conds, map) {
    return (conds || []).every(function (c) { return has(map, c[0], c[1]); });
  }
  function crossNotes(topic, X, Y, mods) {
    var out = [], seen = {};
    var P = [[X, Y], [Y, X]];
    TOPICS.forEach(function (t) {
      (t.links || []).forEach(function (l) {
        var refs = l.x.concat(l.y || []).map(function (c) { return REG[String(c[0])]; });
        if (refs.some(function (r) { return !r || mods.indexOf(r.mod) < 0; })) return;
        if (!refs.some(function (r) { return r.mod === topic.id; })) return;
        var sym = l.y && JSON.stringify(l.x) === JSON.stringify(l.y);
        P.forEach(function (pp, i) {
          if (sym && i) return;
          var x = pp[0], y = pp[1];
          if (!condsHold(l.x, x.all) || !condsHold(l.y, y.all)) return;
          var key = l.text + '|' + x.name;
          if (seen[key]) return;
          seen[key] = 1;
          var other = [];
          refs.forEach(function (r) { if (r.mod !== topic.id && other.indexOf(r.mod) < 0) other.push(r.mod); });
          out.push({
            level: l.level || 'mid',
            tag: other.length ? 'Связь: ' + other.map(modTitle).join(', ') : 'Внутри темы',
            text: G(fill(esc(l.text), x.name, y.name), [x, y]), rec: l.rec ? G(fill(esc(l.rec), x.name, y.name), [x, y]) : '', cross: !!other.length
          });
        });
      });
    });
    // «Чего мне не хватает» ↔ «что я сам(а) перестал(а) делать»
    if (topic.mirror) {
      var miss = topic.mirror[0], stop = topic.mirror[1], qs = REG[stop].q;
      P.forEach(function (pp) {
        var x = pp[0], y = pp[1];
        var want = keys(x.a, miss).filter(function (k) { return k !== 'g'; }), quit = keys(y.a, stop);
        if (!want.length || !quit.length) return;
        var both = inter(want, quit);
        if (both.length)
          out.push({ level: 'good', tag: 'Внутри темы', cross: false,
            text: G(fill('{X} скучает по тому, что было в начале, — и {Y} сам(а) замечает, что перестал(а) ' + esc(joinAnd(both.map(function (k) { return qs.options[k]; }))) + '. Вы видите одно и то же — значит, это легко вернуть.', x.name, y.name), [x, y]), rec: '' });
        else if (quit.indexOf('g') >= 0)
          out.push({ level: 'mid', tag: 'Внутри темы', cross: false,
            text: G(fill('{X} скучает по тому, что партнёр делал в начале, а {Y} считает, что ничего не перестал(а) делать. Это не упрёк — просто то, что видно только со стороны.', x.name, y.name), [x, y]), rec: '' });
      });
    }
    var rank = { high: 0, mid: 1, good: 2 };
    out.sort(function (a, b) { return (b.cross - a.cross) || rank[a.level] - rank[b.level]; });
    return out.slice(0, 6); // больше — уже не читается
  }

  // ───────────────────────── план разговора
  var REASON_W = { miss: 3, opposite: 2.5, differ: 2, part: 1.5, close: 1, match: 0.5 };
  function conversation(topic, X, Y) {
    var cand = [];
    topic.questions.forEach(function (q, i) {
      var x = keys(X.a, q.id), y = keys(Y.a, q.id);
      if (!q.talk || !x.length || !y.length) return;
      var rel = A.relation(q, x, y) || 'differ';
      var gx = guessRes(X.g[q.id], y), gy = guessRes(Y.g[q.id], x);
      // why — готовый HTML (имена выделены жирным)
      var best = { w: REASON_W[rel], why: rel === 'match' ? 'Вы ответили одинаково — расскажите друг другу почему' : rel === 'close' ? 'Ваши ответы похожи, но не совпали' : 'Вы ответили по-разному' };
      [[gx, X], [gy, Y]].forEach(function (g) {
        if (g[0] && g[0] !== 'hit' && REASON_W[g[0]] > best.w)
          best = { w: REASON_W[g[0]], why: G(fill(g[0] === 'miss' ? '{X} ожидал(а) совсем другого ответа' : '{X} угадал(а) лишь отчасти', g[1].name), [g[1]]) };
      });
      cand.push({ q: q, i: i, w: best.w, why: best.why });
    });
    cand.sort(function (a, b) { return b.w - a.w || a.i - b.i; });
    var pick = cand.slice(0, 5);
    pick.sort(function (a, b) { return LAYER_ORDER[a.q.layer] - LAYER_ORDER[b.q.layer] || a.i - b.i; });
    var list = [];
    if (topic.talks && topic.talks.length) list.push({ text: esc(topic.talks[0]), why: 'Для разогрева' });
    pick.forEach(function (c) { list.push({ text: esc(c.q.talk), why: c.why, about: qv(c.q).text }); });
    var extra = 1;
    while (list.length < 6 && topic.talks && extra < topic.talks.length) list.push({ text: esc(topic.talks[extra++]), why: '' });
    return list;
  }

  // ───────────────────────── HTML-кирпичики
  function tag(text, color) {
    return '<div style="font:600 11px/1 ' + FONT + ';letter-spacing:.06em;text-transform:uppercase;color:' + color + ';margin:0 0 8px">' + text + '</div>';
  }
  var GUESS_MARK = {
    hit: '<span style="color:' + C.good + '">✓ угадано</span>',
    part: '<span style="color:' + C.warn + '">≈ отчасти</span>',
    miss: '<span style="color:' + C.bad + '">✗ мимо</span>'
  };
  var REL_TAG = { match: ['совпало', C.good], close: ['похоже', C.good], differ: ['по-разному', C.warn], opposite: ['очень по-разному', C.bad] };

  function guessBlock(topic, X, Y) {
    var gx = guessScore(topic, X, Y), gy = guessScore(topic, Y, X);
    if (!gx.n && !gy.n) return '';
    function row(P0, g, color) {
      if (!g.n) return '';
      var pts = String(g.pts).replace('.', ',');
      return '<div style="margin:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="font:500 14px/1.4 ' + FONT + ';color:' + color + '">' + esc(P0.name) + ' угадывает</td>' +
        '<td style="font:600 14px/1.4 ' + FONT + ';color:' + C.ink + ';text-align:right;white-space:nowrap">' + pts + ' из ' + g.n + '</td></tr></table>' +
        '<div style="height:10px;background:' + C.line + ';border-radius:6px"><div style="width:' + Math.max(3, g.pct) + '%;height:10px;background:' + color + ';border-radius:6px"></div></div></div>';
    }
    var avg = mean([gx.pct, gy.pct]);
    var t = avg >= 70 ? 'Вы хорошо чувствуете друг друга в этой теме. Интересно проверить, на чём держится это понимание — и где оно всё-таки промахивается.'
      : avg >= 40 ? 'Где-то вы угадываете друг друга точно, где-то промахиваетесь. Промахи — самое интересное: с них и стоит начать разговор.'
        : 'В этой теме вы знаете друг друга меньше, чем, возможно, думали. Это не плохо: значит, вам есть что узнать друг о друге. Именно для этого и стоит поговорить.';
    return h2('Насколько вы знаете друг друга') + card(row(X, gx, C.a) + row(Y, gy, C.b) + p(t, 'margin:0') +
      muted('<br>Полное совпадение догадки — 1 балл, частичное — половина.'));
  }

  function notesBlock(X, Y) {
    var notes = [[X, C.a], [Y, C.b]].filter(function (n) { return n[0].note; });
    if (!notes.length) return '';
    return h2('Слова друг другу') + notes.map(function (n) {
      return card(tag(esc(n[0].name) + ' хочет сказать', n[1]) +
        '<div style="font:500 17px/1.5 Georgia,serif;color:' + C.ink + '">«' + esc(n[0].note) + '»</div>', C.soft, C.line);
    }).join('');
  }

  function crossBlock(notes) {
    if (!notes.length) return '';
    var S = {
      high: { bg: C.badSoft, bd: '#efc9c5', tc: C.bad }, mid: { bg: C.warnSoft, bd: '#f0dbb6', tc: C.warn }, good: { bg: C.goodSoft, bd: '#c8e6d2', tc: C.good }
    };
    return h2('Что видно, если сложить всё вместе') +
      muted('Эти наблюдения связывают ответы на эту тему с вашим портретом и другими темами, которые вы прошли вдвоём.') +
      notes.map(function (n) {
        var s = S[n.level];
        return card(tag(esc(n.tag), s.tc) + p(n.text, 'margin-bottom:' + (n.rec ? '10px' : '0')) +
          (n.rec ? '<p style="font:400 14px/1.55 ' + FONT + ';color:' + C.ink + ';margin:0;padding:10px 12px;background:rgba(255,255,255,.7);border-radius:10px"><b>Что попробовать:</b> ' + n.rec + '</p>' : ''),
          s.bg, s.bd);
      }).join('');
  }

  function convBlock(list) {
    return h2('Вечер разговора') +
      p('Выберите спокойный вечер без телефонов. Задавайте вопросы по очереди, от первого к последнему — они идут от лёгких к глубоким. Главное правило: слушающий не спорит и не оправдывается, а спрашивает «расскажи ещё».') +
      card('<ol style="margin:0;padding:0 0 0 20px">' + list.map(function (it) {
        return '<li style="font:500 16px/1.5 ' + FONT + ';color:' + C.ink + ';margin:0 0 14px">' + it.text +
          (it.why ? '<div style="font:400 13px/1.45 ' + FONT + ';color:' + C.muted + ';margin-top:3px">' + it.why + (it.about ? ' · «' + esc(it.about) + '»' : '') + '</div>' : '') + '</li>';
      }).join('') + '</ol>', C.accentSoft, '#efcfdb');
  }

  function answersBlock(topic, X, Y) {
    var html = h2('Ваши ответы рядом');
    topic.questions.forEach(function (q) {
      var x = keys(X.a, q.id), y = keys(Y.a, q.id);
      if (!x.length && !y.length) return;
      var rel = A.relation(q, x, y), rt = rel && REL_TAG[rel];
      function line(P0, mine, other, color) {
        var g = q.guess && keys(other.g, q.id), r = g && g.length ? guessRes(g, mine) : null;
        return '<div style="font:400 14px/1.5 ' + FONT + ';margin:0 0 4px"><b style="color:' + color + '">' + esc(P0.name) + ':</b> ' + esc(mine.length ? optText(q.id, mine) : 'пропущено') + '</div>' +
          (r ? '<div style="font:400 13px/1.45 ' + FONT + ';color:' + C.muted + ';margin:0 0 8px 12px">' + esc(other.name) + ' ' + G('предполагал(а)', [], other) + ': ' + esc(optText(q.id, g)) + ' — ' + GUESS_MARK[r] + '</div>' : '');
      }
      html += card(
        '<div style="font:400 12px/1.4 ' + FONT + ';color:' + C.muted + ';margin:0 0 4px">' + esc(TOP.layers[q.layer] || '') +
          (rt ? ' · <span style="color:' + rt[1] + '">' + rt[0] + '</span>' : '') + '</div>' +
        '<div style="font:600 15px/1.4 ' + FONT + ';color:' + C.ink + ';margin:0 0 8px">' + esc(qv(q).text) + '</div>' +
        line(X, x, Y, C.a) + line(Y, y, X, C.b));
    });
    return html;
  }

  // Сводка по осям — о паре целиком, а не о каждом по отдельности. Для каждой оси один из вариантов:
  // gap — вы заметно расходитесь ({X} — тот, кто ближе к «hi»), hi / lo — вы оба у одного края, mid — оба посередине.
  var PAIR_AX = {
    anx: {
      gap: '{X} острее чувствует всё, что может угрожать вашей связи, а {Y} в отношениях спокойнее. Пауза или холодный тон, которые один почти не заметит, другого могут сильно встревожить.',
      gapRec: 'Ясные слова помогают обоим: «я злюсь, но я с тобой», «мне нужно время, но я вернусь к разговору».',
      hi: 'Вы оба чутко реагируете на всё, что может угрожать связи. Это делает вас внимательными друг к другу, но в ссоре тревога легко передаётся от одного к другому и растёт.',
      hiRec: 'Договоритесь о фразах-опорах, которые вы говорите друг другу даже посреди спора.',
      lo: 'Вы оба чувствуете себя в отношениях спокойно и уверенно: пауза или отказ не воспринимаются как угроза. Это большой ресурс — главное, чтобы спокойствие не превращалось в «и так всё понятно».',
      mid: 'Вы оба в целом спокойны в отношениях, но у каждого есть ситуации, где просыпается тревога. Полезно знать такие ситуации друг у друга.' },
    self: {
      gap: '{X} привык(ла) справляться сам(а), а {Y} легче опирается на партнёра. Одному может казаться, что его не пускают внутрь, другому — что от него ждут слишком многого.',
      gapRec: 'Спрашивайте прямо: «Тебе помочь или просто побыть рядом?» — и принимайте любой ответ.',
      hi: 'Вы оба привыкли справляться сами. Это делает вас надёжной парой, но двум самостоятельным людям трудно попросить о помощи — и легко остаться с трудностями поодиночке.',
      hiRec: 'Раз в неделю спрашивайте друг друга: «С чем тебе сейчас трудно?» — и не спешите с советами.',
      lo: 'Вы оба легко опираетесь друг на друга и делитесь трудностями. Это знак доверия; важно только, чтобы у каждого оставались и свои источники сил.',
      mid: 'Вы оба умеете и справляться сами, и опираться друг на друга — в зависимости от ситуации. Хороший баланс, который стоит беречь.' },
    open: {
      gap: '{X} говорит о недовольстве прямо и быстро, а {Y} скорее держит переживания в себе. Один ждёт ясности, другой — бережности: прямота может казаться резкостью, а молчание — обидой.',
      gapRec: 'Договоритесь о сроке: о том, что задело, говорим в течение суток — и начинаем с вопроса «тебе сейчас удобно поговорить?».',
      hi: 'Вы оба говорите о чувствах и недовольстве прямо. Гадать почти не приходится — зато в горячий момент двое прямых людей легко переходят на резкость.',
      hiRec: 'Правило паузы в споре пригодится вам обоим.',
      lo: 'Вы оба скорее держите переживания в себе. Это бережно, но невысказанное копится у обоих — и никто не начинает разговор первым.',
      loRec: 'Заведите короткий вопрос раз в неделю: «Было ли что-то, что тебя задело?»',
      mid: 'Вы оба умеете говорить о неприятном, но сначала даёте себе остыть. Бережный стиль — главное, чтобы пауза не растягивалась надолго.' },
    close: {
      gap: '{X} подпитывается совместностью, а {Y} высоко ценит личное пространство. Это одно из самых частых различий в парах: одному не хватает «нас», другому — «меня».',
      gapRec: 'Планируйте и то и другое: общий вечер и время каждого для себя — без чувства вины.',
      hi: 'Вы оба подпитываетесь совместностью: много времени вместе, делиться, быть в курсе жизни друг друга. Близость — ваш общий ресурс.',
      lo: 'Вы оба высоко цените личное пространство. Вам легко не мешать друг другу — важно лишь не разойтись в параллельные жизни.',
      loRec: 'Заведите один «наш» ритуал в неделю, который вы не отменяете.',
      mid: 'Вам обоим нужны и общие вечера, и время для себя. Хороший баланс — следите только, чтобы одно не вытесняло другое.' },
    novel: {
      gap: '{X} подпитывается новым, а {Y} ценит стабильность и привычный уклад. Одному может быть тесно в рутине, другому — тревожно от перемен.',
      gapRec: 'Пусть новое приходит дозированно: одно новое впечатление в месяц, выбранное вместе.',
      hi: 'Вы оба любите новое — места, проекты, впечатления. С вами не скучно, но рутина быстро становится тесной для обоих.',
      lo: 'Вы оба цените стабильность и привычные ритуалы. Это даёт покой; иногда стоит устраивать маленькие перемены, чтобы отношения не застыли.',
      mid: 'Вы оба цените и привычный уклад, и новые впечатления. Вам легко договориться, сколько нового нужно паре.' },
    recog: {
      gap: '{X} особенно нуждается в признании — словах, гордости, интересе к делам, а {Y} может обходиться без постоянного подтверждения. Поэтому {Y} легко недодаёт того, что самому (самой) не так нужно.',
      gapRec: 'Одна конкретная похвала в день — не «молодец», а «мне понравилось, как ты…».',
      hi: 'Вам обоим важно, чтобы вас замечали и ценили. Когда оба ждут признания, его может не хватать обоим — попробуйте отдавать первыми.',
      lo: 'Вы оба не нуждаетесь в постоянном подтверждении — признание приятно, но не обязательно. Иногда всё же стоит говорить вслух то, что кажется очевидным.',
      mid: 'Вы оба цените признание, но не зависите от него. Тёплые слова для вас — приятный бонус, а не условие.' }
  };
  var AX_GAP = 0.25, AX_LEAN = 0.12, AX_SHIFT = 0.12;
  // Подписи краёв во фразах «ближе к краю …» (где короткие подписи шкалы звучат неуклюже).
  var EDGE = { self: { hi: 'опора на себя', lo: 'опора на партнёра' }, recog: { hi: 'нужно признание', lo: 'признание не обязательно' } };
  function edge(k, side) { return EDGE[k] ? EDGE[k][side] : AXES[k][side]; }

  // Ответы без вопросов этой темы — какой была картина до неё.
  function withoutTopic(all, topic) {
    var out = {}, skip = {};
    topic.questions.forEach(function (q) { skip[q.id] = 1; });
    Object.keys(all || {}).forEach(function (k) { if (!skip[k]) out[k] = all[k]; });
    return out;
  }
  function axisPairText(k, X, Y, va, vb) {
    var T = PAIR_AX[k], hiP = va >= vb ? X : Y, loP = va >= vb ? Y : X, gap = Math.abs(va - vb), text, rec;
    if (gap >= AX_GAP) { text = T.gap; rec = T.gapRec; }
    else {
      var lvl = A.axisLevel((va + vb) / 2);
      text = T[lvl]; rec = T[lvl + 'Rec'];
      // Небольшая разница — тоже информация: кто из вас чуть ближе к какому краю.
      if (gap >= AX_LEAN) text = 'Небольшая разница: {X} чуть ближе к краю «' + edge(k, 'hi') + '», {Y} — к краю «' + edge(k, 'lo') + '». ' + text;
    }
    var people = [hiP, loP];
    return p(G(fill(esc(text), hiP.name, loP.name), people) + (rec ? ' <span style="color:' + C.muted + '">' + G(fill(esc(rec), hiP.name, loP.name), people) + '</span>' : ''));
  }

  function axesBlock(topic, X, Y) {
    var rows = '', items = [], shifts = [];
    var touched = {};
    topic.questions.forEach(function (q) { Object.keys(q.ax || {}).forEach(function (k) { touched[k] = 1; }); });
    var beforeX = withoutTopic(X.all, topic), beforeY = withoutTopic(Y.all, topic);
    TALK_AXES.forEach(function (k) {
      var va = axisScore(X.all, k), vb = axisScore(Y.all, k);
      if (va == null || vb == null) return;
      var ax = AXES[k];
      rows += A.axisRow(ax.title, ax.lo, ax.hi, va, vb, X.name, Y.name);
      if (PAIR_AX[k]) items.push({ k: k, va: va, vb: vb, touched: !!touched[k], gap: Math.abs(va - vb) });
      if (!touched[k]) return;
      [[X, va, axisScore(beforeX, k)], [Y, vb, axisScore(beforeY, k)]].forEach(function (z) {
        if (z[2] == null || Math.abs(z[1] - z[2]) < AX_SHIFT) return;
        shifts.push(G('Ось «' + esc(ax.title) + '»: ' + esc(z[0].name) + ' в этой теме ответил(а) ближе к краю «' + esc(edge(k, z[1] > z[2] ? 'hi' : 'lo')) + '», чем раньше.', [z[0]]));
      });
    });
    if (!rows) return '';
    // Сначала оси, которых касалась тема, потом — где вы сильнее расходитесь; текст — по трём главным.
    items.sort(function (a, b) { return (b.touched - a.touched) || (b.gap - a.gap); });
    var texts = items.slice(0, 3).map(function (it) { return axisPairText(it.k, X, Y, it.va, it.vb); }).join('');
    var shiftHtml = shifts.length ? h2('Что эта тема добавила') + card(shifts.slice(0, 3).map(function (t, i, a) { return p(t, i === a.length - 1 ? 'margin:0' : ''); }).join('')) : '';
    return shiftHtml + h2('Ваши оси — по всему, что вы уже прошли') +
      card(rows + texts + muted('Оси считаются по ответам портрета пары и всех тем, которые вы прошли вдвоём. Текст — о трёх осях: сначала тех, которых касалась эта тема, потом тех, где вы сильнее всего расходитесь.'));
  }

  // ───────────────────────── повторное прохождение: что изменилось с прошлого раза
  // prev: { at: 'дд.мм.гггг', X: { a, g }, Y: { a, g } } — ответы и догадки той же пары в прошлый раз.
  function nWord(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  }
  function prevPeople(X, Y, prev) {
    return [{ name: X.name, gender: X.gender, a: prev.X.a || {}, g: prev.X.g || {} }, { name: Y.name, gender: Y.gender, a: prev.Y.a || {}, g: prev.Y.g || {} }];
  }
  function togetherCount(topic, P, Q) {
    var n = 0, all = 0;
    topic.questions.forEach(function (q) {
      var x = keys(P.a, q.id), y = keys(Q.a, q.id);
      if (!x.length || !y.length) return;
      all++;
      var r = A.relation(q, x, y);
      if (r === 'match' || r === 'close') n++;
    });
    return { n: n, all: all };
  }
  function changesBlock(topic, X, Y, prev) {
    if (!prev) return '';
    var PP = prevPeople(X, Y, prev), PX = PP[0], PY = PP[1], lines = [];
    [[X, Y, PX, PY], [Y, X, PY, PX]].forEach(function (z) {
      var was = guessScore(topic, z[2], z[3]), now = guessScore(topic, z[0], z[1]);
      if (!was.n || !now.n) return;
      var dir = now.pct > was.pct + 5 ? ' — лучше, чем в прошлый раз.' : now.pct < was.pct - 5 ? ' — представления друг о друге где-то устарели.' : ' — примерно так же.';
      lines.push(G(esc(z[0].name) + ' угадывал(а) ответы партнёра на ' + was.pct + '%, теперь — на ' + now.pct + '%' + dir, [z[0]]));
    });
    var t0 = togetherCount(topic, PX, PY), t1 = togetherCount(topic, X, Y);
    if (t0.all && t1.all) lines.push('Ваши ответы совпадали или были похожи в ' + t0.n + ' ' + nWord(t0.n, 'вопросе', 'вопросах', 'вопросах') + ' из ' + t0.all + ', теперь — в ' + t1.n + ' из ' + t1.all + '.');
    var people = '';
    [[X, PX, C.a], [Y, PY, C.b]].forEach(function (z) {
      var items = [];
      topic.questions.forEach(function (q) {
        var now = keys(z[0].a, q.id), was = keys(z[1].a, q.id);
        if (!now.length || !was.length || A.sameSet(now, was)) return;
        var mine = function (t) { return G(esc(t), [z[0]], z[0]); }; // формы «был(а)» — о самом человеке
        items.push('<li style="margin:0 0 8px">' + mine(qv(q).text) + '<br><span style="color:' + C.muted + '">было: ' + mine(optText(q.id, was)) + '</span><br>стало: <b>' + mine(optText(q.id, now)) + '</b></li>');
      });
      var head = '<b style="color:' + z[2] + '">' + esc(z[0].name) + '</b>' + (items.length
        ? ' изменил(а) ' + items.length + ' ' + nWord(items.length, 'ответ', 'ответа', 'ответов') + ':'
        : ' ответил(а) так же, как в прошлый раз.');
      people += p(G(head, [z[0]]), items.length ? 'margin:14px 0 6px' : 'margin:14px 0 0') +
        (items.length ? '<ul style="margin:0;padding-left:20px;font:400 15px/1.5 ' + FONT + ';color:' + C.ink + '">' + items.slice(0, 8).join('') + '</ul>' +
          (items.length > 8 ? muted('и ещё ' + (items.length - 8)) : '') : '');
    });
    return h2('Что изменилось с ' + esc(prev.at)) +
      card(p('Вы уже проходили эту тему ' + esc(prev.at) + '. Изменившиеся ответы — не ошибки, а то, как вы меняетесь: расскажите друг другу, что за ними стоит.') +
        lines.map(function (t) { return p(t); }).join('') + people);
  }

  // ───────────────────────── разбор темы
  function report(topicId, X, Y, ctx) {
    var prev = CUR;
    CUR = ctx && ctx.ctx || null;
    try { return reportInner(topicId, X, Y, ctx || {}); } finally { CUR = prev; }
  }
  function reportInner(topicId, X, Y, ctx) {
    var topic = TBY[topicId];
    var mods = (ctx.mods || []).concat(topicId);
    var notes = crossNotes(topic, X, Y, mods);
    var conv = conversation(topic, X, Y);
    var html = '';

    html += '<div style="text-align:center;padding:8px 0 4px">' +
      '<div style="font:500 13px/1.4 ' + FONT + ';letter-spacing:.08em;text-transform:uppercase;color:' + C.muted + '">Разговор · ' + esc(topic.title) + '</div>' +
      '<div style="font:600 26px/1.25 ' + FONT + ';color:' + C.ink + ';margin:6px 0 4px"><span style="color:' + C.a + '">' + esc(X.name) + '</span> &amp; <span style="color:' + C.b + '">' + esc(Y.name) + '</span></div></div>';
    html += p(esc(topic.lead), 'text-align:center;color:' + C.muted);

    html += notesBlock(X, Y);
    html += guessBlock(topic, X, Y);
    html += changesBlock(topic, X, Y, ctx.prev);
    html += '<!--CLAUDE-->';
    html += convBlock(conv);
    html += crossBlock(notes);
    if (topic.practice && topic.practice.length) {
      html += h2('Практика на неделю');
      html += card(topic.practice.map(function (t, i) { return p(esc(t), i === topic.practice.length - 1 ? 'margin:0' : ''); }).join(''));
    }
    html += answersBlock(topic, X, Y);
    html += axesBlock(topic, X, Y);
    html += muted('Разбор построен по вашим ответам и не заменяет консультацию психолога. Если тема вызывает сильную боль, обсуждать её вместе со специалистом — забота о паре, а не слабость.');

    var gx = guessScore(topic, X, Y), gy = guessScore(topic, Y, X);
    return { html: html, text: reportText(topic, X, Y, notes, ctx), guessA: gx.pct, guessB: gy.pct, notes: notes };
  }

  // Текстовая сводка для Claude: тема + всё, что пара уже прошла вместе.
  function reportText(topic, X, Y, notes, ctx) {
    var L = ['Тема разговора: ' + quoted(topic.title) + ' — ' + topic.lead, 'Партнёр A: ' + A.withGender(X), 'Партнёр B: ' + A.withGender(Y)];
    if (CUR) L.push('О паре: ' + A.contextText(CUR));
    L.push('');
    topicLines(L, topic, X, Y, notes);
    L.push('', 'Оси по всем пройденным модулям (0 — левый полюс, 1 — правый):');
    axesLines(L, X, Y);
    if (ctx.prev) {
      var PP = prevPeople(X, Y, ctx.prev);
      L.push('', 'Пара проходит эту тему повторно. В прошлый раз (' + ctx.prev.at + ') они ответили так (в скобках — догадка партнёра тогда):');
      topic.questions.forEach(function (q) {
        var x = keys(PP[0].a, q.id), y = keys(PP[1].a, q.id);
        if (!x.length && !y.length) return;
        var gx = keys(PP[0].g, q.id), gy = keys(PP[1].g, q.id);
        L.push('- ' + qv(q).text + '\n   A: ' + optText(q.id, x) + (gy.length ? ' (B предполагал(а): ' + optText(q.id, gy) + ')' : '') +
          '\n   B: ' + optText(q.id, y) + (gx.length ? ' (A предполагал(а): ' + optText(q.id, gx) + ')' : ''));
      });
    }
    (ctx.mods || []).forEach(function (mod) {
      var qs = mod === 'portrait' ? DATA.questions : TBY[mod] ? TBY[mod].questions : [];
      if (!qs.length) return;
      L.push('', 'Ранее пройдено вдвоём — ' + modTitle(mod) + ':');
      qs.forEach(function (q) {
        var x = keys(X.all, q.id), y = keys(Y.all, q.id);
        if (x.length || y.length) L.push('- ' + qv(q).text + ' A: ' + optText(q.id, x) + ' | B: ' + optText(q.id, y));
      });
    });
    return L.join('\n');
  }

  // Ответы, догадки, фразы и связи одной темы.
  function topicLines(L, topic, X, Y, notes) {
    L.push('Ответы по теме (в скобках — догадка партнёра):');
    topic.questions.forEach(function (q) {
      var x = keys(X.a, q.id), y = keys(Y.a, q.id);
      if (!x.length && !y.length) return;
      var gy = keys(Y.g, q.id), gx = keys(X.g, q.id);
      L.push('- [' + (TOP.layers[q.layer] || '') + '] ' + qv(q).text +
        '\n   A: ' + optText(q.id, x) + (gy.length ? ' (B предполагал(а): ' + optText(q.id, gy) + ')' : '') +
        '\n   B: ' + optText(q.id, y) + (gx.length ? ' (A предполагал(а): ' + optText(q.id, gx) + ')' : ''));
    });
    if (X.note) L.push('', 'A хочет сказать партнёру: «' + X.note + '»');
    if (Y.note) L.push('', 'B хочет сказать партнёру: «' + Y.note + '»');
    if (notes.length) {
      L.push('', 'Найденные связи с портретом и другими темами:');
      notes.forEach(function (n) { L.push('- (' + n.tag + ') ' + A.plain(n.text)); });
    }
  }
  function axesLines(L, X, Y) {
    TALK_AXES.forEach(function (k) {
      var va = axisScore(X.all, k), vb = axisScore(Y.all, k);
      if (va != null && vb != null) L.push('- ' + AXES[k].title + ': A ' + va.toFixed(2) + ', B ' + vb.toFixed(2));
    });
  }

  // ───────────────────────── общий разбор по всем модулям (пишет только Claude)
  // Человек: { name, gender, portrait: ответы портрета или null, topics: { id: { a, g, note } } }.
  // Берутся только модули, которые прошли оба.
  function overallInput(PA, PB, pairCtx) {
    var prev = CUR;
    CUR = pairCtx || null;
    try { return overallInner(PA, PB); } finally { CUR = prev; }
  }
  function overallInner(PA, PB) {
    var mods = [], allA = {}, allB = {};
    function merge(dst, src) { Object.keys(src || {}).forEach(function (k) { dst[k] = src[k]; }); }
    if (PA.portrait && PB.portrait) { mods.push('portrait'); merge(allA, PA.portrait); merge(allB, PB.portrait); }
    var done = TOPICS.filter(function (t) { return PA.topics[t.id] && PB.topics[t.id]; });
    done.forEach(function (t) { mods.push(t.id); merge(allA, PA.topics[t.id].a); merge(allB, PB.topics[t.id].a); });
    var L = ['Партнёр A: ' + A.withGender(PA), 'Партнёр B: ' + A.withGender(PB)];
    if (CUR) L.push('О паре: ' + A.contextText(CUR));
    L.push('Пройдено вдвоём: ' + mods.map(modTitle).join(', ') + '.');
    if (mods[0] === 'portrait') {
      var rep = A.report({ name: PA.name, gender: PA.gender, answers: PA.portrait }, { name: PB.name, gender: PB.gender, answers: PB.portrait }, { ctx: CUR });
      L.push('', '═══ Портрет пары', rep.text);
    }
    done.forEach(function (t) {
      var a = PA.topics[t.id], b = PB.topics[t.id];
      var X = { name: PA.name, gender: PA.gender, a: a.a, g: a.g || {}, note: a.note || '', all: allA };
      var Y = { name: PB.name, gender: PB.gender, a: b.a, g: b.g || {}, note: b.note || '', all: allB };
      L.push('', '═══ Тема ' + quoted(t.title));
      topicLines(L, t, X, Y, crossNotes(t, X, Y, mods));
      var gx = guessScore(t, X, Y), gy = guessScore(t, Y, X);
      if (gx.n || gy.n) L.push('Угадано: A — ' + gx.pct + '%, B — ' + gy.pct + '%');
    });
    L.push('', 'Оси по всем модулям (0 — левый полюс, 1 — правый):');
    axesLines(L, { all: allA }, { all: allB });
    return { text: L.join('\n'), mods: mods };
  }

  // Текст Claude → HTML: короткие строки без точки в конце — подзаголовки, остальное — абзацы.
  function overallHtml(text, PA, PB, date) {
    var body = '';
    String(text || '').split(/\n+/).map(function (t) { return t.trim(); }).filter(String).forEach(function (line) {
      if (line.length <= 70 && !/[.!?…:»"]$/.test(line)) body += '<div style="font:600 17px/1.35 ' + FONT + ';color:' + C.ink + ';margin:22px 0 8px">' + esc(line) + '</div>';
      else body += p(esc(line));
    });
    return '<div style="text-align:center;padding:8px 0 4px">' +
      '<div style="font:500 13px/1.4 ' + FONT + ';letter-spacing:.08em;text-transform:uppercase;color:' + C.muted + '">Общий разбор · написано ИИ</div>' +
      '<div style="font:600 26px/1.25 ' + FONT + ';color:' + C.ink + ';margin:6px 0 4px"><span style="color:' + C.a + '">' + esc(PA.name) + '</span> &amp; <span style="color:' + C.b + '">' + esc(PB.name) + '</span></div>' +
      (date ? '<div style="font:400 13px/1.4 ' + FONT + ';color:' + C.muted + '">' + esc(date) + '</div>' : '') + '</div>' +
      card(body, C.accentSoft, '#efcfdb') +
      muted('Этот разбор написал ИИ (Claude) по всем вашим ответам. Он может ошибаться — воспринимайте его как повод для разговора, а не как оценку. Разбор не заменяет консультацию психолога.');
  }

  // ───────────────────────── письма
  var B = A.button, W = A.emailWrap;
  function title(t) { return '<div style="font:600 22px/1.3 ' + FONT + ';color:' + C.ink + ';margin:0 0 12px">' + t + '</div>'; }
  var FOOT = 'Письмо от «Мы вдвоём» — сайта для разговоров в паре. Если вы не знаете, о чём речь, просто проигнорируйте его.';
  var mail = {
    // Партнёра приглашают поговорить на тему
    topicInvite: function (X, Y, topic, link) {
      var html = title(esc(Y.name) + ', ' + esc(X.name) + ' предлагает поговорить') +
        p('Тема: <b>' + esc(quoted(topic.title)) + '</b> — ' + esc(topic.lead)) +
        p(esc(X.name) + ' уже ответил(а) на вопросы и попробовал(а) угадать ваши ответы. Теперь ваша очередь: ответьте сами и угадайте, что ответил(а) ' + esc(X.name) + '. Это займёт около ' + topic.minutes + ' минут.') +
        p('Когда ответите, вы оба получите разбор: где вы угадали друг друга, где нет — и план разговора на вечер.') +
        B(link, 'Ответить на вопросы') +
        muted('Ответы ' + esc(X.name) + ' вы увидите только после того, как ответите сами. Если кнопка не работает, откройте ссылку: ' + esc(link));
      return { subject: X.name + ' предлагает поговорить: ' + quoted(topic.title), html: W(G(html, [X, Y]), FOOT) };
    },
    // Тому, кто начал разговор с новой парой: ссылка на кабинет
    topicStarted: function (X, Y, topic, cabLink) {
      var html = title(esc(X.name) + ', спасибо за ответы!') +
        p('Вы ответили на тему <b>' + esc(quoted(topic.title)) + '</b>. Мы отправили приглашение <b>' + esc(Y.name) + '</b> (' + esc(Y.email) + '). Как только ' + esc(Y.name) + ' ответит, вы оба получите разбор и план разговора.') +
        p('Сохраните это письмо: по кнопке ниже — ваш кабинет пары. Там видно, кто на что уже ответил, и можно выбрать следующую тему или пройти портрет пары.') +
        B(cabLink, 'Открыть кабинет пары');
      return { subject: 'Вы начали разговор: ' + quoted(topic.title), html: W(html, FOOT) };
    },
    // Итог темы — каждому
    topicResult: function (X, Y, topic, reportHtml, link, forName) {
      var html = title(esc(forName) + ', разбор разговора готов') +
        p('Вы оба ответили на тему ' + esc(quoted(topic.title)) + '. Ниже — что получилось и план разговора на вечер. Читайте вместе: разбор — не оценка, а повод поговорить.') +
        (link ? B(link, 'Открыть в кабинете пары') : '') + reportHtml;
      return { subject: 'Разговор ' + quoted(topic.title) + ': ' + X.name + ' и ' + Y.name, html: W(html, 'Разбор построен по вашим ответам и не заменяет консультацию психолога.') };
    },
    // Общий разбор — каждому
    overall: function (X, Y, html, link, forName) {
      var out = title(esc(forName) + ', ваш общий разбор готов') +
        p('Мы собрали всё, что вы рассказали о себе и друг о друге, — портрет пары и все темы, которые вы прошли вдвоём, — и попросили ИИ посмотреть на это целиком. Читайте вместе и не спеша.') +
        (link ? B(link, 'Открыть в кабинете пары') : '') + html;
      return { subject: 'Общий разбор: ' + X.name + ' и ' + Y.name, html: W(out, 'Разбор написал ИИ по вашим ответам. Он не заменяет консультацию психолога.') };
    },
    // Партнёра зовут пройти портрет пары из кабинета
    portraitInvite: function (X, Y, link) {
      var html = title(esc(Y.name) + ', ваша очередь') +
        p(esc(X.name) + ' прошёл (прошла) «Портрет пары» — 32 вопроса об общении, конфликтах, быте, деньгах, близости и планах. Ответьте и вы — и вы оба получите разбор пары: портреты, опоры, зоны договорённостей и рекомендации.') +
        p('Портрет пары делает точнее и разборы тем в разделе «Разговоры».') +
        B(link, 'Пройти портрет пары') +
        muted('Если кнопка не работает, откройте ссылку: ' + esc(link));
      return { subject: X.name + ' ждёт ваших ответов: портрет пары', html: W(G(html, [X, Y]), FOOT) };
    }
  };

  return {
    topics: TOPICS, soon: TOP.soon || [], topic: function (id) { return TBY[id] || null; }, reg: REG,
    maxPick: maxPick, cleanKeys: cleanKeys, cleanTopic: cleanTopic, cleanNote: cleanNote,
    axisScore: axisScore, guessScore: guessScore, guessRes: guessRes, crossNotes: crossNotes, conversation: conversation,
    report: report, mail: mail, quoted: quoted, overallInput: overallInput, overallHtml: overallHtml
  };
})(CQ_DATA, CQ_TOPICS, CQA);
