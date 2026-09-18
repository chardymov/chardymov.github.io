/* ============================================================
   Загрузка данных: Google-таблица → иначе демо-данные
   ============================================================ */
(function () {
  const CFG = window.VENT_CONFIG || {};
  const SEP = "|";      // разделитель абзацев/пунктов внутри ячейки
  const PAIR = "::";    // разделитель «ключ::значение» в титрах

  /* ---------- утилиты ---------- */
  const splitList = (v) => String(v || "").split(SEP).map(s => s.trim()).filter(Boolean);
  const splitIds  = (v) => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

  /* Путь к картинке. Если в таблице указана полная ссылка — берём её. */
  function img(slug, size) {
    if (!slug) return "assets/img/logo.png";
    const s = String(slug).trim();
    if (/^https?:\/\//i.test(s)) return s;
    return "assets/img/" + s + "-" + (size || "md") + ".jpg";
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else {
        if (c === '"') q = true;
        else if (c === ",") { row.push(cell); cell = ""; }
        else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else if (c !== "\r") cell += c;
      }
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ""));
  }

  function toObjects(rows) {
    if (!rows.length) return [];
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    return rows.slice(1).map(r => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = (r[i] === undefined ? "" : String(r[i]).trim()); });
      return o;
    });
  }

  async function fetchSheet(id, name) {
    const url = "https://docs.google.com/spreadsheets/d/" + id +
      "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(name);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(name + ": HTTP " + res.status);
    return toObjects(parseCSV(await res.text()));
  }

  /* ---------- превращаем строки таблицы в структуру сайта ---------- */
  function build(raw, fallback) {
    const out = JSON.parse(JSON.stringify(fallback));

    if (raw.settings && raw.settings.length) {
      const s = {};
      raw.settings.forEach(r => { if (r.key) s[r.key] = r.value; });
      Object.keys(s).forEach(k => {
        out.settings[k] = (k === "director_letter") ? splitList(s[k]) : s[k];
      });
    }

    if (raw.shows && raw.shows.length) {
      out.shows = raw.shows.map(r => ({
        id: r.id, title: r.title, subtitle: r.subtitle, genre: r.genre, age: r.age,
        duration: +r.duration || 0, premiere: r.premiere, director: r.director,
        status: r.status || "active", poster: r.poster, cover: r.cover || r.poster,
        lead: r.lead, description: splitList(r.description),
        gallery: splitIds(r.gallery), cast: splitIds(r.cast),
        credits: splitList(r.credits).map(x => x.split(PAIR).map(y => y.trim()))
      }));
    }

    if (raw.sessions && raw.sessions.length) {
      out.sessions = raw.sessions.map(r => ({
        id: r.id, show: r.show, datetime: r.datetime,
        price_a: +r.price_a || 0, price_b: +r.price_b || 0, price_c: +r.price_c || 0,
        timepad_id: r.timepad_id || "", sold: r.sold || ""
      }));
    }

    const people = [];
    (raw.actors || []).concat(raw.trainers || []).forEach(r => {
      if (!r.id) return;
      people.push({
        id: r.id, name: r.name, role: r.role, photo: r.photo, since: r.since,
        profession: r.profession, education: r.education,
        bio: splitList(r.bio), shows: splitList(r.shows).length ? splitList(r.shows) : splitIds(r.shows),
        contact: r.contact
      });
    });
    if (people.length) out.actors = people;

    if (raw.courses && raw.courses.length) {
      const prog = {};
      (raw.program || []).forEach(r => {
        (prog[r.course] = prog[r.course] || []).push([r.module, r.title, r.hours, r.description]);
      });
      out.courses = raw.courses.map(r => ({
        id: r.id, num: r.num, title: r.title, subtitle: r.subtitle,
        months: +r.months || 0, lessons: +r.lessons || 0, format: r.format, level: r.level,
        price: +r.price || 0, price_note: r.price_note, trainer: r.trainer,
        cover: r.cover, gallery: splitIds(r.gallery), lead: r.lead,
        about: splitList(r.about), result: splitList(r.result),
        program: prog[r.id] || []
      }));
    }

    if (raw.starts && raw.starts.length) {
      out.starts = raw.starts.map(r => ({
        id: r.id, course: r.course, date: r.date, time: r.time, days: r.days,
        seats: +r.seats || 0, left: +r.left || 0, status: r.status || "open", note: r.note
      }));
    }

    if (raw.schedule && raw.schedule.length) {
      const byDay = {};
      const order = [];
      raw.schedule.forEach(r => {
        if (!byDay[r.day]) { byDay[r.day] = []; order.push(r.day); }
        byDay[r.day].push([r.time, r.course || "", r.title]);
      });
      out.schedule = order.map(d => ({ day: d, items: byDay[d] }));
    }

    return out;
  }

  /* ---------- кэш ---------- */
  const CKEY = "vent_cache_v1";
  function readCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CKEY) || "null");
      if (!c) return null;
      if (Date.now() - c.t > (CFG.CACHE_MINUTES || 10) * 60000) return null;
      return c.d;
    } catch (e) { return null; }
  }
  function writeCache(d) {
    try { sessionStorage.setItem(CKEY, JSON.stringify({ t: Date.now(), d: d })); } catch (e) { }
  }

  /* ---------- публичный API ---------- */
  let ready = null;
  function load() {
    if (ready) return ready;
    const fallback = window.VENT_DATA;
    ready = (async () => {
      if (!CFG.SHEET_ID) { const d = fallback; d.__source = "demo"; return d; }
      const cached = readCache();
      if (cached) { cached.__source = "sheet-cache"; return cached; }
      try {
        const names = CFG.SHEETS || [];
        const raw = {};
        const res = await Promise.all(names.map(n =>
          fetchSheet(CFG.SHEET_ID, n).catch(() => null)
        ));
        names.forEach((n, i) => { if (res[i]) raw[n] = res[i]; });
        if (!Object.keys(raw).length) throw new Error("таблица недоступна");
        const d = build(raw, fallback);
        writeCache(d);
        d.__source = "sheet";
        return d;
      } catch (e) {
        console.warn("[Вентилятор] Не удалось прочитать Google-таблицу, показываю запасные данные:", e.message);
        const d = fallback; d.__source = "fallback";
        return d;
      }
    })();
    return ready;
  }

  window.VENT = { load, img, splitList, splitIds, CFG };
})();
