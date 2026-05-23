// ==UserScript==
// @name         Lolz — Фильтр раздач
// @namespace    https://lolz.live/
// @version      12.4
// @description  Фильтр тем lolz.live на основе официального API. Поддержка XenForo 1 (id="thread-NNNN") и XenForo 2.
// @author       FTPDev (lolz.live/ftpdev)
// @homepageURL  https://github.com/FTPLabs/Lolzhide
// @supportURL   https://lolz.live/ftpdev
// @match        https://lolz.live/forums/*
// @match        https://lolz.guru/forums/*
// @match        https://zelenka.guru/forums/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      prod-api.lolz.live
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    //  КОНСТАНТЫ
    // ═══════════════════════════════════════════════════════════════

    const API           = 'https://prod-api.lolz.live';
    const CACHE_TTL     = 5 * 60 * 1000;   // 5 минут
    const REQ_DELAY     = 220;              // мс между запросами (API: 300 req/min → ≥200 мс)
    const MAX_RETRY     = 3;
    const RETRY_BASE_MS = 1000;
    const VERSION       = '12.4';

    // Читаемые названия групп (lolz.live)
    const GROUP_NAMES = { 21: 'Local', 22: 'Resident', 23: 'Expert', 60: 'Guru', 351: 'AI' };
    const SCRIPT_RAW_URL = 'https://raw.githubusercontent.com/FTPLabs/Lolzhide/main/lolz-filter.user.js';
    const SCRIPT_INSTALL_URL = 'https://raw.githubusercontent.com/FTPLabs/Lolzhide/main/lolz-filter.user.js';

    let _latestVersion = null;

    function autoFetchUserInfo() {
        if (!cfg.apiKey || _tokenInvalid) return;
        if (Number(cfg.userGrpId) > 0) return; // уже известен
        log('group_id не установлен — запрашиваем /users/me автоматически');
        GM_xmlhttpRequest({
            method:  'GET',
            url:     `${API}/users/me`,
            headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Accept': 'application/json' },
            timeout: 10000,
            onload(r) {
                if (r.status === 401 || r.status === 403) {
                    _tokenInvalid = true;
                    updateBadge();
                    return;
                }
                try {
                    const d = JSON.parse(r.responseText);
                    if (d.errors) return;
                    const u    = d.user ?? d;
                    const grp  = u.user_group_id ?? 0;
                    const name = u.username ?? '';
                    if (grp)  { cfg.userGrpId = grp;  gmSet('userGrpId', grp); }
                    if (name) { cfg.userName  = name; gmSet('userName',  name); }
                    log(`Авто: группа=${grp} (${GROUP_NAMES[grp] ?? '?'}), user=${name}`);
                    // Перезапускаем фильтр с новыми данными
                    if (cfg.hideGrp) { clearCache(currentForumId()); run(); }
                } catch {}
            },
            onerror()   {},
            ontimeout() {},
        });
    }

    function checkUpdate() {
        GM_xmlhttpRequest({
            method:  'GET',
            url:     SCRIPT_RAW_URL + '?_=' + Date.now(),
            timeout: 8000,
            onload(r) {
                if (r.status !== 200) return;
                const m = r.responseText.match(/\/\/ @version\s+([\d.]+)/);
                if (!m) return;
                _latestVersion = m[1];
                if (_latestVersion !== VERSION) showUpdateBadge();
            },
            onerror() {},
            ontimeout() {},
        });
    }

    function showUpdateBadge() {
        const el = document.getElementById('lolzfp-badge');
        if (!el) return;
        el.innerHTML = `🆕 Новая версия <b>${_latestVersion}</b>! <a href="${SCRIPT_INSTALL_URL}" target="_blank" style="color:#7eb8f7;text-decoration:underline;">Обновить</a>`;
        el.style.color = '#7eb8f7';
    }

    // ── GM-ключи: новые (lolzfp_*) + старые (lolz_*) для обратной совместимости ──
    const K = {
        apiKey:       ['lolzfp_api_key',        'lolz_api_key'],
        userGrpId:    ['lolzfp_user_group_id',   'lolz_user_group_id'],
        userName:     ['lolzfp_username'],
        forums:       ['lolzfp_forums',           'lolz_forums'],
        hideGrp:      ['lolzfp_hide_grp',         'lolz_hide_grp'],
        hideCantPart: ['lolzfp_hide_cantpart'],
        hideKw:       ['lolzfp_hide_kw'],
        peekMode:     ['lolzfp_peek'],
        verbose:      ['lolzfp_verbose'],
    };

    function gmGet(key, def) {
        for (const k of K[key]) {
            const v = GM_getValue(k, null);
            if (v !== null) return v;
        }
        return def;
    }
    function gmSet(key, val) { GM_setValue(K[key][0], val); }

    const DEFAULT_FORUMS = ['840'];

    // ═══════════════════════════════════════════════════════════════
    //  КОНФИГ
    // ═══════════════════════════════════════════════════════════════

    const cfg = {
        apiKey:       gmGet('apiKey',       ''),
        userGrpId:    gmGet('userGrpId',    0),
        userName:     gmGet('userName',     ''),
        hideGrp:      gmGet('hideGrp',      false),
        hideCantPart: gmGet('hideCantPart', false),
        hideKw:       gmGet('hideKw',       ''),
        peekMode:     gmGet('peekMode',     false),
        verbose:      gmGet('verbose',      false),
    };

    function saveCfg(cfgKey, val) {
        cfg[cfgKey] = val;
        gmSet(cfgKey, val);
    }

    function log(...args) {
        if (cfg.verbose) console.log('[LolzFilter]', ...args);
    }

    // ═══════════════════════════════════════════════════════════════
    //  НАВИГАЦИЯ
    // ═══════════════════════════════════════════════════════════════

    function currentForumId() {
        const m = location.pathname.match(/\/forums\/(\d+)/);
        return m ? m[1] : null;
    }

    function currentPage() {
        const m = location.search.match(/[?&]page=(\d+)/);
        return m ? parseInt(m[1], 10) : 1;
    }

    function activeForums() {
        const saved = gmGet('forums', '');
        return saved
            ? saved.split(',').map(s => s.trim()).filter(Boolean)
            : DEFAULT_FORUMS;
    }

    function isActiveSection() {
        const fid = currentForumId();
        return !!(fid && activeForums().includes(fid));
    }

    // ═══════════════════════════════════════════════════════════════
    //  КЭШ — sessionStorage
    // ═══════════════════════════════════════════════════════════════

    function _ck(fid, page) { return `lolzfp_${fid}_${page}`; }

    function getCached(fid, page) {
        try {
            const raw = sessionStorage.getItem(_ck(fid, page));
            if (!raw) return null;
            const { ts, data } = JSON.parse(raw);
            if (Date.now() - ts > CACHE_TTL) {
                sessionStorage.removeItem(_ck(fid, page));
                return null;
            }
            return new Map(data);
        } catch { return null; }
    }

    function setCached(fid, page, map) {
        try {
            sessionStorage.setItem(_ck(fid, page), JSON.stringify({
                ts: Date.now(),
                data: [...map.entries()],
            }));
        } catch {}
    }

    function clearCache(fid) {
        try {
            const prefix = fid ? `lolzfp_${fid}_` : 'lolzfp_';
            Object.keys(sessionStorage)
                .filter(k => k.startsWith(prefix))
                .forEach(k => sessionStorage.removeItem(k));
        } catch {}
    }

    // ═══════════════════════════════════════════════════════════════
    //  RATE-LIMIT ОЧЕРЕДЬ (300 req/min → ≥200 мс между запросами)
    // ═══════════════════════════════════════════════════════════════

    const _q = [];
    let _qBusy = false;

    function enqueue(fn) {
        return new Promise((resolve, reject) => {
            _q.push({ fn, resolve, reject });
            if (!_qBusy) _drain();
        });
    }

    function _enqueueFront(fn) {
        return new Promise((resolve, reject) => {
            _q.unshift({ fn, resolve, reject });
            if (!_qBusy) _drain();
        });
    }

    function _drain() {
        if (!_q.length) { _qBusy = false; return; }
        _qBusy = true;
        const { fn, resolve, reject } = _q.shift();
        fn().then(resolve).catch(reject).finally(() => setTimeout(_drain, REQ_DELAY));
    }

    // ═══════════════════════════════════════════════════════════════
    //  API-КЛИЕНТ
    //
    //  Ошибки:
    //    401 / 403 → немедленный reject (не retry), устанавливает флаг
    //    429       → exponential backoff; retry встаёт обратно в очередь
    //    5xx       → retry через очередь
    //    JSON err  → reject без retry
    // ═══════════════════════════════════════════════════════════════

    let _tokenInvalid = false;

    function _formatApiErrors(errors) {
        if (Array.isArray(errors)) return errors.join('; ');
        if (typeof errors === 'object') return JSON.stringify(errors);
        return String(errors);
    }

    function _rawGet(path, attempt = 0) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method:  'GET',
                url:     API + path,
                headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Accept': 'application/json' },
                timeout: 15000,
                onload(r) {
                    // Авторизация: не retry, сразу инвалидируем
                    if (r.status === 401 || r.status === 403) {
                        _tokenInvalid = true;
                        const msg = r.status === 401
                            ? '401: токен недействителен или истёк'
                            : '403: нет доступа (проверь права токена)';
                        reject(new Error(msg));
                        return;
                    }

                    // Rate limit: retry через exponential backoff, но возвращаем
                    // управление обратно в очередь чтобы не создавать параллельные запросы
                    if (r.status === 429) {
                        if (attempt < MAX_RETRY) {
                            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                            log(`429 rate limit, retry #${attempt + 1} через ${delay}мс`);
                            // Встаём обратно в очередь через delay
                            setTimeout(() => {
                                enqueue(() => _rawGet(path, attempt + 1))
                                    .then(resolve)
                                    .catch(reject);
                            }, delay);
                        } else {
                            reject(new Error('429: превышен лимит запросов, попробуй позже'));
                        }
                        return;
                    }

                    // Серверные ошибки: retry
                    if (r.status >= 500 && attempt < MAX_RETRY) {
                        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                        log(`${r.status} сервер, retry #${attempt + 1} через ${delay}мс`);
                        setTimeout(() => {
                            _enqueueFront(() => _rawGet(path, attempt + 1))
                                .then(resolve)
                                .catch(reject);
                        }, delay);
                        return;
                    }

                    // Успешный ответ или финальная ошибка
                    let d;
                    try { d = JSON.parse(r.responseText); }
                    catch { reject(new Error(`JSON parse error (HTTP ${r.status})`)); return; }

                    if (d.errors) {
                        reject(new Error(_formatApiErrors(d.errors)));
                    } else {
                        resolve(d);
                    }
                },
                onerror()   { reject(new Error('Ошибка сети'));        },
                ontimeout() { reject(new Error('Таймаут запроса'));     },
            });
        });
    }

    function apiGet(path) { return enqueue(() => _rawGet(path)); }

    // ═══════════════════════════════════════════════════════════════
    //  ЗАГРУЗКА ТРЕДОВ
    //
    //  GET /threads?forum_id=X&page=Y&limit=L&fields_include=*
    //              &fields_exclude=first_post,last_post
    //
    //  Поле fields_include для /threads поддерживает только "*" или "latest_posts".
    //  fields_exclude убирает тяжёлые поля first_post и last_post.
    //  limit=50 — запрашиваем 50 тредов за раз (форум показывает до 50 на странице).
    // ═══════════════════════════════════════════════════════════════

    const THREADS_PER_PAGE = 50;

    async function loadPage(fid, page) {
        const hit = getCached(fid, page);
        if (hit) {
            log(`кэш: ${hit.size} тредов (forum=${fid} page=${page})`);
            return hit;
        }

        const qs = `?forum_id=${fid}&page=${page}&limit=${THREADS_PER_PAGE}&fields_include=*&fields_exclude=first_post,last_post`;
        log(`API запрос: /threads${qs}`);

        const data = await apiGet('/threads' + qs);

        const map = new Map();
        for (const t of (data.threads ?? [])) {
            map.set(String(t.thread_id), t);
        }
        log(`API вернул ${map.size} тредов`);
        setCached(fid, page, map);
        return map;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ЛОГИКА СКРЫТИЯ
    //
    //  Используемые поля (Resp_ThreadModel, официальная схема):
    //    thread_reply_group_id       integer  (0 = нет ограничения)
    //    thread_is_closed            boolean
    //    permissions.post            boolean
    //    contest.already_participate boolean  [unverified — может отсутствовать]
    //    contest.is_finished         integer  [unverified — >0 = завершён]
    //    contest.permissions.can_participate  boolean  [unverified]
    // ═══════════════════════════════════════════════════════════════

    function shouldHide(t) {
        if (!t) return { hide: false, reason: null };

        // 1. Ограничение по группе
        if (cfg.hideGrp) {
            const req = t.thread_reply_group_id ?? 0;
            if (req > 0) {
                const my = Number(cfg.userGrpId) || 0;
                // Скрываем только если group_id известен (my > 0) и ниже требуемого
                if (my > 0 && my < req) return { hide: true, reason: 'group' };
            }
        }

        // 2. КД / Нельзя участвовать
        //    a) thread_post_delay > 0  — в теме есть любая задержка (даже 1 мин)
        //    b) permissions.reply = false — сейчас нельзя ответить (активный КД, лимит и т.д.)
        //    c) contest.permissions.can_participate = false — нельзя участвовать в раздаче
        if (cfg.hideCantPart) {
            if ((t.thread_post_delay ?? 0) > 0)
                return { hide: true, reason: 'postDelay' };
            if (t.permissions?.reply === false)
                return { hide: true, reason: 'noReply' };
            if (t.contest?.permissions?.can_participate === false)
                return { hide: true, reason: 'cantParticipate' };
        }

        // 3. Ключевые слова в названии
        if (cfg.hideKw) {
            const title = (t.thread_title ?? '').toLowerCase();
            const kws = cfg.hideKw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            for (const kw of kws) {
                if (kw && title.includes(kw))
                    return { hide: true, reason: 'keyword' };
            }
        }

        return { hide: false, reason: null };
    }

    // ═══════════════════════════════════════════════════════════════
    //  DOM — ПОИСК СТРОКИ ТРЕДА
    //
    //  XenForo 1 (lolz.live): id="thread-NNNN" на <li>
    //  XenForo 2: data-thread-id или data-content-key
    //  Ссылки: относительный URL без ведущего слэша на XenForo 1
    // ═══════════════════════════════════════════════════════════════

    function findRow(threadId) {
        const id = String(threadId);

        // 1. XenForo 1: <li id="thread-9992216">
        const byId = document.getElementById(`thread-${id}`);
        if (byId) return byId;

        // 2. XenForo 2: data-thread-id
        const byAttr = document.querySelector(`[data-thread-id="${id}"]`);
        if (byAttr) return byAttr;

        // 3. XenForo 2: data-content-key="thread-NNNN"
        const byKey = document.querySelector(`[data-content-key="thread-${id}"]`);
        if (byKey) return byKey;

        // 4. URL (относительный href="threads/NNNN/" или абсолютный href="/threads/NNNN/")
        const linkRow = _findLinkAndGetRow(`a[href*="threads/${id}"]`);
        if (linkRow) return linkRow;

        return null;
    }

    function _findLinkAndGetRow(sel) {
        let a;
        try { a = document.querySelector(sel); } catch { return null; }
        if (!a) return null;
        return a.closest('.discussionListItem, .structItem--thread, .structItem, li, article') ?? null;
    }

    function getThreadIdFromRow(row) {
        // XenForo 1: id="thread-12345"
        if (row.id && /^thread-\d+$/.test(row.id))
            return row.id.slice('thread-'.length);

        // XenForo 2
        if (row.dataset.threadId) return String(row.dataset.threadId);
        if (row.dataset.contentKey) {
            const m = row.dataset.contentKey.match(/\d+/);
            if (m) return m[0];
        }

        // Ссылка с относительным или абсолютным URL
        const a = row.querySelector('a[href*="threads/"]');
        if (a) {
            const href = a.getAttribute('href') || '';
            // slug.NNNN/ (XenForo 2 стиль)
            let m = href.match(/threads\/[^/]*\.(\d+)/);
            if (m) return m[1];
            // threads/NNNN/ или /threads/NNNN/
            m = href.match(/threads\/(\d+)/);
            if (m) return m[1];
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    //  СТАТИСТИКА
    // ═══════════════════════════════════════════════════════════════

    const stats = { apiTotal: 0, matched: 0, hidden: 0, byReason: {} };

    function resetStats() {
        stats.apiTotal = 0;
        stats.matched  = 0;
        stats.hidden   = 0;
        stats.byReason = {};
    }

    // ═══════════════════════════════════════════════════════════════
    //  ПРИМЕНЕНИЕ ФИЛЬТРА
    // ═══════════════════════════════════════════════════════════════

    const _hiddenRows = new Set();
    let _applying = false;

    function applyFilter(map) {
        resetStats();
        stats.apiTotal = map.size;
        _applying = true;

        // Восстанавливаем ранее скрытые строки
        for (const row of _hiddenRows) {
            row.style.display       = '';
            row.style.opacity       = '';
            row.style.filter        = '';
            row.style.pointerEvents = '';
            delete row.dataset.lolzfpHidden;
        }
        _hiddenRows.clear();

        for (const [threadId, t] of map) {
            const row = findRow(threadId);
            if (!row) continue;

            stats.matched++;
            const { hide, reason } = shouldHide(t);

            if (hide) {
                stats.hidden++;
                stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
                row.dataset.lolzfpHidden = reason;
                _hiddenRows.add(row);

                if (cfg.peekMode) {
                    row.style.opacity       = '0.12';
                    row.style.filter        = 'grayscale(1)';
                    row.style.pointerEvents = 'none';
                } else {
                    row.style.display = 'none';
                }
            }
        }

        log(`Итог: API=${stats.apiTotal} DOM=${stats.matched} скрыто=${stats.hidden}`, stats.byReason);
        updateBadge();
        _applying = false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  СТИЛИ
    // ═══════════════════════════════════════════════════════════════

    GM_addStyle(`
        #lolzfp {
            display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
            margin: 8px 0 4px; padding: 6px 10px;
            background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
            border-radius: 7px; font-size: 12px;
        }
        .lolzfp-btn {
            cursor: pointer; font-size: 11px; padding: 3px 9px; border-radius: 4px;
            border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.07);
            color: #ccc; user-select: none; transition: opacity .15s, background .15s;
        }
        .lolzfp-btn.on  { opacity: 1; border-color: rgba(255,255,255,.3); }
        .lolzfp-btn.off { opacity: 0.38; }
        .lolzfp-btn:hover { background: rgba(255,255,255,.13); }
        #lolzfp-badge {
            padding: 2px 10px; border-radius: 4px;
            background: rgba(255,255,255,.05); font-size: 11px; color: #aaa;
            max-width: 600px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #lolz-modal {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
            z-index: 999999; background: #1e1e1e; border: 1px solid #444;
            border-radius: 10px; padding: 20px 24px; width: 510px; max-width: 95vw;
            box-shadow: 0 8px 32px rgba(0,0,0,.85); font-size: 13px; color: #ddd;
            max-height: 92vh; overflow-y: auto;
        }
        .lm-inp {
            width: 100%; box-sizing: border-box; padding: 7px 10px; margin-bottom: 8px;
            border-radius: 5px; border: 1px solid #555; background: #111; color: #eee; font-size: 13px;
        }
        .lm-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
        .lm-btn { cursor: pointer; padding: 5px 14px; font-size: 12px; border-radius: 4px; border: none; color: #fff; }
        .lm-info { background: #111; border: 1px solid #333; border-radius: 6px; padding: 10px; margin-bottom: 14px; font-size: 11px; color: #888; line-height: 1.85; }
        #lolz-debug {
            background: #0d0d0d; border: 1px solid #333; border-radius: 5px;
            padding: 8px 10px; font-size: 10px; color: #888; font-family: monospace;
            white-space: pre-wrap; margin-top: 10px; max-height: 280px;
            overflow-y: auto; display: none; word-break: break-all;
        }
        .lolzfp-loading { animation: lolzfp-pulse 1s infinite; }
        @keyframes lolzfp-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    `);

    // ═══════════════════════════════════════════════════════════════
    //  UI — ПАНЕЛЬ
    // ═══════════════════════════════════════════════════════════════

    function mkToggle(label, active, onChange) {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = `lolzfp-btn ${active ? 'on' : 'off'}`;
        btn.textContent = label;
        btn.onclick = e => {
            e.preventDefault(); e.stopPropagation();
            const next = !btn.classList.contains('on');
            btn.classList.toggle('on', next);
            btn.classList.toggle('off', !next);
            onChange(next);
        };
        return btn;
    }

    function buildPanel() {
        if (document.getElementById('lolzfp')) return null;
        const panel = document.createElement('div');
        panel.id = 'lolzfp';

        const flush = () => { clearCache(currentForumId()); run(); };

        panel.append(
            mkToggle('👥 Группа',         cfg.hideGrp,      v => { saveCfg('hideGrp',      v); flush(); }),
            mkToggle('⛔ КД/Нельзя участв.', cfg.hideCantPart, v => { saveCfg('hideCantPart', v); flush(); }),
        );

        // Кнопка Peek-режима: текст синхронизирован с состоянием
        const peekBtn = mkToggle(cfg.peekMode ? '👁 Виден' : '👁 Скрыт', cfg.peekMode, v => {
            saveCfg('peekMode', v);
            peekBtn.textContent = v ? '👁 Виден' : '👁 Скрыт';
            applyFilter(_lastMap || new Map());
        });
        panel.append(peekBtn);

        // Кнопка принудительного обновления
        const refreshBtn = document.createElement('button');
        refreshBtn.type      = 'button';
        refreshBtn.className = 'lolzfp-btn on';
        refreshBtn.textContent = '↺';
        refreshBtn.title    = 'Обновить данные';
        refreshBtn.onclick  = e => { e.preventDefault(); e.stopPropagation(); clearCache(currentForumId()); run(); };
        panel.append(refreshBtn);

        const badge = document.createElement('span');
        badge.id = 'lolzfp-badge';
        badge.textContent = '…';
        panel.append(badge);

        const gear = document.createElement('button');
        gear.type = 'button'; gear.className = 'lolzfp-btn on';
        gear.textContent = '⚙'; gear.title = 'Настройки';
        gear.onclick = e => { e.preventDefault(); e.stopPropagation(); openModal(); };
        panel.append(gear);

        return panel;
    }

    // Последний загруженный map — чтобы peekMode мог сразу перерисовать без запроса
    let _lastMap = null;

    function updateBadge() {
        const el = document.getElementById('lolzfp-badge');
        if (!el) return;

        el.classList.remove('lolzfp-loading');

        if (!cfg.apiKey) {
            el.textContent = '🔑 нет токена — открой ⚙';
            el.style.color = '#888';
            return;
        }

        if (_tokenInvalid) {
            el.textContent = '❌ токен недействителен — обнови в ⚙';
            el.style.color = '#f55';
            return;
        }

        if (cfg.hideGrp && !(Number(cfg.userGrpId) > 0)) {
            el.textContent = '⚠ Группа вкл., но group_id не определён — нажми ⚙ → 📡 Проверить токен';
            el.style.color = '#f0a84b';
            return;
        }

        const diag = `API:${stats.apiTotal} DOM:${stats.matched}`;

        if (stats.hidden === 0) {
            el.textContent = `✓ всё видно  (${diag})`;
            el.style.color = stats.matched > 0 ? '#8bc34a' : '#f0a84b';
            return;
        }

        const parts = [];
        if (stats.byReason.group)           parts.push(`группа:${stats.byReason.group}`);
        if (stats.byReason.postDelay)       parts.push(`кд:${stats.byReason.postDelay}`);
        if (stats.byReason.noReply)         parts.push(`нет отв:${stats.byReason.noReply}`);
        if (stats.byReason.cantParticipate) parts.push(`нельзя:${stats.byReason.cantParticipate}`);
        if (stats.byReason.keyword)         parts.push(`слово:${stats.byReason.keyword}`);

        el.textContent = `скрыто ${stats.hidden}  (${parts.join(' · ')})  [${diag}]`;
        el.style.color = '#f0a84b';
    }

    function setBadgeLoading() {
        const el = document.getElementById('lolzfp-badge');
        if (!el) return;
        el.textContent = '⏳ загрузка…';
        el.style.color = '#888';
        el.classList.add('lolzfp-loading');
    }

    function injectPanel() {
        if (!isActiveSection() || document.getElementById('lolzfp')) return;
        const panel = buildPanel();
        if (!panel) return;

        for (const sel of [
            '.pageNavLinkGroup',
            '.block-outer--after',
            '.block-outer',
            '.discussionListItems',
            '.structItemContainer',
            '.p-body-main',
            '#content',
        ]) {
            const a = document.querySelector(sel);
            if (!a) continue;
            const isList = a.classList.contains('discussionListItems')
                || a.classList.contains('structItemContainer')
                || a.id === 'content';
            if (isList) a.parentNode.insertBefore(panel, a);
            else        a.parentNode.insertBefore(panel, a.nextSibling);
            return;
        }
        document.body.prepend(panel);
    }

    // ═══════════════════════════════════════════════════════════════
    //  ДИАГНОСТИКА
    // ═══════════════════════════════════════════════════════════════

    function runDiagnostics() {
        const lines = [];

        lines.push(`Версия: ${VERSION}  verbose: ${cfg.verbose}`);
        lines.push('');

        // DOM структура
        lines.push(`[DOM]`);
        lines.push(`  id="thread-*"    : ${document.querySelectorAll('[id^="thread-"]').length}`);
        lines.push(`  .discussionListItem: ${document.querySelectorAll('.discussionListItem').length}`);
        lines.push(`  .structItem--thread: ${document.querySelectorAll('.structItem--thread').length}`);
        lines.push(`  a[href*="threads/"]: ${document.querySelectorAll('a[href*="threads/"]').length}`);
        lines.push('');

        const fid    = currentForumId();
        const pg     = currentPage();
        const cached = getCached(fid, pg);

        if (!cached || cached.size === 0) {
            lines.push('Кэш пуст — нажми ↺ чтобы загрузить данные');
            return lines.join('\n');
        }

        lines.push(`[Кэш] ${cached.size} тредов (forum=${fid} page=${pg})`);
        lines.push('─────────────────────────────────────────────');

        let i = 0;
        for (const [tid, t] of cached) {
            i++;

            const row           = findRow(tid);
            const { hide, reason } = shouldHide(t);
            const p             = t.permissions ?? {};
            const c             = t.contest ?? null;
            const grp           = t.thread_reply_group_id ?? 0;
            const grpName       = GROUP_NAMES[grp] ? ` (${GROUP_NAMES[grp]})` : '';
            const closed        = t.thread_is_closed ? ' ЗАКРЫТА' : '';
            const title         = (t.thread_title ?? '').slice(0, 45);

            lines.push(`[${tid}] "${title}"${closed}`);
            lines.push(`  DOM: ${row ? `✓ ${row.id || row.tagName}` : '❌ не найден'}`);
            lines.push(`  → ${hide ? `СКРЫТ (${reason})` : 'видим'}`);
            lines.push(`  permissions.post=${p.post ?? '?'}  group_req=${grp}${grpName}  closed=${t.thread_is_closed ?? '?'}`);
            if (c !== null) {
                lines.push(`  contest.already_participate=${c.already_participate ?? '?'}`);
                lines.push(`  contest.is_finished=${c.is_finished ?? '?'}`);
                lines.push(`  contest.can_participate=${c.permissions?.can_participate ?? '?'}`);
            } else {
                lines.push(`  contest: нет (обычный тред)`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    // ═══════════════════════════════════════════════════════════════
    //  ЭКСПОРТ / ИМПОРТ НАСТРОЕК
    // ═══════════════════════════════════════════════════════════════

    function exportSettings() {
        const data = {
            _v: VERSION,
            forums:       gmGet('forums', '') || DEFAULT_FORUMS.join(','),
            hideGrp:      cfg.hideGrp,
            hideCantPart: cfg.hideCantPart,
            hideKw:       cfg.hideKw,
            peekMode:     cfg.peekMode,
            verbose:      cfg.verbose,
        };
        return JSON.stringify(data, null, 2);
    }

    function importSettings(jsonStr) {
        let data;
        try { data = JSON.parse(jsonStr); } catch { return '❌ Неверный JSON'; }
        const keys = ['forums','hideGrp','hideCantPart','hideKw','peekMode','verbose'];
        for (const k of keys) {
            if (k in data) {
                if (k === 'forums') gmSet('forums', String(data[k]));
                else saveCfg(k, data[k]);
            }
        }
        return `✅ Импортировано (версия экспорта: ${data._v ?? '?'})`;
    }

    // Безопасное HTML-экранирование для подстановки в innerHTML
    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ═══════════════════════════════════════════════════════════════
    //  UI — МОДАЛКА
    // ═══════════════════════════════════════════════════════════════

    function openModal() {
        const ex = document.getElementById('lolz-modal');
        if (ex) { ex.remove(); return; }

        const savedForums = gmGet('forums', '') || DEFAULT_FORUMS.join(', ');
        const fid     = currentForumId();
        const already = fid && activeForums().includes(fid);
        const myGrpName = GROUP_NAMES[cfg.userGrpId] ? ` (${GROUP_NAMES[cfg.userGrpId]})` : '';

        const modal = document.createElement('div');
        modal.id = 'lolz-modal';
        modal.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
  <b style="font-size:15px;">⚙ Настройки v${esc(VERSION)}</b>
  <button type="button" id="lolz-x" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">✕</button>
</div>

${cfg.userName
    ? `<div style="margin-bottom:10px;padding:6px 10px;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:5px;font-size:12px;color:#8bc34a;">
        ✅ <b>${esc(cfg.userName)}</b>${cfg.userGrpId ? ` · group_id: <b>${esc(cfg.userGrpId)}${esc(myGrpName)}</b>` : ''}
       </div>`
    : `<div style="margin-bottom:10px;padding:6px 10px;background:#2a1a1a;border:1px solid #4a2a2a;border-radius:5px;font-size:12px;color:#f07070;">
        ⚠ Введи токен и нажми «Проверить токен»
       </div>`
}

${_tokenInvalid ? `<div style="margin-bottom:10px;padding:6px 10px;background:#2a1a1a;border:1px solid #7a2a2a;border-radius:5px;font-size:12px;color:#ff6060;">
  ❌ Токен недействителен (401/403). Введи новый и нажми «Проверить токен».
</div>` : ''}

<label style="display:block;font-size:11px;color:#888;margin-bottom:3px;">API токен (lolz.live → Настройки → API):</label>
<input type="password" id="lolz-tok" class="lm-inp" placeholder="Токен…" autocomplete="off" />

<label style="display:block;font-size:11px;color:#888;margin-bottom:3px;">Активные разделы (forum_id через запятую):</label>
<input type="text" id="lolz-forums" class="lm-inp" placeholder="840, 123, …" value="${esc(savedForums)}" />
<div style="font-size:11px;color:#555;margin:-4px 0 14px;display:flex;align-items:center;gap:8px;">
  Текущий раздел: <b style="color:#aaa;">${esc(fid ?? '—')}</b>
  ${!already && fid
    ? `<button type="button" id="lolz-add-fid" style="cursor:pointer;padding:1px 8px;border-radius:3px;border:1px solid #555;background:#222;color:#aaa;font-size:11px;">＋ добавить</button>`
    : already ? `<span style="color:#2a5;">✓ в списке</span>` : ''}
</div>

<div class="lm-info">
  <b style="color:#bbb;">Что скрывает каждый фильтр:</b><br>
  👥 <b>Группа</b> — <code>thread_reply_group_id &gt; 0</code> и твоя группа ниже требуемой<br>
  &nbsp;&nbsp;&nbsp;&nbsp;21=Local · 22=Resident · 23=Expert · 60=Guru · 351=AI<br>
  ⛔ <b>КД/Нельзя участв.</b> — скрывает если в теме есть <b>любая задержка</b> (<code>thread_post_delay &gt; 0</code>), нет права ответить, или <code>contest.can_participate = false</code><br>
  🔤 <b>Ключевые слова</b> — название содержит одно из слов (регистр игнорируется)
</div>

<label style="display:block;font-size:11px;color:#888;margin-bottom:3px;">🔤 Скрывать по словам в названии (через запятую, напр.: <code>кд, кулдаун, cd,</code>):</label>
<input type="text" id="lolz-kw" class="lm-inp" placeholder="кд, кулдаун, cd, cooldown …" value="${esc(cfg.hideKw)}" />

<div class="lm-row">
  <button type="button" id="lolz-save"   class="lm-btn" style="background:#2a5;">💾 Сохранить</button>
  <button type="button" id="lolz-check"  class="lm-btn" style="background:#334;">📡 Проверить токен</button>
  <button type="button" id="lolz-cache"  class="lm-btn" style="background:#433;">🗑 Очистить кэш</button>
  <button type="button" id="lolz-diag"   class="lm-btn" style="background:#252540;">🔍 Диагностика</button>
  <button type="button" id="lolz-export" class="lm-btn" style="background:#2a3a4a;">📤 Экспорт</button>
  <button type="button" id="lolz-import" class="lm-btn" style="background:#2a3a4a;">📥 Импорт</button>
</div>
<div id="lolz-st" style="margin-top:8px;font-size:12px;min-height:16px;color:#aaa;word-break:break-all;"></div>

<div style="margin-top:10px;border-top:1px solid #333;padding-top:10px;">
  <label style="display:block;font-size:11px;color:#888;margin-bottom:4px;">🔎 Проверить тред — почему не скрывается:</label>
  <div style="display:flex;gap:6px;">
    <input type="text" id="lolz-tid" class="lm-inp" style="margin:0;flex:1;" placeholder="ID треда или URL, напр. 9992216" />
    <button type="button" id="lolz-tcheck" class="lm-btn" style="background:#334;white-space:nowrap;">Проверить</button>
  </div>
  <div id="lolz-tresult" style="display:none;margin-top:8px;background:#0d0d0d;border:1px solid #333;border-radius:5px;padding:8px 10px;font-size:10px;color:#bbb;font-family:monospace;white-space:pre-wrap;max-height:300px;overflow-y:auto;"></div>
</div>

<div style="margin-top:10px;border-top:1px solid #333;padding-top:10px;">
  <label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#888;cursor:pointer;">
    <input type="checkbox" id="lolz-verbose" ${cfg.verbose ? 'checked' : ''}> Verbose-логирование в консоль
  </label>
</div>

<div id="lolz-debug"></div>
        `;
        document.body.appendChild(modal);

        // Не показываем реальный токен в поле — безопаснее
        modal.querySelector('#lolz-tok').placeholder = cfg.apiKey ? '(токен сохранён — введи новый для замены)' : 'Токен…';

        const st = (msg, color = '#aaa') => {
            const e = modal.querySelector('#lolz-st');
            if (e) { e.textContent = msg; e.style.color = color; }
        };

        modal.querySelector('#lolz-x').onclick = () => modal.remove();

        modal.querySelector('#lolz-add-fid')?.addEventListener('click', () => {
            const inp = modal.querySelector('#lolz-forums');
            inp.value = inp.value.trim() ? `${inp.value.trim()}, ${fid}` : fid;
        });

        modal.querySelector('#lolz-verbose').addEventListener('change', e => {
            saveCfg('verbose', e.target.checked);
        });

        modal.querySelector('#lolz-save').addEventListener('click', () => {
            const tok = modal.querySelector('#lolz-tok').value.trim();
            const frs = modal.querySelector('#lolz-forums').value.trim();
            const kw  = modal.querySelector('#lolz-kw').value.trim();
            if (tok) {
                cfg.apiKey = tok;
                gmSet('apiKey', tok);
                _tokenInvalid = false;
            }
            if (frs) gmSet('forums', frs);
            saveCfg('hideKw', kw);
            clearCache(currentForumId());
            st('Сохранено!', '#8bc34a');
            setTimeout(() => { modal.remove(); run(); }, 500);
        });

        modal.querySelector('#lolz-check').addEventListener('click', () => {
            const tok = modal.querySelector('#lolz-tok').value.trim() || cfg.apiKey;
            if (!tok) { st('Введи токен'); return; }
            st('📡 Проверяем /users/me…');
            GM_xmlhttpRequest({
                method:  'GET',
                url:     `${API}/users/me`,
                headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' },
                timeout: 10000,
                onload(r) {
                    if (r.status === 401 || r.status === 403) {
                        st(`❌ ${r.status}: токен недействителен или нет доступа`, '#f55');
                        return;
                    }
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d.errors) { st('❌ ' + _formatApiErrors(d.errors), '#f55'); return; }
                        const u    = d.user ?? d;
                        const grp  = u.user_group_id ?? 0;
                        const name = u.username ?? '?';
                        const grpName = GROUP_NAMES[grp] ? ` (${GROUP_NAMES[grp]})` : '';
                        if (grp)  { cfg.userGrpId = grp;  gmSet('userGrpId', grp); }
                        if (name) { cfg.userName  = name; gmSet('userName', name); }
                        cfg.apiKey = tok; gmSet('apiKey', tok);
                        _tokenInvalid = false;
                        st(`✅ ${name} · group_id:${grp}${grpName} · сообщений:${u.user_message_count ?? '?'}`, '#8bc34a');
                        updateBadge();
                    } catch { st('❌ Ошибка парсинга ответа', '#f55'); }
                },
                onerror()   { st('❌ Ошибка сети', '#f55');    },
                ontimeout() { st('⌛ Таймаут',      '#f55');    },
            });
        });

        modal.querySelector('#lolz-cache').addEventListener('click', () => {
            clearCache(null);
            _lastMap = null;
            st('Кэш очищен', '#8bc34a');
            setTimeout(run, 300);
        });

        modal.querySelector('#lolz-diag').addEventListener('click', () => {
            const dbg = modal.querySelector('#lolz-debug');
            dbg.textContent = runDiagnostics();
            dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none';
        });

        // ── Экспорт ──────────────────────────────────────────────
        modal.querySelector('#lolz-export').addEventListener('click', () => {
            const json = exportSettings();
            try {
                navigator.clipboard.writeText(json)
                    .then(() => st('✅ Настройки скопированы в буфер', '#8bc34a'))
                    .catch(() => { st('Скопируй из консоли', '#aaa'); console.log(json); });
            } catch {
                st('Скопируй из консоли', '#aaa');
                console.log('[LolzFilter export]', json);
            }
        });

        // ── Импорт ───────────────────────────────────────────────
        modal.querySelector('#lolz-import').addEventListener('click', () => {
            const raw = prompt('Вставь JSON настроек:');
            if (!raw) return;
            const result = importSettings(raw);
            st(result, result.startsWith('✅') ? '#8bc34a' : '#f55');
            if (result.startsWith('✅')) setTimeout(() => { modal.remove(); run(); }, 800);
        });

        // ── Проверка конкретного треда ───────────────────────────
        modal.querySelector('#lolz-tcheck').addEventListener('click', () => {
            const raw  = modal.querySelector('#lolz-tid').value.trim();
            const mUrl = raw.match(/\/threads\/(\d+)/);
            const tid  = mUrl ? mUrl[1] : raw.replace(/\D/g, '');
            if (!tid) { st('Введи ID треда или URL', '#f55'); return; }

            const res = modal.querySelector('#lolz-tresult');
            res.style.display = 'block';
            res.style.color   = '#888';
            res.textContent   = `📡 GET /threads/${tid} …`;

            GM_xmlhttpRequest({
                method:  'GET',
                url:     `${API}/threads/${tid}`,
                headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Accept': 'application/json' },
                timeout: 10000,
                onload(r) {
                    if (r.status === 401 || r.status === 403) {
                        res.style.color  = '#f55';
                        res.textContent  = `❌ ${r.status}: нет доступа к треду`;
                        return;
                    }
                    try {
                        const d = JSON.parse(r.responseText);
                        if (d.errors) {
                            res.style.color = '#f55';
                            res.textContent = '❌ ' + _formatApiErrors(d.errors);
                            return;
                        }

                        const t   = d.thread ?? d;
                        const p   = t.permissions ?? {};
                        const c   = t.contest ?? null;
                        const grp = t.thread_reply_group_id ?? 0;
                        const grpName = GROUP_NAMES[grp] ? ` (${GROUP_NAMES[grp]})` : '';

                        const fmtVerdict = (label, active, willHide, reason) =>
                            `  ${active ? '🔵' : '⚪'} ${label}: ${active ? (willHide ? `▶ СКРЫТЬ (${reason})` : 'нет совпадения') : 'фильтр выкл.'}`;

                        const myGrp  = Number(cfg.userGrpId) || 0;

                        const lines = [
                            `[${tid}] "${(t.thread_title ?? '').slice(0, 60)}"`,
                            `thread_reply_group_id   = ${grp}${grpName}`,
                            '',
                            `contest присутствует    = ${c !== null}`,
                            `thread_post_delay       = ${t.thread_post_delay ?? 0}с`,
                            `permissions.reply       = ${p.reply ?? '—'}`,
                            c ? `contest.can_participate  = ${c.permissions?.can_participate}` : '',
                            '',
                            '─── Решение фильтров ───',
                            fmtVerdict('👥 Группа',
                                cfg.hideGrp,
                                grp > 0 && (myGrp > 0 && myGrp < grp),
                                `group: req=${grp}${grpName} my=${myGrp}`),
                            fmtVerdict('⛔ КД (задержка)',
                                cfg.hideCantPart,
                                (t.thread_post_delay ?? 0) > 0,
                                `postDelay=${t.thread_post_delay ?? 0}с`),
                            fmtVerdict('⛔ КД (нет ответа)',
                                cfg.hideCantPart,
                                p.reply === false,
                                `noReply [reply=${p.reply ?? '—'}]`),
                            c
                                ? fmtVerdict('⛔ Нельзя участв.', cfg.hideCantPart, c.permissions?.can_participate === false, 'cantParticipate')
                                : '  ⚪ Нельзя участв.: contest нет в треде',
                        ].filter(l => l !== '');

                        const { hide, reason } = shouldHide(t);
                        lines.push('');
                        lines.push(`ИТОГ: ${hide ? `▶ СКРЫТЬ (${reason})` : '▷ оставить видимым'}`);

                        if (!hide) {
                            lines.push('');
                            lines.push('💡 Почему видим:');
                            if (cfg.hideGrp && !(myGrp > 0))
                                lines.push('  ⚠ group_id не установлен — фильтр Группа не работает (нажми ⚙ → Проверить токен)');
                            else if (grp > 0 && myGrp >= grp && cfg.hideGrp)
                                lines.push(`  — group_id ${myGrp} >= req ${grp}: твоя группа подходит`);
                            if ((t.thread_post_delay ?? 0) === 0 && cfg.hideCantPart)
                                lines.push(`  — thread_post_delay=0: в теме нет задержки между постами`);
                            if (p.reply !== false && cfg.hideCantPart)
                                lines.push(`  — permissions.reply=${p.reply ?? '—'}: сейчас нет активного КД`);
                            if (c === null && cfg.hideCantPart)
                                lines.push('  — contest поля отсутствуют → НельзяУчаств. недоступно');
                            if (c && c.permissions?.can_participate !== false && cfg.hideCantPart)
                                lines.push(`  — contest.can_participate = ${c.permissions?.can_participate ?? '—'}: участие доступно`);
                        }

                        res.style.color = hide ? '#f0a84b' : '#8bc34a';
                        res.textContent = lines.join('\n');
                    } catch (e) {
                        res.style.color = '#f55';
                        res.textContent = '❌ Ошибка: ' + e.message;
                    }
                },
                onerror()   { res.style.color = '#f55'; res.textContent = '❌ Ошибка сети'; },
                ontimeout() { res.style.color = '#f55'; res.textContent = '⌛ Таймаут';     },
            });
        });

        // Закрытие по клику вне модалки
        setTimeout(() => {
            document.addEventListener('click', function h(e) {
                if (!modal.contains(e.target)) {
                    modal.remove();
                    document.removeEventListener('click', h);
                }
            });
        }, 150);
    }

    // ═══════════════════════════════════════════════════════════════
    //  ОСНОВНОЙ ЗАПУСК
    // ═══════════════════════════════════════════════════════════════

    let _runId = 0;

    async function run() {
        if (!isActiveSection()) return;
        if (!cfg.apiKey) { updateBadge(); return; }
        if (_tokenInvalid) { updateBadge(); return; }

        const runId = ++_runId;
        const fid   = currentForumId();
        const pg    = currentPage();

        setBadgeLoading();

        try {
            const map = await loadPage(fid, pg);
            if (runId !== _runId) return; // устаревший вызов
            _lastMap = map;
            applyFilter(map);
        } catch (e) {
            if (runId !== _runId) return;
            console.error('[LolzFilter]', e.message);
            const badge = document.getElementById('lolzfp-badge');
            if (badge) {
                badge.classList.remove('lolzfp-loading');
                badge.textContent = '❌ ' + e.message;
                badge.style.color = '#f55';
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  MUTATION OBSERVER
    // ═══════════════════════════════════════════════════════════════

    let _dbt = null;
    let _obs = null;

    function startObserver() {
        if (_obs) return;
        const target =
            document.querySelector('.discussionListItems, .structItemContainer, .p-body-main, #content')
            ?? document.body;
        _obs = new MutationObserver(() => {
            if (_applying) return;
            clearTimeout(_dbt);
            _dbt = setTimeout(run, 400);
        });
        _obs.observe(target, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════════════════════════
    //  ИНИЦИАЛИЗАЦИЯ
    // ═══════════════════════════════════════════════════════════════

    function init() {
        if (!isActiveSection()) return;
        injectPanel();
        updateBadge();
        run();
        startObserver();
        autoFetchUserInfo();            // авто-определяем group_id если не установлен
        setTimeout(checkUpdate, 3000);  // проверяем обновления через 3с
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
