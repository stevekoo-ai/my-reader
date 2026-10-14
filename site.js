/* 말씀 리더 — 정적 사이트(GitHub Pages)용 데이터 계층.
 * PC 서버(/api/...) 대신 암호화된 data/*.bin을 받아 브라우저에서 풀고, 같은 모양의 응답을 돌려준다.
 * app.js의 api()가 window.STATIC_API가 있으면 이것을 부른다.
 * - 키: PBKDF2-SHA256(비밀번호, salt, 60만 회) → 앞 32바이트 = AES-256-GCM 키
 * - 파일: nonce(12) + AES-GCM(gzip(JSON))
 * - 밑줄·노트: 이 기기의 localStorage (처음 한 번 PC의 노트를 씨앗으로 넣음)
 */
'use strict';

(() => {
  const KEY_STORE = 'mr.key';
  const NOTE_STORE = 'mr.userdata';
  let key = null, man = null;
  const chunks = new Map();                       // 파일명 → Promise(풀린 데이터)
  let readyResolve;
  const ready = new Promise(r => (readyResolve = r));

  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u8 => btoa(String.fromCharCode(...u8));
  const now = () => new Date().toISOString().slice(0, 19);
  const qs = path => Object.fromEntries(new URL(path, location.href).searchParams);

  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 512);
    return new Uint8Array(bits).slice(0, 32);
  }

  async function open(blob) {          // nonce + 암호문 → 원문 바이트
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, key, u8.slice(12));
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const openJSON = async blob => JSON.parse(new TextDecoder().decode(await open(blob)));

  function load(fn) {
    if (!fn) return Promise.resolve(null);
    if (!chunks.has(fn)) {
      const p = fetch('data/' + fn).then(r => { if (!r.ok) throw new Error('자료를 받지 못했습니다'); return r.arrayBuffer(); }).then(openJSON);
      p.catch(() => chunks.delete(fn));
      chunks.set(fn, p);
      if (chunks.size > 80) chunks.delete(chunks.keys().next().value);   // 메모리 절약
    }
    return chunks.get(fn);
  }

  /* ---------------------------------------------------------------- 로그인 */
  async function unlock(rawKey, meta) {
    key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    await open(b64(meta.check));                                // 비밀번호가 틀리면 여기서 실패
    man = await openJSON(b64(meta.manifest));
    sessionStorage.setItem('mr.skey', toB64(new Uint8Array(rawKey)));   // 지도 보기(map.html)용 — 이 탭에서만
    await seedNotes();
    readyResolve();
  }

  async function boot() {
    let meta;
    try { meta = await fetch('meta.json', { cache: 'no-cache' }).then(r => r.json()); }
    catch { return showLogin(null, '사이트 정보를 받지 못했습니다. 인터넷 연결을 확인하세요.'); }
    if (!window.crypto?.subtle || !window.DecompressionStream) return showLogin(null, '이 브라우저는 지원하지 않습니다. 최신 Chrome·Safari를 사용하세요.');
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) {
      try { return await unlock(b64(saved), meta); } catch { localStorage.removeItem(KEY_STORE); }
    }
    showLogin(meta);
  }

  function showLogin(meta, fatal) {
    const box = document.createElement('div');
    box.id = 'siteLogin';
    box.innerHTML = `
      <form>
        <h1>말씀 리더</h1>
        <p>${fatal ? fatal : '비밀번호를 입력하세요.'}</p>
        ${fatal ? '' : `<input type="password" autocomplete="current-password" required autofocus>
        <label><input type="checkbox" checked> 이 기기 기억하기</label>
        <button>열기</button><div class="err"></div>`}
      </form>`;
    document.body.appendChild(box);
    if (fatal) return;
    const form = box.querySelector('form'), err = box.querySelector('.err'), btn = box.querySelector('button');
    form.onsubmit = async e => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = '여는 중…'; err.textContent = '';
      try {
        const raw = await deriveKey(form.querySelector('input[type=password]').value, b64(meta.salt), meta.iter);
        await unlock(raw, meta);
        if (form.querySelector('input[type=checkbox]').checked) localStorage.setItem(KEY_STORE, toB64(raw));
        box.remove();
      } catch {
        err.textContent = '비밀번호가 맞지 않습니다.';
        btn.disabled = false; btn.textContent = '열기';
      }
    };
  }

  /* ---------------------------------------------------------------- 밑줄·노트 (이 기기) */
  function store() {
    try { return JSON.parse(localStorage.getItem(NOTE_STORE)) || null; } catch { return null; }
  }
  function saveStore(d) { localStorage.setItem(NOTE_STORE, JSON.stringify(d)); }
  async function seedNotes() {
    if (store()) return;
    const seed = man.seed ? await load(man.seed) : null;
    const d = { notes: seed?.notes || [], highlights: seed?.highlights || [], next: 1 };
    d.next = Math.max(0, ...d.notes.map(n => n.id), ...d.highlights.map(h => h.id)) + 1;
    saveStore(d);
  }

  /* ---------------------------------------------------------------- 본문 도우미 */
  const vmeta = id => man.versions.find(v => v.id === id);
  async function chapter(vid, b, c) {
    const book = await load(man.files[vid]?.[b]);
    return book?.[c] || [];
  }
  const plain = h => String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  function speechText(html) {
    let t = String(html).replace(/<div class="fn">[\s\S]*?<\/div>/g, ' ')
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/g, '').replace(/<span class="hd">[\s\S]*?<\/span>/g, ' ')
      .replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '');
    t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    return t.replace(/〔[^〕]*〕/g, ' ').replace(/[\[\]¶○◎▷*]|[①-⑳]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ---------------------------------------------------------------- /api/... 흉내 */
  const handlers = {
    'GET /api/meta': async () => ({
      books: man.books, groups: man.groups, wiki: false, remote: false, static: true, backup: null,
      versions: man.versions.map(({ id, name, kind, lang, desc }) => ({ id, name, kind, lang, desc })),
    }),

    'GET /api/chapter': async q => {
      const vm = vmeta(q.v); if (!vm) return null;
      const rows = await chapter(q.v, +q.b, +q.c);
      return { version: q.v, kind: vm.kind, book: +q.b, chapter: +q.c,
        verses: rows.map(([v, x]) => (vm.kind === 'parse' ? { v, rows: x } : { v, html: x })) };
    },

    'GET /api/verse': async q => {
      const v = +q.v, ev = +(q.ev || q.v);
      const out = [];
      for (const vid of (q.vs || '').split(',').filter(x => vmeta(x))) {
        const rows = (await chapter(vid, +q.b, +q.c)).filter(([n]) => n >= v && n <= ev);
        const parse = vmeta(vid).kind === 'parse';
        out.push({ version: vid, html: rows.map(([n, h]) => (ev > v ? `<sup class="vno">${n}</sup>` : '') + (parse ? '' : h)).join(' ') });
      }
      return out;
    },

    'GET /api/comm': async q => {
      const b = +q.b, c = +q.c, v = +q.v, out = [];
      for (const vm of man.versions.filter(x => x.kind === 'commentary')) {
        const rows = (await chapter(vm.id, b, c)).filter(([n]) => n <= v);
        if (!rows.length) continue;
        const [n, html] = rows.at(-1);
        if (plain(html)) out.push({ version: vm.id, verse: n, exact: n === v, html });
      }
      const ko = h => /[가-힣]/.test(plain(h).slice(0, 200));
      return out.sort((a, b) => (ko(b.html) - ko(a.html)) || (b.exact - a.exact) || a.version.localeCompare(b.version));
    },

    'GET /api/lex': async q => {
      const code = String(q.s).toUpperCase();
      const m = code.match(/^([GH])(\d+)$/);
      const chunk = m ? await load(man.lex[`${m[1]}${Math.floor(+m[2] / 250)}`]) : null;
      return { code, entries: chunk?.[code] || {} };
    },

    'GET /api/search': async q => {
      const idx = await load(man.search[q.v]);
      if (!idx) return { total: 0, results: [] };
      const words = String(q.q || '').split(/\s+/).filter(Boolean);
      if (!words.length) return { total: 0, results: [] };
      const sc = q.scope || 'all';
      const hit = idx.filter(([b, , , t]) =>
        (sc === 'all' || (sc === 'ot' && b <= 39) || (sc === 'nt' && b >= 40) || (sc[0] === 'b' && b === +sc.slice(1)))
        && words.every(w => t.includes(w)));
      return { total: hit.length, results: hit.slice(0, 500).map(([b, c, v, t]) => ({ b, c, v, t })) };
    },

    'GET /api/highlights': async q => store().highlights.filter(h => h.book === +q.b && h.chapter === +q.c),
    'POST /api/highlights': async (q, d) => {
      const s = store(); const h = { ...d, id: s.next++, created: now() };
      s.highlights.push(h); saveStore(s); return h;
    },
    'GET /api/notes': async q => {
      const s = store();
      if (q.b) return s.notes.filter(n => n.book === +q.b && n.chapter === +q.c).sort((a, b) => a.verse - b.verse || a.id - b.id);
      const w = q.q || '';
      return s.notes.filter(n => (n.body || '').includes(w) || (n.quote || '').includes(w)).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    },
    'POST /api/notes': async (q, d) => {
      const s = store(); const n = { ...d, everse: d.everse || d.verse, id: s.next++, created: now(), updated: now() };
      s.notes.push(n); saveStore(s); return n;
    },
    'POST /api/logout': async () => { localStorage.removeItem(KEY_STORE); return { ok: true }; },
    'POST /api/backup': async () => { exportJSON(); return { last: now(), error: null }; },

    'GET /api/maps': async () => man.maps.map(m => ({ name: m.name, title: m.title, size: m.size, updated: '', kml: null })),
    'GET /api/tts/voices': async () => ({ available: false, voices: [], default: '' }),
    'GET /api/tts/chapter': async () => ({ error: 'static' }),          // → player.js가 기기 음성으로 읽음
    'GET /api/tts/text': async q => {
      let vid = q.v;
      const vm = vmeta(vid);
      if (!vm || !['bible', 'strong'].includes(vm.kind)) return { error: '이 자료는 소리로 읽기를 지원하지 않습니다' };
      if (vm.kind === 'strong') { const base = vid === 'KJV_S' ? 'KJV1769' : vid.replace(/S$/, ''); if (vmeta(base)) vid = base; }
      const b = +q.b, c = +q.c, m = vmeta(vid);
      const locale = b >= 40 ? m.loc_nt : m.loc_ot;
      if (!locale) return { error: '읽을 수 있는 음성 언어를 찾지 못했습니다' };
      const items = [];
      const bk = man.books[b - 1];
      if (q.heading !== '0') {
        if (locale === 'ko-KR') items.push({ v: 0, t: `${bk.ko} ${c}장.` });
        else if (locale.startsWith('en')) items.push({ v: 0, t: `${bk.en}, chapter ${c}.` });
      }
      for (const [v, h] of await chapter(vid, b, c)) items.push({ v, t: speechText(h) });
      return { locale, items };
    },
  };

  // PUT·DELETE /api/(highlights|notes)/id
  async function modify(method, path, d) {
    const m = path.match(/^\/api\/(highlights|notes)\/(\d+)$/);
    if (!m) return null;
    const s = store(), list = s[m[1]], id = +m[2];
    const i = list.findIndex(x => x.id === id);
    if (method === 'DELETE') {
      if (i >= 0) list.splice(i, 1);
      if (m[1] === 'highlights') s.notes.forEach(n => { if (n.highlight_id === id) n.highlight_id = null; });
      saveStore(s); return { ok: true };
    }
    if (i < 0) return {};
    const allowed = m[1] === 'highlights' ? ['color', 'style'] : ['body', 'quote'];
    for (const k of allowed) if (k in d) list[i][k] = d[k];
    if (m[1] === 'notes') list[i].updated = now();
    saveStore(s); return list[i];
  }

  window.STATIC_API = async (path, opts = {}) => {
    await ready;
    const method = opts.method || 'GET';
    const route = path.split('?')[0];
    const d = opts.body || {};
    const h = handlers[`${method} ${route}`];
    const r = h ? await h(qs(path), d) : (method === 'PUT' || method === 'DELETE') ? await modify(method, route, d) : null;
    if (r === null || r === undefined) throw new Error('지원하지 않는 기능입니다');
    return r;
  };

  /* ---------------------------------------------------------------- 내보내기·지도 */
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportJSON() {
    download(`말씀리더_노트백업_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store(), null, 1), 'application/json');
  }
  function exportMarkdown() {
    const s = store(), lines = [`# 말씀 리더 노트 (${new Date().toISOString().slice(0, 10)})`, ''];
    for (const n of [...s.notes].sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse)) {
      let ref = `${man.books[n.book - 1].ko} ${n.chapter}:${n.verse}`;
      if (n.everse && n.everse !== n.verse) ref += `-${n.everse}`;
      lines.push(`## ${ref}` + (n.version ? ` (${n.version})` : ''));
      if (n.quote) lines.push(`> ${n.quote}`, '');
      lines.push(n.body || '', '', `<sub>${n.updated}</sub>`, '');
    }
    download(`말씀리더_노트_${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n'), 'text/markdown');
  }
  window.SITE = {
    exportJSON, exportMarkdown,
    importJSON(file) {
      return file.text().then(t => {
        const d = JSON.parse(t);
        if (!Array.isArray(d.notes) || !Array.isArray(d.highlights)) throw new Error('노트 백업 파일이 아닙니다');
        const s = store();
        const key = x => [x.book, x.chapter, x.verse ?? x.sv, x.body ?? x.so, x.created].join('|');
        const have = new Set([...s.notes, ...s.highlights].map(key));
        let added = 0;
        for (const kind of ['notes', 'highlights']) for (const x of d[kind]) {
          if (have.has(key(x))) continue;
          s[kind].push({ ...x, id: s.next++ }); added++;
        }
        saveStore(s);
        return added;
      });
    },
  };

  // 서버 경로로 된 링크(노트 내보내기·지도)를 가로채 브라우저 안에서 처리
  document.addEventListener('click', async e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href === '/api/notes/export') { e.preventDefault(); return exportMarkdown(); }
    if (href.startsWith('/maps/')) {
      e.preventDefault();
      const name = decodeURIComponent(href.slice(6));
      const m = man.maps.find(x => x.name === name);
      if (!m) return;
      const url = 'map.html#' + m.file;               // map.html이 풀어서 그린다 (뒤로 가기로 리더 복귀)
      if (a.target === '_blank') window.open(url, '_blank'); else location.href = url;
    }
  }, true);

  // 로그인 화면 스타일
  const css = document.createElement('style');
  css.textContent = `
    #siteLogin { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg, #f4f2ee); }
    #siteLogin form { width: min(360px, 100%); background: var(--paper, #fff); border: 1px solid var(--line, #ddd); border-radius: 14px; padding: 28px 24px; font-family: "Noto Sans KR", "Malgun Gothic", sans-serif; }
    #siteLogin h1 { margin: 0 0 4px; font-family: "Noto Serif KR", serif; font-size: 24px; color: var(--accent, #8a5a2b); }
    #siteLogin p { margin: 0 0 20px; font-size: 13px; color: var(--muted, #777); }
    #siteLogin input[type=password] { width: 100%; font-size: 16px; padding: 11px 12px; border: 1px solid var(--line, #ddd); border-radius: 8px; background: var(--bg, #f4f2ee); color: var(--ink, #222); }
    #siteLogin label { display: flex; gap: 6px; align-items: center; margin: 12px 0 18px; font-size: 13px; color: var(--muted, #777); }
    #siteLogin button { width: 100%; font-size: 15px; padding: 11px; border: 0; border-radius: 8px; background: var(--accent, #8a5a2b); color: #fff; font-weight: 600; }
    #siteLogin .err { color: #c0392b; font-size: 13px; min-height: 18px; margin-top: 10px; }`;
  document.head.appendChild(css);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
