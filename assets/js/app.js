/* ============================================================
   ТЕАТР ВЕНТИЛЯТОР — общая логика и отрисовка страниц
   ============================================================ */
(function () {
  const { load, img, CFG } = window.VENT;

  /* ---------------- утилиты ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const qp = (k) => new URLSearchParams(location.search).get(k) || "";

  const MON = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const MON_SHORT = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
  const WD = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
  const WD_SHORT = ["вс","пн","вт","ср","чт","пт","сб"];

  function D(s) { return new Date(String(s).replace(" ", "T")); }
  function fmt(s) {
    const d = D(s);
    return {
      d: d.getDate(), mon: MON[d.getMonth()], monShort: MON_SHORT[d.getMonth()],
      wd: WD[d.getDay()], wdShort: WD_SHORT[d.getDay()], year: d.getFullYear(),
      time: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"),
      ts: d.getTime(), obj: d
    };
  }
  const money = (n) => new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";
  function plural(n, a, b, c) {
    const m = n % 100, k = n % 10;
    if (m > 10 && m < 20) return c;
    if (k === 1) return a;
    if (k >= 2 && k <= 4) return b;
    return c;
  }
  const ARROW = '<svg width="15" height="11" viewBox="0 0 15 11" fill="none"><path d="M9.5 1L14 5.5L9.5 10M14 5.5H0" stroke="currentColor" stroke-width="1.6"/></svg>';

  /* ---------------- зал ---------------- */
  const HALL = {
    rows: ["А", "Б", "В", "Г", "Д", "Е"],
    perRow: 10,
    aisleAfter: 5,
    zone: (row) => (row === "А" || row === "Б") ? "a" : (row === "В" || row === "Г") ? "b" : "c",
    zoneName: { a: "Первые ряды", b: "Центр", c: "Дальние ряды" },
    total: 60
  };
  const soldSet = (s) => new Set(String(s || "").split(",").map(x => x.trim()).filter(Boolean));

  /* ---------------- шапка и подвал ---------------- */
  const NAV = {
    theatre: [["afisha.html", "Афиша"], ["troupe.html", "Труппа"], ["about.html", "О театре"], ["contacts.html", "Контакты"]],
    studio: [["studio.html", "Все курсы"], ["studio.html#raspisanie", "Расписание"], ["studio.html#nabor", "Ближайшие наборы"], ["contacts.html", "Контакты"]]
  };

  function chrome(data) {
    const s = data.settings;
    const isStudio = document.body.classList.contains("studio");
    const here = location.pathname.split("/").pop() || "index.html";
    const items = (isStudio ? NAV.studio : NAV.theatre).map(([h, t]) => {
      const on = h.split("#")[0] === here ? " is-active" : "";
      return `<a class="${on.trim()}" href="${h}">${t}</a>`;
    }).join("");

    const hdr = $("#hdr");
    if (hdr) {
      hdr.className = "hdr";
      hdr.innerHTML = `
        <div class="hdr__in">
          <a class="hdr__logo" href="index.html" aria-label="${esc(s.theatre_name)}">
            <img src="assets/img/logo-sm.png" alt="${esc(s.theatre_name)}">
          </a>
          <button class="hdr__burger" aria-label="Меню"><span></span><span></span><span></span></button>
          <nav class="hdr__nav">
            <div class="switch">
              <a href="index.html" class="${isStudio ? "" : "is-on"}">Театр</a>
              <a href="studio.html" class="${isStudio ? "is-on" : ""}">Студия</a>
            </div>
            ${items}
            <a class="btn btn--sm hdr__cta" href="${isStudio ? "studio.html#nabor" : "afisha.html"}">${isStudio ? "Записаться" : "Купить билет"}</a>
          </nav>
        </div>`;
      $(".hdr__burger", hdr).addEventListener("click", () => hdr.classList.toggle("is-open"));
      $$(".hdr__nav a", hdr).forEach(a => a.addEventListener("click", () => hdr.classList.remove("is-open")));
    }

    const ftr = $("#ftr");
    if (ftr) {
      ftr.className = "ftr";
      ftr.innerHTML = `
        <div class="wrap">
          <div class="ftr__grid">
            <div>
              <div class="ftr__logo"><img src="assets/img/logo-sm.png" alt=""></div>
              <p class="small muted" style="max-width:34ch">${esc(s.tagline)}</p>
            </div>
            <div>
              <h4>Театр</h4>
              <ul>${NAV.theatre.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join("")}</ul>
            </div>
            <div>
              <h4>Студия</h4>
              <ul>${(data.courses || []).map(c => `<li><a href="course.html?id=${c.id}">${esc(c.title)}</a></li>`).join("")}</ul>
            </div>
            <div>
              <h4>Связаться</h4>
              <ul>
                <li>${esc(s.address)}</li>
                <li><a href="tel:${String(s.phone).replace(/[^+\d]/g, "")}">${esc(s.phone)}</a></li>
                <li><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></li>
                <li><a href="${esc(s.telegram)}" target="_blank" rel="noopener">Telegram</a></li>
                <li><a href="${esc(s.vk)}" target="_blank" rel="noopener">ВКонтакте</a></li>
              </ul>
            </div>
          </div>
          <div class="ftr__bottom">
            <span>© ${new Date().getFullYear()} ${esc(s.theatre_name)}. ${esc(s.city)}</span>
            <span>Любительский театр · ${esc(s.hall_name)}, ${s.hall_seats} ${plural(+s.hall_seats, "место", "места", "мест")}</span>
          </div>
        </div>`;
    }

    if (data.__source === "demo") {
      const bar = document.createElement("div");
      bar.className = "demo-bar";
      bar.innerHTML = '<b>Демо-режим.</b> Показаны примерные данные. Подключите Google-таблицу в <code>assets/js/config.js</code> — и сайт начнёт брать из неё репертуар, цены и расписание.';
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  /* ---------------- лайтбокс ---------------- */
  let LB = { list: [], i: 0 };
  function lightbox() {
    let el = $(".lightbox");
    if (!el) {
      el = document.createElement("div");
      el.className = "lightbox";
      el.innerHTML = `<button class="lightbox__x" aria-label="Закрыть">✕</button>
        <button class="lightbox__nav prev" aria-label="Назад">‹</button>
        <button class="lightbox__nav next" aria-label="Вперёд">›</button>
        <img alt=""><div class="lightbox__cap"></div>`;
      document.body.appendChild(el);
      const close = () => el.classList.remove("is-on");
      $(".lightbox__x", el).onclick = close;
      el.onclick = (e) => { if (e.target === el) close(); };
      $(".prev", el).onclick = (e) => { e.stopPropagation(); step(-1); };
      $(".next", el).onclick = (e) => { e.stopPropagation(); step(1); };
      document.addEventListener("keydown", (e) => {
        if (!el.classList.contains("is-on")) return;
        if (e.key === "Escape") close();
        if (e.key === "ArrowLeft") step(-1);
        if (e.key === "ArrowRight") step(1);
      });
    }
    return el;
  }
  function step(n) {
    const el = lightbox();
    LB.i = (LB.i + n + LB.list.length) % LB.list.length;
    $("img", el).src = img(LB.list[LB.i], "lg");
    $(".lightbox__cap", el).textContent = (LB.i + 1) + " / " + LB.list.length;
  }
  function openLB(list, i) { LB = { list, i }; const el = lightbox(); el.classList.add("is-on"); step(0); }

  function galleryHTML(list) {
    return `<div class="gal">${list.map((g, i) =>
      `<button data-i="${i}"><img loading="lazy" src="${img(g, "md")}" alt=""></button>`).join("")}</div>`;
  }
  function bindGallery(root, list) {
    $$(".gal button", root).forEach(b => b.onclick = () => openLB(list, +b.dataset.i));
  }

  /* ---------------- развилка «театр / студия» на главной ---------------- */
  function forkNav() {
    $$('.fork__half').forEach(a => a.addEventListener("click", (e) => {
      const t = document.querySelector(a.getAttribute("href"));
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", a.getAttribute("href"));
    }));
  }

  /* ---------------- появление при скролле ---------------- */
  function reveal() {
    const all = $$(".reveal");
    const showAll = () => all.forEach(e => e.classList.add("is-in"));
    if (!("IntersectionObserver" in window)) { showAll(); return; }
    const io = new IntersectionObserver((es) => es.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    all.forEach(e => io.observe(e));
    // подстраховка: контент не должен остаться невидимым ни при каких обстоятельствах
    setTimeout(showAll, 1500);
  }

  /* ---------------- общие куски ---------------- */
  const byId = (arr, id) => (arr || []).find(x => x.id === id);

  function upcoming(data, showId) {
    const now = Date.now() - 3 * 3600e3;
    return data.sessions
      .filter(s => D(s.datetime).getTime() > now)
      .filter(s => !showId || s.show === showId)
      .sort((a, b) => D(a.datetime) - D(b.datetime));
  }
  function occupancy(sess) {
    const sold = soldSet(sess.sold).size;
    return { sold, free: HALL.total - sold, pct: Math.round(sold / HALL.total * 100) };
  }
  function fillHTML(sess) {
    const o = occupancy(sess);
    const cls = o.pct >= 70 ? "fill--hot" : "fill--ok";
    const label = o.free === 0 ? "Аншлаг" : o.free <= 8 ? "Осталось " + o.free : "Свободно " + o.free + " из " + HALL.total;
    return `<span class="fill ${cls}"><span class="fill__bar"><i style="width:${o.pct}%"></i></span>${label}</span>`;
  }
  function minPrice(s) { return Math.min(s.price_a, s.price_b, s.price_c); }

  function playRow(data, sess) {
    const show = byId(data.shows, sess.show) || {};
    const f = fmt(sess.datetime);
    const o = occupancy(sess);
    return `<div class="play">
      <div class="play__date">
        <div class="play__day mono">${f.d}</div>
        <div class="play__mon">${f.monShort} · ${f.wdShort}</div>
        <div class="play__time mono">${f.time}</div>
      </div>
      <div>
        <a href="show.html?id=${show.id}"><div class="play__title">${esc(show.title)}</div></a>
        <div class="play__sub">${esc(show.subtitle || "")}</div>
        <div class="play__info">
          <span>${esc(show.genre || "")}</span><span>${show.duration} мин</span><span>${esc(show.age || "")}</span>
          ${fillHTML(sess)}
        </div>
      </div>
      <div class="play__side">
        <div class="play__price">от <b>${money(minPrice(sess))}</b></div>
        ${o.free === 0
          ? `<span class="btn btn--sm btn--ghost is-disabled">Мест нет</span>`
          : `<a class="btn btn--sm" href="tickets.html?session=${sess.id}">Купить билет</a>`}
      </div>
    </div>`;
  }

  function showCard(show, data) {
    const next = upcoming(data, show.id)[0];
    const soon = show.status === "soon";
    return `<a class="card reveal" href="show.html?id=${show.id}">
      <div class="card__img">
        <img loading="lazy" src="${img(show.cover || show.poster, "md")}" alt="${esc(show.title)}">
        <div class="card__badges">
          ${soon ? '<span class="tag tag--soon">Скоро премьера</span>' : ""}
          <span class="tag">${esc(show.age)}</span>
        </div>
      </div>
      <div class="card__body">
        <h3 class="card__title">${esc(show.title)}</h3>
        <div class="card__sub">${esc(show.subtitle)}</div>
        <div class="card__meta">
          <span>${esc(show.genre)}</span><span>${show.duration} мин</span>
          <span>${next ? fmt(next.datetime).d + " " + fmt(next.datetime).monShort : (soon ? "Декабрь 2026" : "Даты уточняются")}</span>
        </div>
      </div>
    </a>`;
  }

  function personCard(p) {
    return `<button class="person reveal" data-actor="${p.id}">
      <div class="person__img"><img loading="lazy" src="${img(p.photo, "md")}" alt="${esc(p.name)}"></div>
      <div class="person__body">
        <div class="person__name">${esc(p.name)}</div>
        <div class="person__role">${esc(p.role)}</div>
        <div class="person__note">${esc(p.profession || "")}</div>
      </div>
    </button>`;
  }

  function actorModal(data) {
    let m = $("#actorModal");
    if (!m) {
      m = document.createElement("div");
      m.id = "actorModal"; m.className = "modal";
      m.innerHTML = `<div class="modal__bd"></div><div class="modal__box"><button class="modal__x">✕</button><div class="modal__in"></div></div>`;
      document.body.appendChild(m);
      const close = () => m.classList.remove("is-on");
      $(".modal__bd", m).onclick = close; $(".modal__x", m).onclick = close;
      document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    }
    return m;
  }
  function bindPeople(root, data) {
    $$("[data-actor]", root).forEach(b => b.onclick = () => {
      const p = byId(data.actors, b.dataset.actor); if (!p) return;
      const m = actorModal(data);
      $(".modal__in", m).innerHTML = `
        <div class="split split--person">
          <div><img src="${img(p.photo, "md")}" alt="${esc(p.name)}" style="width:100%;height:100%;object-fit:cover;min-height:300px"></div>
          <div style="padding:clamp(24px,3vw,38px)">
            <div class="eyebrow">${esc(p.role)}</div>
            <h2 style="font-size:clamp(1.6rem,3vw,2.4rem)">${esc(p.name)}</h2>
            <div class="prose" style="margin-top:20px;font-size:.98rem">${p.bio.map(x => `<p>${esc(x)}</p>`).join("")}</div>
            <dl class="dl" style="margin-top:24px">
              ${p.since ? `<dt>В театре с</dt><dd>${esc(p.since)}</dd>` : ""}
              ${p.profession ? `<dt>Вне сцены</dt><dd>${esc(p.profession)}</dd>` : ""}
              ${p.education ? `<dt>Образование</dt><dd>${esc(p.education)}</dd>` : ""}
              ${p.shows && p.shows.length ? `<dt>Занят в</dt><dd>${p.shows.map(esc).join(", ")}</dd>` : ""}
            </dl>
            ${p.contact ? `<a class="btn btn--sm btn--ghost" style="margin-top:24px" href="${esc(p.contact)}" target="_blank" rel="noopener">Написать</a>` : ""}
          </div>
        </div>`;
      m.classList.add("is-on");
    });
  }

  /* =========================================================
     СТРАНИЦЫ
     ========================================================= */
  const PAGES = {};

  /* ---------- Главная ---------- */
  PAGES.index = (data) => {
    const s = data.settings;
    const next = upcoming(data)[0];
    const nextShow = next ? byId(data.shows, next.show) : data.shows[0];
    const f = next ? fmt(next.datetime) : null;
    const starts = (data.starts || []).filter(x => x.status === "open").sort((a, b) => D(a.date) - D(b.date));

    $("#app").innerHTML = `
    <!-- ===== развилка: две половины сайта ===== -->
    <section class="fork">
      <a class="fork__half fork__half--t" href="#teatr">
        <img src="${img(nextShow.cover, "lg")}" alt="">
        <span class="fork__in">
          <span class="fork__kicker">Часть первая</span>
          <span class="fork__title">Театр</span>
          <span class="fork__text">Шесть спектаклей в репертуаре и зал на шестьдесят мест, где первый ряд в полутора метрах от актёра.</span>
          <span class="fork__go">Афиша и билеты ${ARROW}</span>
        </span>
      </a>
      <a class="fork__half fork__half--s" href="#studiya">
        <img src="${img("studio-group-3", "lg")}" alt="">
        <span class="fork__in">
          <span class="fork__kicker">Часть вторая</span>
          <span class="fork__title">Студия<br>актёрского<br>мастерства</span>
          <span class="fork__text">Пять курсов от трёх до девяти месяцев. Для взрослых, с нуля, в маленьких группах.</span>
          <span class="fork__go">Курсы и расписание ${ARROW}</span>
        </span>
      </a>
    </section>

    ${next ? `
    <div class="nextbar">
      <div class="wrap nextbar__in">
        <div>
          <div class="nextbar__k">Ближайший спектакль · ${f.d} ${f.mon}, ${f.wd}, ${f.time}</div>
          <a href="show.html?id=${nextShow.id}"><div class="nextbar__t">${esc(nextShow.title)}</div></a>
        </div>
        <div class="nextbar__side">
          ${fillHTML(next)}
          <a class="btn btn--sm" href="tickets.html?session=${next.id}">Купить билет от ${money(minPrice(next))}</a>
        </div>
      </div>
    </div>` : ""}

    <!-- ===== ЧАСТЬ ПЕРВАЯ: ТЕАТР ===== -->
    <section class="part" id="teatr">
      <div class="wrap part__mark"><span>Часть первая</span><b>Театр</b></div>
    </section>

    <section class="section" style="padding-top:0">
      <div class="wrap">
        <div class="head-row">
          <div><div class="eyebrow">Афиша</div><h2>Ближайшие показы</h2></div>
          <a class="link-more" href="afisha.html">Вся афиша ${ARROW}</a>
        </div>
        <div class="reveal">${upcoming(data).slice(0, 5).map(x => playRow(data, x)).join("")}</div>
      </div>
    </section>

    <section class="section section--line">
      <div class="wrap">
        <div class="head-row">
          <div><div class="eyebrow">Репертуар</div><h2>Спектакли</h2></div>
        </div>
        <div class="grid grid-3">${data.shows.slice(0, 6).map(x => showCard(x, data)).join("")}</div>
      </div>
    </section>

    <section class="section band">
      <div class="wrap">
        <div class="split">
          <div class="reveal"><img src="${img(s.director_photo, "md")}" alt="${esc(s.director_name)}" style="border-radius:10px;width:100%"></div>
          <div class="reveal">
            <div class="eyebrow">Слово режиссёра</div>
            <p class="quote">«${esc(s.director_letter_lead)}»</p>
            <div class="prose" style="margin-top:26px">${(s.director_letter || []).slice(0, 2).map(p => `<p>${esc(p)}</p>`).join("")}</div>
            <p style="margin-top:22px"><b>${esc(s.director_name)}</b><br><span class="muted small">${esc(s.director_role)}</span></p>
            <a class="link-more" style="margin-top:20px" href="about.html">Читать полностью ${ARROW}</a>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="head-row">
          <div><div class="eyebrow">Труппа</div><h2>Кто выходит на сцену</h2></div>
          <a class="link-more" href="troupe.html">Вся труппа ${ARROW}</a>
        </div>
        <div class="grid grid-4" id="people">${data.actors.slice(0, 4).map(personCard).join("")}</div>
      </div>
    </section>

    <section class="section section--line">
      <div class="wrap">
        <div class="stats reveal">
          <div><b>${esc(s.about_founded)}</b><span>Год основания</span></div>
          <div><b>${esc(s.about_shows)}</b><span>Спектаклей выпущено</span></div>
          <div><b>${esc(s.about_people)}</b><span>Прошли студию</span></div>
          <div><b>${esc(s.about_seats)}</b><span>Мест в зале</span></div>
        </div>
      </div>
    </section>

    <!-- ===== ЧАСТЬ ВТОРАЯ: СТУДИЯ ===== -->
    <div class="acc-gold">
      <section class="part part--studio" id="studiya">
        <div class="wrap part__mark"><span>Часть вторая</span><b>${esc(s.studio_name)}</b></div>
      </section>

      <section class="section" style="padding-top:0">
        <div class="wrap">
          <div class="head-row">
            <div style="max-width:52ch">
              <div class="eyebrow">Пять направлений</div>
              <h2>Чему учим</h2>
              <p class="lead" style="margin-top:20px">Режиссура, ораторское искусство, актёрское мастерство, сценическое фехтование и язык тела. От трёх до девяти месяцев, с нуля, для взрослых людей с обычной работой. Первое занятие бесплатно.</p>
            </div>
            <a class="link-more" href="studio.html">Все курсы и расписание ${ARROW}</a>
          </div>
          <div class="grid grid-3">
            ${data.courses.map(c => {
              const t = byId(data.actors, c.trainer) || {};
              return `<a class="card reveal" href="course.html?id=${c.id}">
                <div class="card__img"><img loading="lazy" src="${img(c.cover, "md")}" alt="">
                  <div class="card__badges"><span class="tag tag--accent">${esc(c.num)}</span></div></div>
                <div class="card__body">
                  <h3 class="card__title">${esc(c.title)}</h3>
                  <div class="card__sub">${esc(c.subtitle)}</div>
                  <div class="card__meta">
                    <span>${c.months} ${plural(c.months, "месяц", "месяца", "месяцев")}</span>
                    <span>${money(c.price)} / мес</span>
                    <span>${esc(t.name || "")}</span>
                  </div>
                </div>
              </a>`;
            }).join("")}
          </div>
        </div>
      </section>

      <section class="section band">
        <div class="wrap">
          <div class="head-row">
            <div><div class="eyebrow">Набор</div><h2>Ближайшие запуски</h2></div>
            <a class="link-more" href="studio.html#nabor">Все наборы ${ARROW}</a>
          </div>
          ${starts.slice(0, 4).map(st => {
            const c = byId(data.courses, st.course) || {};
            const ff = fmt(st.date + "T12:00");
            const pct = st.seats ? Math.round((st.seats - st.left) / st.seats * 100) : 0;
            return `<div class="start">
              <div><div class="start__d mono">${ff.d}</div><div class="start__m">${ff.monShort} ${ff.year}</div></div>
              <div>
                <div class="play__title" style="font-size:clamp(1.05rem,2vw,1.4rem)">${esc(c.title || st.course)}</div>
                <div class="play__info">
                  <span>${esc(st.days || "")} · ${esc(st.time || "")}</span>
                  <span>${c.months} ${plural(c.months || 0, "месяц", "месяца", "месяцев")}</span>
                  <span class="fill ${st.left <= 4 ? "fill--hot" : "fill--ok"}"><span class="fill__bar"><i style="width:${pct}%"></i></span>осталось ${st.left} ${plural(st.left, "место", "места", "мест")}</span>
                </div>
              </div>
              <div style="text-align:right"><a class="btn btn--sm" href="course.html?id=${st.course}#zapis">Записаться</a></div>
            </div>`;
          }).join("")}
        </div>
      </section>
    </div>

    <!-- ===== общее: контакты ===== -->
    <section class="section section--line">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Как нас найти</div><h2>${esc(s.city)}, ${esc(s.address)}</h2></div>
          <a class="link-more" href="contacts.html">Подробно о том, как добраться ${ARROW}</a></div>
        <div class="grid grid-3">
          <div class="card" style="padding:24px"><h4 style="color:var(--accent);margin-bottom:10px">Метро</h4><p class="small dim">${esc(s.route_metro)}</p></div>
          <div class="card" style="padding:24px"><h4 style="color:var(--accent);margin-bottom:10px">Наземный транспорт</h4><p class="small dim">${esc(s.route_bus)}</p></div>
          <div class="card" style="padding:24px"><h4 style="color:var(--accent);margin-bottom:10px">Вход и этаж</h4><p class="small dim">${esc(s.route_door)}</p></div>
        </div>
      </div>
    </section>`;
    bindPeople($("#app"), data);
    forkNav();
  };

  /* ---------- Афиша ---------- */
  PAGES.afisha = (data) => {
    const list = upcoming(data);
    const byMonth = {};
    list.forEach(s => { const f = fmt(s.datetime); const k = f.mon + " " + f.year; (byMonth[k] = byMonth[k] || []).push(s); });

    $("#app").innerHTML = `
    <section class="hero hero--short">
      <div class="hero__bg"><img src="${img("coats-green-wide", "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="eyebrow">Сезон 2026 / 2027</div>
        <h1>Афиша</h1>
        <p class="lead hero__lead">${list.length} ${plural(list.length, "показ", "показа", "показов")} в ближайшие месяцы. Зал на 60 мест — билеты обычно заканчиваются за неделю.</p>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        ${Object.keys(byMonth).map(k => `
          <div style="margin-bottom:56px">
            <h2 style="font-size:clamp(1.3rem,2.4vw,1.9rem);margin-bottom:22px;color:var(--fg-mute)">${k}</h2>
            ${byMonth[k].map(x => playRow(data, x)).join("")}
          </div>`).join("")}
      </div>
    </section>

    <section class="section section--line">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Репертуар</div><h2>Все спектакли</h2></div></div>
        <div class="grid grid-3">${data.shows.map(x => showCard(x, data)).join("")}</div>
      </div>
    </section>`;
  };

  /* ---------- Спектакль ---------- */
  PAGES.show = (data) => {
    const show = byId(data.shows, qp("id")) || data.shows[0];
    document.title = show.title + " — Театр Вентилятор";
    const dates = upcoming(data, show.id);
    const cast = (show.cast || []).map(id => byId(data.actors, id)).filter(Boolean);

    $("#app").innerHTML = `
    <section class="hero">
      <div class="hero__bg"><img src="${img(show.cover || show.poster, "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="crumbs"><a href="index.html">Театр</a> / <a href="afisha.html">Афиша</a> / <span>${esc(show.title)}</span></div>
        <div class="hero__meta">
          <span class="tag">${esc(show.genre)}</span>
          <span class="tag">${show.duration} мин без антракта</span>
          <span class="tag">${esc(show.age)}</span>
          ${show.status === "soon" ? '<span class="tag tag--soon">Премьера готовится</span>' : ""}
        </div>
        <h1>${esc(show.title)}</h1>
        <p class="lead hero__lead">${esc(show.lead)}</p>
        <div class="hero__actions">
          ${dates.length
            ? `<a class="btn" href="tickets.html?session=${dates[0].id}">Билеты на ${fmt(dates[0].datetime).d} ${fmt(dates[0].datetime).monShort}</a>`
            : `<span class="btn is-disabled">Продажа откроется позже</span>`}
          <a class="btn btn--ghost" href="#gallery">Фотографии</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="split">
          <div>
            <div class="eyebrow">О спектакле</div>
            <div class="prose">${show.description.map(p => `<p>${esc(p)}</p>`).join("")}</div>
          </div>
          <div>
            <div class="facts reveal" style="grid-template-columns:repeat(2,1fr)">
              <div><b>${show.duration} мин</b><span>Продолжительность</span></div>
              <div><b>${esc(show.age)}</b><span>Возраст</span></div>
              <div><b>${esc(show.premiere)}</b><span>Премьера</span></div>
              <div><b>${cast.length}</b><span>${plural(cast.length, "актёр на сцене", "актёра на сцене", "актёров на сцене")}</span></div>
            </div>
            <dl class="dl" style="margin-top:28px">
              ${(show.credits || []).map(c => `<dt>${esc(c[0])}</dt><dd>${esc(c[1])}</dd>`).join("")}
            </dl>
          </div>
        </div>
      </div>
    </section>

    ${dates.length ? `
    <section class="section band">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Расписание</div><h2>Ближайшие показы</h2></div></div>
        ${dates.map(x => playRow(data, x)).join("")}
      </div>
    </section>` : ""}

    ${cast.length ? `
    <section class="section">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Занятые в спектакле</div><h2>Актёры</h2></div></div>
        <div class="grid grid-4" id="people">${cast.map(personCard).join("")}</div>
      </div>
    </section>` : ""}

    <section class="section section--line" id="gallery">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Фотографии</div><h2>${esc(show.title)} на сцене</h2></div></div>
        ${galleryHTML(show.gallery)}
      </div>
    </section>`;
    bindPeople($("#app"), data);
    bindGallery($("#app"), show.gallery);
  };

  /* ---------- Труппа ---------- */
  PAGES.troupe = (data) => {
    $("#app").innerHTML = `
    <section class="hero hero--short">
      <div class="hero__bg"><img src="${img("group-comedy", "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="crumbs"><a href="index.html">Театр</a> / <span>Труппа</span></div>
        <h1>Труппа</h1>
        <p class="lead hero__lead">Девять человек, у каждого — обычная работа и вторая жизнь на сцене. Нажмите на карточку, чтобы прочитать биографию.</p>
      </div>
    </section>
    <section class="section">
      <div class="wrap">
        <div class="grid grid-3" id="people">${data.actors.map(personCard).join("")}</div>
      </div>
    </section>
    <section class="section band">
      <div class="wrap center">
        <div class="eyebrow" style="justify-content:center">Хотите к нам</div>
        <h2>В труппу приходят из студии</h2>
        <p class="lead" style="max-width:56ch;margin:22px auto 30px">Шесть из девяти актёров начинали с базового курса актёрского мастерства. Набор идёт дважды в год.</p>
        <a class="btn" style="background:var(--gold);color:#0A0A0C" href="studio.html">Курсы студии</a>
      </div>
    </section>`;
    bindPeople($("#app"), data);
  };

  /* ---------- О театре ---------- */
  PAGES.about = (data) => {
    const s = data.settings;
    const gal = ["group-comedy", "rehearsal-watch", "studio-group-3", "white-dress-audience", "blue-room", "group-dark"];
    $("#app").innerHTML = `
    <section class="hero hero--short">
      <div class="hero__bg"><img src="${img("rehearsal-watch", "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="crumbs"><a href="index.html">Театр</a> / <span>О театре</span></div>
        <h1>О театре</h1>
      </div>
    </section>

    <section class="section">
      <div class="wrap-narrow">
        <div class="eyebrow">Обращение создателя и режиссёра</div>
        <p class="quote" style="margin-bottom:34px">«${esc(s.director_letter_lead)}»</p>
        <div class="prose">${(s.director_letter || []).map(p => `<p>${esc(p)}</p>`).join("")}</div>
        <div style="display:flex;align-items:center;gap:18px;margin-top:40px;padding-top:28px;border-top:1px solid var(--line)">
          <img src="${img(s.director_photo, "sm")}" alt="" style="width:76px;height:76px;object-fit:cover;border-radius:50%">
          <div><b>${esc(s.director_name)}</b><br><span class="muted small">${esc(s.director_role)}</span></div>
        </div>
      </div>
    </section>

    <section class="section band">
      <div class="wrap">
        <div class="stats reveal">
          <div><b>${esc(s.about_founded)}</b><span>Год основания</span></div>
          <div><b>${esc(s.about_shows)}</b><span>Спектаклей выпущено</span></div>
          <div><b>${esc(s.about_people)}</b><span>Прошли студию</span></div>
          <div><b>${esc(s.about_seats)}</b><span>Мест в зале</span></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Фотоархив</div><h2>Как это выглядит</h2></div></div>
        ${galleryHTML(gal)}
      </div>
    </section>`;
    bindGallery($("#app"), gal);
  };

  /* ---------- Контакты ---------- */
  PAGES.contacts = (data) => {
    const s = data.settings;
    const mapSrc = "https://yandex.ru/map-widget/v1/?text=" + encodeURIComponent(s.map_query) + "&z=17";
    $("#app").innerHTML = `
    <section class="section" style="padding-top:clamp(40px,6vw,72px)">
      <div class="wrap">
        <div class="crumbs"><a href="index.html">Театр</a> / <span>Контакты</span></div>
        <div class="split">
          <div>
            <div class="eyebrow">Контакты</div>
            <h1 style="font-size:clamp(2rem,5vw,3.6rem)">${esc(s.address)}</h1>
            <p class="lead" style="margin-top:20px">${esc(s.address_full)}</p>
            <dl class="dl" style="margin-top:32px">
              <dt>Телефон</dt><dd><a href="tel:${String(s.phone).replace(/[^+\d]/g, "")}">${esc(s.phone)}</a></dd>
              <dt>Почта</dt><dd><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></dd>
              <dt>Telegram</dt><dd><a href="${esc(s.telegram)}" target="_blank" rel="noopener">${esc(s.telegram.replace(/^https?:\/\//, ""))}</a></dd>
              <dt>ВКонтакте</dt><dd><a href="${esc(s.vk)}" target="_blank" rel="noopener">${esc(s.vk.replace(/^https?:\/\//, ""))}</a></dd>
              <dt>Зал</dt><dd>${esc(s.hall_name)}, ${s.hall_seats} мест</dd>
            </dl>
          </div>
          <div>
            <div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)">
              <iframe src="${mapSrc}" width="100%" height="420" frameborder="0" style="display:block;border:0" title="Карта"></iframe>
            </div>
            <p class="note" style="margin-top:12px">Если карта не загрузилась — откройте адрес в <a class="link-more" style="font-size:.78rem" href="https://yandex.ru/maps/?text=${encodeURIComponent(s.map_query)}" target="_blank" rel="noopener">Яндекс&nbsp;Картах</a></p>
          </div>
        </div>
      </div>
    </section>

    <section class="section band">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Как добраться</div><h2>Подсказки</h2></div></div>
        <div class="grid grid-2">
          <div class="card" style="padding:28px"><h3 style="margin-bottom:12px">На метро</h3><p class="dim">${esc(s.route_metro)}</p></div>
          <div class="card" style="padding:28px"><h3 style="margin-bottom:12px">Автобусом и троллейбусом</h3><p class="dim">${esc(s.route_bus)}</p></div>
          <div class="card" style="padding:28px"><h3 style="margin-bottom:12px">На машине</h3><p class="dim">${esc(s.route_car)}</p></div>
          <div class="card" style="padding:28px"><h3 style="margin-bottom:12px">Вход и четвёртый этаж</h3><p class="dim">${esc(s.route_door)}</p></div>
        </div>
        <div class="alert" style="margin-top:26px">${esc(s.route_time)}</div>
      </div>
    </section>`;
  };

  /* ---------- Школа: общая страница ---------- */
  PAGES.studio = (data) => {
    const starts = (data.starts || []).slice().sort((a, b) => D(a.date) - D(b.date));
    const open = starts.filter(x => x.status === "open");
    const trainerOf = (c) => byId(data.actors, c.trainer) || {};

    $("#app").innerHTML = `
    <section class="hero">
      <div class="hero__bg"><img src="${img("studio-group-3", "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="eyebrow">Студия театра Вентилятор</div>
        <h1>Курсы<br>актёрского<br>мастерства</h1>
        <p class="lead hero__lead">Пять направлений, от трёх до девяти месяцев. Для взрослых, с нуля, в маленьких группах. Первое занятие — бесплатно.</p>
        <div class="hero__actions">
          <a class="btn" href="#nabor">Ближайшие наборы</a>
          <a class="btn btn--ghost" href="#raspisanie">Расписание занятий</a>
        </div>
      </div>
    </section>

    <section class="section" id="kursy">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Направления</div><h2>Пять курсов</h2></div></div>
        ${data.courses.map(c => {
          const t = trainerOf(c);
          return `<a class="crs reveal" href="course.html?id=${c.id}">
            <div class="crs__img"><img loading="lazy" src="${img(c.cover, "md")}" alt=""><div class="crs__num">${esc(c.num)}</div></div>
            <div class="crs__body">
              <h3 style="font-size:clamp(1.3rem,2.6vw,2rem)">${esc(c.title)}</h3>
              <p class="dim" style="margin-top:10px">${esc(c.subtitle)}</p>
              <div class="crs__meta">
                <span class="tag">${c.months} ${plural(c.months, "месяц", "месяца", "месяцев")}</span>
                <span class="tag">${c.lessons} ${plural(c.lessons, "занятие", "занятия", "занятий")}</span>
                <span class="tag">${money(c.price)} / мес</span>
              </div>
              <p class="small muted">Ведёт ${esc(t.name || "")}</p>
              <span class="link-more" style="margin-top:18px">Программа курса ${ARROW}</span>
            </div>
          </a>`;
        }).join("")}
      </div>
    </section>

    <section class="section band" id="nabor">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Набор</div><h2>Ближайшие запуски</h2></div>
          <p class="note" style="max-width:34ch">Курсы стартуют группами. Если мест не осталось — записывайтесь в лист ожидания, он реально работает.</p></div>
        ${starts.map(st => {
          const c = byId(data.courses, st.course) || {};
          const f = fmt(st.date + "T" + (st.time || "19:00"));
          const soon = st.status !== "open";
          const pct = st.seats ? Math.round((st.seats - st.left) / st.seats * 100) : 0;
          return `<div class="start">
            <div><div class="start__d mono">${f.d}</div><div class="start__m">${f.monShort} ${f.year}</div></div>
            <div>
              <div class="play__title" style="font-size:clamp(1.05rem,2vw,1.4rem)">${esc(c.title || st.course)}</div>
              <div class="play__info">
                <span>${esc(st.days || "")} · ${esc(st.time || "")}</span>
                <span>${c.months} ${plural(c.months || 0, "месяц", "месяца", "месяцев")}</span>
                ${st.note ? `<span>${esc(st.note)}</span>` : ""}
                ${soon ? "" : `<span class="fill ${st.left <= 4 ? "fill--hot" : "fill--ok"}"><span class="fill__bar"><i style="width:${pct}%"></i></span>${st.left > 0 ? "осталось " + st.left + " " + plural(st.left, "место", "места", "мест") : "мест нет"}</span>`}
              </div>
            </div>
            <div style="text-align:right">
              ${soon
                ? `<span class="tag tag--soon">Скоро</span>`
                : `<a class="btn btn--sm" href="course.html?id=${st.course}#zapis">${st.left > 0 ? "Записаться" : "В лист ожидания"}</a>`}
            </div>
          </div>`;
        }).join("")}
      </div>
    </section>

    <section class="section" id="raspisanie">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Расписание</div><h2>Занятия текущих групп</h2></div>
          <p class="note" style="max-width:32ch">Все занятия проходят по адресу ${esc(data.settings.address)}.</p></div>
        <div class="sched reveal">
          ${(data.schedule || []).map(d => `
            <div class="sched__day">
              <div class="sched__name">${esc(d.day)}</div>
              <div class="sched__items">
                ${d.items.map(i => `<div class="sched__i"><span class="sched__t mono">${esc(i[0])}</span>
                  <span>${i[1] ? `<a href="course.html?id=${i[1]}">${esc(i[2])}</a>` : esc(i[2])}</span></div>`).join("")}
              </div>
            </div>`).join("")}
        </div>
      </div>
    </section>

    <section class="section band">
      <div class="wrap center">
        <div class="eyebrow" style="justify-content:center">Как попробовать</div>
        <h2>Первое занятие бесплатно</h2>
        <p class="lead" style="max-width:54ch;margin:22px auto 30px">Приходите на любое занятие открытой группы, посмотрите изнутри и решайте. Записаться можно в телеграме — ответим в тот же день.</p>
        <a class="btn" href="${esc(data.settings.telegram)}" target="_blank" rel="noopener">Написать в Telegram</a>
      </div>
    </section>`;
  };

  /* ---------- Курс ---------- */
  PAGES.course = (data) => {
    const c = byId(data.courses, qp("id")) || data.courses[0];
    document.title = c.title + " — Студия театра Вентилятор";
    const t = byId(data.actors, c.trainer) || {};
    const starts = (data.starts || []).filter(x => x.course === c.id).sort((a, b) => D(a.date) - D(b.date));
    const next = starts[0];

    $("#app").innerHTML = `
    <section class="hero">
      <div class="hero__bg"><img src="${img(c.cover, "lg")}" alt=""></div>
      <div class="hero__in wrap">
        <div class="crumbs"><a href="studio.html">Студия</a> / <span>${esc(c.title)}</span></div>
        <div class="hero__meta">
          <span class="tag tag--accent">Курс ${esc(c.num)}</span>
          <span class="tag">${c.months} ${plural(c.months, "месяц", "месяца", "месяцев")}</span>
          <span class="tag">${esc(c.level)}</span>
        </div>
        <h1>${esc(c.title)}</h1>
        <p class="lead hero__lead">${esc(c.lead)}</p>
        <div class="hero__actions">
          <a class="btn" href="#zapis">${next ? "Записаться на " + fmt(next.date + "T12:00").d + " " + fmt(next.date + "T12:00").monShort : "Записаться"}</a>
          <a class="btn btn--ghost" href="#programma">Программа занятий</a>
        </div>
      </div>
    </section>

    <section class="section--tight section--line">
      <div class="wrap">
        <div class="facts">
          <div><b>${c.months} ${plural(c.months, "мес", "мес", "мес")}</b><span>Продолжительность</span></div>
          <div><b>${c.lessons}</b><span>${plural(c.lessons, "занятие", "занятия", "занятий")}</span></div>
          <div><b>${money(c.price)}</b><span>${esc(c.price_note)}</span></div>
          <div><b>${esc(t.name || "")}</b><span>Ведёт курс</span></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="split">
          <div>
            <div class="eyebrow">О курсе</div>
            <h2 style="font-size:clamp(1.5rem,3vw,2.2rem);margin-bottom:22px">${esc(c.subtitle)}</h2>
            <div class="prose">${c.about.map(p => `<p>${esc(p)}</p>`).join("")}</div>
            <dl class="dl" style="margin-top:30px">
              <dt>Формат</dt><dd>${esc(c.format)}</dd>
              <dt>Кому подходит</dt><dd>${esc(c.level)}</dd>
              <dt>Адрес</dt><dd>${esc(data.settings.address)}</dd>
            </dl>
          </div>
          <div>
            <div class="eyebrow">Что вы получите</div>
            <ul class="ticks">${c.result.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
          </div>
        </div>
      </div>
    </section>

    <section class="section band" id="programma">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Программа</div><h2>Программа занятий</h2></div>
          <p class="note">${c.lessons} ${plural(c.lessons, "занятие", "занятия", "занятий")} · ${c.program.length} ${plural(c.program.length, "модуль", "модуля", "модулей")}</p></div>
        <div class="mods reveal">
          ${c.program.map(m => `<div class="mod">
            <div><div class="mod__n">${esc(m[0])}</div><div class="mod__h">${esc(m[2])}</div></div>
            <div><div class="mod__t">${esc(m[1])}</div><div class="mod__d">${esc(m[3])}</div></div>
          </div>`).join("")}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="split">
          <div class="reveal"><img src="${img(t.photo, "md")}" alt="${esc(t.name)}" style="width:100%;border-radius:10px"></div>
          <div class="reveal">
            <div class="eyebrow">Тренер</div>
            <h2 style="font-size:clamp(1.6rem,3.2vw,2.4rem)">${esc(t.name || "")}</h2>
            <p style="color:var(--accent);font-weight:700;font-size:.82rem;letter-spacing:.1em;text-transform:uppercase;margin-top:10px">${esc(t.role || "")}</p>
            <div class="prose" style="margin-top:22px">${(t.bio || []).map(p => `<p>${esc(p)}</p>`).join("")}</div>
            <dl class="dl" style="margin-top:26px">
              ${t.education ? `<dt>Образование</dt><dd>${esc(t.education)}</dd>` : ""}
              ${t.since ? `<dt>В театре с</dt><dd>${esc(t.since)}</dd>` : ""}
              ${t.shows && t.shows.length ? `<dt>Спектакли</dt><dd>${t.shows.map(esc).join(", ")}</dd>` : ""}
            </dl>
          </div>
        </div>
      </div>
    </section>

    <section class="section section--line" id="zapis">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Запись</div><h2>Ближайшие группы</h2></div></div>
        ${starts.length ? starts.map(st => {
          const f = fmt(st.date + "T12:00");
          const soon = st.status !== "open";
          return `<div class="start">
            <div><div class="start__d mono">${f.d}</div><div class="start__m">${f.monShort} ${f.year}</div></div>
            <div>
              <div class="play__title" style="font-size:1.1rem">${esc(st.days || "")} · ${esc(st.time || "")}</div>
              <div class="play__info">
                <span>${soon ? "Запись откроется позже" : st.left > 0 ? "осталось " + st.left + " из " + st.seats : "мест нет, есть лист ожидания"}</span>
                ${st.note ? `<span>${esc(st.note)}</span>` : ""}
              </div>
            </div>
            <div style="text-align:right">
              ${soon ? `<span class="tag tag--soon">Скоро</span>`
                : `<a class="btn btn--sm" href="${esc(data.settings.telegram)}" target="_blank" rel="noopener">Записаться</a>`}
            </div>
          </div>`;
        }).join("") : '<p class="muted">Набор на этот курс сейчас закрыт — напишите нам, и мы сообщим о следующем запуске.</p>'}
        <div class="alert" style="margin-top:28px">Первое занятие бесплатное и ни к чему не обязывает. Напишите в <a href="${esc(data.settings.telegram)}" target="_blank" rel="noopener" style="color:var(--accent)">телеграм</a> или позвоните по телефону ${esc(data.settings.phone)}.</div>
      </div>
    </section>

    ${c.gallery && c.gallery.length ? `
    <section class="section band">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Как проходят занятия</div><h2>Фотографии</h2></div></div>
        ${galleryHTML(c.gallery)}
      </div>
    </section>` : ""}`;
    if (c.gallery && c.gallery.length) bindGallery($("#app"), c.gallery);
  };

  /* ---------- Билеты ---------- */
  PAGES.tickets = (data) => {
    let sess = byId(data.sessions, qp("session"));
    if (!sess) {
      const showId = qp("show");
      sess = upcoming(data, showId)[0] || upcoming(data)[0];
    }
    if (!sess) { $("#app").innerHTML = '<section class="section"><div class="wrap"><h2>Ближайших показов пока нет</h2></div></section>'; return; }
    const show = byId(data.shows, sess.show) || {};
    const f = fmt(sess.datetime);
    document.title = "Билеты · " + show.title + " — Театр Вентилятор";
    const sold = soldSet(sess.sold);
    const price = { a: sess.price_a, b: sess.price_b, c: sess.price_c };
    const other = upcoming(data, show.id).filter(x => x.id !== sess.id);

    const rowsHTML = HALL.rows.map(r => {
      const z = HALL.zone(r);
      const seats = [];
      for (let n = 1; n <= HALL.perRow; n++) {
        const code = r + n;
        const isSold = sold.has(code);
        seats.push(`<button class="seat z-${z}${isSold ? " is-sold" : ""}" data-seat="${code}" data-zone="${z}"
          ${isSold ? "disabled aria-label='Место занято'" : `title="${r} ряд, место ${n} — ${money(price[z])}"`}>${n}</button>`);
        if (n === HALL.aisleAfter) seats.push('<span class="gapx"></span>');
      }
      return `<div class="row"><span class="row__label">${r}</span><span class="seats">${seats.join("")}</span><span class="row__label">${r}</span></div>`;
    }).join("");

    $("#app").innerHTML = `
    <section class="section" style="padding-top:clamp(32px,5vw,56px);padding-bottom:0">
      <div class="wrap">
        <div class="crumbs"><a href="afisha.html">Афиша</a> / <a href="show.html?id=${show.id}">${esc(show.title)}</a> / <span>Билеты</span></div>
        <div class="head-row" style="margin-bottom:28px">
          <div>
            <div class="eyebrow">${f.d} ${f.mon} ${f.year}, ${f.wd}, ${f.time}</div>
            <h1 style="font-size:clamp(1.9rem,4.6vw,3.2rem)">${esc(show.title)}</h1>
            <p class="muted small" style="margin-top:10px">${esc(data.settings.hall_name)} · ${esc(data.settings.address)} · ${show.duration} мин · ${esc(show.age)}</p>
          </div>
          <div>${fillHTML(sess)}</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="split split--tickets">
          <div>
            <div class="hall">
              <div class="stage">Сцена</div>
              <div class="rows">${rowsHTML}</div>
              <div class="legend">
                <span><i class="l-a"></i>Ряды А–Б — ${money(price.a)}</span>
                <span><i class="l-b"></i>Ряды В–Г — ${money(price.b)}</span>
                <span><i></i>Ряды Д–Е — ${money(price.c)}</span>
                <span><i class="l-sold"></i>Занято</span>
                <span><i class="l-sel"></i>Ваш выбор</span>
              </div>
            </div>
            <p class="note" style="margin-top:16px">Зал маленький: с последнего ряда видно не хуже, чем с первого, но в первых двух рядах слышно дыхание актёров. Проход — между 5-м и 6-м местом.</p>
          </div>

          <aside>
            <div class="cart">
              <h3>Ваш заказ</h3>
              <div class="cart__list" id="cartList"><div class="cart__empty">Выберите места на схеме зала</div></div>
              <div class="cart__total"><span class="muted small">Итого</span><b id="cartTotal">0 ₽</b></div>
              <form id="orderForm">
                <label class="field"><span>Имя и фамилия</span><input name="name" required placeholder="Как вас зовут"></label>
                <label class="field"><span>Телефон</span><input name="phone" required type="tel" placeholder="+7 900 000-00-00"></label>
                <label class="field"><span>Почта (необязательно)</span><input name="email" type="email" placeholder="для электронного билета"></label>
                <button class="btn btn--block" type="submit" id="payBtn" disabled>Выбрать места</button>
              </form>
              <p class="note" style="margin-top:14px" id="payNote"></p>
            </div>
          </aside>
        </div>
      </div>
    </section>

    ${other.length ? `
    <section class="section band">
      <div class="wrap">
        <div class="head-row"><div><div class="eyebrow">Не подходит дата</div><h2>Другие показы</h2></div></div>
        ${other.map(x => playRow(data, x)).join("")}
      </div>
    </section>` : ""}

    <div class="modal" id="doneModal"><div class="modal__bd"></div>
      <div class="modal__box" style="max-width:560px"><button class="modal__x">✕</button>
        <div style="padding:clamp(28px,4vw,44px)" id="doneIn"></div></div></div>`;

    /* --- выбор мест --- */
    const chosen = [];
    const listEl = $("#cartList"), totalEl = $("#cartTotal"), payBtn = $("#payBtn"), noteEl = $("#payNote");
    const hasTimepad = !!(sess.timepad_id && String(sess.timepad_id).trim());

    function redraw() {
      if (!chosen.length) {
        listEl.innerHTML = '<div class="cart__empty">Выберите места на схеме зала</div>';
        totalEl.textContent = "0 ₽";
        payBtn.disabled = true; payBtn.textContent = "Выбрать места";
        noteEl.textContent = "";
        return;
      }
      listEl.innerHTML = chosen.map(c =>
        `<div class="cart__row"><span>Ряд ${c.seat[0]}, место ${c.seat.slice(1)} · ${HALL.zoneName[c.zone]}</span>
         <span><b>${money(c.price)}</b> <button type="button" data-rm="${c.seat}" aria-label="Убрать">✕</button></span></div>`).join("");
      const sum = chosen.reduce((a, c) => a + c.price, 0);
      totalEl.textContent = money(sum);
      payBtn.disabled = false;
      payBtn.textContent = hasTimepad ? "Оплатить на Timepad" : "Забронировать " + chosen.length + " " + plural(chosen.length, "билет", "билета", "билетов");
      noteEl.innerHTML = hasTimepad
        ? "Оплата проходит на защищённой странице Timepad. Электронный билет придёт на почту."
        : "Мы держим бронь до начала спектакля. Оплатить можно на входе или переводом — реквизиты пришлём в ответном сообщении.";
      $$("[data-rm]", listEl).forEach(b => b.onclick = () => toggle(b.dataset.rm));
    }
    function toggle(code) {
      const btn = $(`.seat[data-seat="${code}"]`);
      const i = chosen.findIndex(c => c.seat === code);
      if (i > -1) { chosen.splice(i, 1); btn.classList.remove("is-sel"); }
      else {
        if (chosen.length >= 8) { alert("За один раз можно взять не больше восьми билетов. Если нужен целый зал — напишите нам."); return; }
        chosen.push({ seat: code, zone: btn.dataset.zone, price: price[btn.dataset.zone] });
        btn.classList.add("is-sel");
      }
      redraw();
    }
    $$(".seat:not(.is-sold)").forEach(b => b.onclick = () => toggle(b.dataset.seat));
    redraw();

    /* --- оформление --- */
    $("#orderForm").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!chosen.length) return;
      const fd = new FormData(e.target);
      const order = {
        show: show.title,
        when: f.d + " " + f.mon + " " + f.year + ", " + f.time,
        seats: chosen.map(c => c.seat).join(", "),
        sum: chosen.reduce((a, c) => a + c.price, 0),
        name: fd.get("name"), phone: fd.get("phone"), email: fd.get("email") || ""
      };
      if (hasTimepad) return payTimepad(sess, order);
      return book(order, data);
    });

    /* --- Timepad --- */
    function payTimepad(sess, order) {
      const org = CFG.TIMEPAD_ORG || "";
      const evId = String(sess.timepad_id).trim();
      // Если виджет ещё не загружен — подключаем его и открываем попап
      if (!document.getElementById("tpwf-loader")) {
        const sc = document.createElement("script");
        sc.id = "tpwf-loader";
        sc.src = "https://timepad.ru/js/tpwf/loader/min/loader.js";
        sc.setAttribute("data-timepad-widget-v2", "event_register");
        if (CFG.TIMEPAD_CUSTOMIZATION) sc.setAttribute("data-timepad-customized", CFG.TIMEPAD_CUSTOMIZATION);
        sc.defer = true;
        sc.text = "(function(){return {" +
          '"event":{"id":"' + evId + '"},' +
          '"hidePreloading":true,' +
          '"display":"popup",' +
          '"popup":{"triggerSelector":"#payBtn"},' +
          '"prefill":{"name":"' + String(order.name).replace(/"/g, "") + '","mail":"' + String(order.email).replace(/"/g, "") + '"}' +
          "};})();";
        document.body.appendChild(sc);
        setTimeout(() => $("#payBtn").click(), 1200);
        return;
      }
      // запасной путь — открыть страницу события
      if (org && evId) window.open("https://" + org + ".timepad.ru/event/" + evId + "/", "_blank", "noopener");
    }

    /* --- бронь без Timepad --- */
    function book(order, data) {
      const text =
        "Бронь билетов\n" + order.show + "\n" + order.when + "\n" +
        "Места: " + order.seats + "\nСумма: " + money(order.sum) + "\n" +
        order.name + ", " + order.phone + (order.email ? ", " + order.email : "");
      if (CFG.BOOKING_FORM_URL) {
        const u = CFG.BOOKING_FORM_URL.includes("{order}")
          ? CFG.BOOKING_FORM_URL.replace("{order}", encodeURIComponent(text))
          : CFG.BOOKING_FORM_URL;
        window.open(u, "_blank", "noopener");
      }
      const m = $("#doneModal");
      $("#doneIn", m).innerHTML = `
        <div class="eyebrow">Бронь оформлена</div>
        <h2 style="font-size:clamp(1.5rem,3vw,2.2rem)">Места за вами</h2>
        <div class="alert alert--ok" style="margin-top:22px;white-space:pre-line">${esc(text)}</div>
        <p class="note">Чтобы бронь точно дошла, отправьте это сообщение нам в телеграм — одной кнопкой ниже. Мы подтвердим в течение дня.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px">
          <button class="btn btn--sm" id="copyBtn" type="button">Скопировать текст</button>
          <a class="btn btn--sm btn--ghost" href="${esc(data.settings.telegram)}" target="_blank" rel="noopener">Открыть телеграм</a>
          <a class="btn btn--sm btn--ghost" href="tel:${String(data.settings.phone).replace(/[^+\d]/g, "")}">Позвонить</a>
        </div>`;
      m.classList.add("is-on");
      const close = () => m.classList.remove("is-on");
      $(".modal__bd", m).onclick = close; $(".modal__x", m).onclick = close;
      $("#copyBtn", m).onclick = async () => {
        try { await navigator.clipboard.writeText(text); $("#copyBtn", m).textContent = "Скопировано"; }
        catch (err) { $("#copyBtn", m).textContent = "Выделите текст выше"; }
      };
    }
  };

  /* =========================================================
     СТАРТ
     ========================================================= */
  load().then(data => {
    try {
      chrome(data);
      const page = document.body.dataset.page;
      if (PAGES[page]) PAGES[page](data);
      reveal();
      // плавная прокрутка к якорю из адреса
      if (location.hash) {
        const t = document.querySelector(location.hash);
        if (t) setTimeout(() => t.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
      }
    } catch (e) {
      console.error(e);
      $("#app").innerHTML = '<section class="section"><div class="wrap"><h2>Что-то пошло не так</h2><p class="muted">Обновите страницу. Если не помогло — напишите нам.</p></div></section>';
    }
  });
})();
