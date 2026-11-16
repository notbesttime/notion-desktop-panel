// notion-desktop-panel — 悬浮用量面板
// 注入到 Notion 桌面版内部，通过页面同源 fetch 读取真实用量与套餐信息。
// 挂在 window.__notionPanel 上，重复注入只更新不重建。
(() => {
  'use strict';
  const PANEL_ID = 'notion-desktop-panel-root';
  if (window.__notionPanel && document.getElementById(PANEL_ID)) {
    // A page reload replaces window.fetch, so the observer has to be re-armed
    // even when the panel itself survived.
    if (window.__notionPanel.rearm) window.__notionPanel.rearm();
    window.__notionPanel.refresh();
    return 'already';
  }

  const ENDPOINTS = {
    rolling: '/api/v3/getCreditRateLimitStatus',
    billing: '/api/v3/getBillingData',
  };
  const POLL_MS = 60_000;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const SPACE_CACHE_KEY = 'notion-desktop-panel:spaceId';
  let cachedSpaceId = null;
  try { cachedSpaceId = localStorage.getItem(SPACE_CACHE_KEY) || null; } catch {}
  function cacheSpaceId(id) {
    if (!id || id === cachedSpaceId) return;
    cachedSpaceId = id;
    try { localStorage.setItem(SPACE_CACHE_KEY, id); } catch {}
  }

  // ── 状态 ──
  const state = {
    rolling: null,   // { used, limit, percent, resetAt }
    monthly: null,
    plan: null,      // { name, status, periodEnd }
    status: '',
    lastError: '',
    limits: null,    // { sixHour:{applicable,exposed,verdictStatus}, monthly:{enforced,count}, pricingPhase }
    updatedAt: 0,
    open: false,
    // Notion 桌面版的推理不经页面 fetch，单次 token 抓不到；改用额度增量反映消耗。
    session: null,   // { startAt, usedUnits, rollingDelta, monthlyDelta }
    history: [],     // [{ t, d }] 每次检测到的额度变化
    prev: null,      // 上一次采样的百分比，用于算增量
  };

  // ── 样式 ──
  const CSS = [
    ':root{--np-bg:#1f1f1f;--np-fg:#e9e9e7;--np-mut:#969593;--np-line:#33312f;--np-ok:#4ec9a0;--np-warn:#e5a03b;--np-err:#e5645a;--np-acc:#7c9cf5}',
    '#notion-desktop-panel-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--np-fg);-webkit-font-smoothing:antialiased}',
    '.np-pill{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:var(--np-bg);border:1px solid var(--np-line);box-shadow:0 6px 22px rgba(0,0,0,.32);cursor:pointer;user-select:none;transition:transform .12s}',
    '.np-pill:hover{transform:translateY(-1px)}',
    '.np-pill.np-err{border-color:var(--np-err)}',
    '.np-dot{width:7px;height:7px;border-radius:50%;background:var(--np-ok);flex:none}',
    '.np-dot.warn{background:var(--np-warn)}.np-dot.err{background:var(--np-err)}',
    '.np-pct{font-variant-numeric:tabular-nums;font-weight:600}',
    '.np-eta{color:var(--np-mut);font-size:11px;font-variant-numeric:tabular-nums;letter-spacing:-.1px}',
    '.np-sep{width:1px;height:12px;background:var(--np-line);flex:none}',
    '.np-mut{color:var(--np-mut)}',
    '.np-card{position:absolute;right:0;bottom:44px;width:330px;max-height:min(74vh,620px);overflow:auto;background:var(--np-bg);border:1px solid var(--np-line);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.48)}',
    '.np-card[hidden]{display:none}',
    '.np-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--np-line);position:sticky;top:0;background:var(--np-bg);z-index:1}',
    '.np-hd b{font-size:14px;font-weight:600}',
    '.np-x{border:0;background:transparent;color:var(--np-mut);cursor:pointer;font-size:17px;line-height:1;padding:2px 5px;border-radius:5px}',
    '.np-x:hover{background:#33312f;color:var(--np-fg)}',
    '.np-sec{padding:13px 16px;border-bottom:1px solid var(--np-line)}',
    '.np-sec:last-child{border-bottom:0}',
    '.np-lab{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px}',
    '.np-lab span:first-child{color:var(--np-mut);font-size:12px}',
    '.np-lab b{font-variant-numeric:tabular-nums;font-size:13px}',
    '.np-bar{height:5px;border-radius:3px;background:#33312f;overflow:hidden}',
    '.np-bar i{display:block;height:100%;border-radius:3px;background:var(--np-acc);transition:width .3s}',
    '.np-bar i.warn{background:var(--np-warn)}.np-bar i.err{background:var(--np-err)}',
    '.np-meta{margin-top:6px;font-size:11.5px;color:var(--np-mut);display:flex;justify-content:space-between}',
    '.np-row{display:flex;justify-content:space-between;padding:3px 0;font-size:12.5px}',
    '.np-row span{color:var(--np-mut)}',
    '.np-ft{padding:10px 16px;font-size:11px;color:var(--np-mut);display:flex;justify-content:space-between;align-items:center}',
    '.np-btn{border:1px solid var(--np-line);background:transparent;color:var(--np-mut);border-radius:6px;padding:3px 9px;font-size:11.5px;cursor:pointer}',
    '.np-btn:hover{border-color:var(--np-acc);color:var(--np-fg)}',
    '.np-errmsg{color:var(--np-err);font-size:11.5px;word-break:break-all}',
    '.np-note{color:var(--np-ok);font-size:12px;line-height:1.5;padding:2px 0 0}',
  ].join('');

  // ── 工具 ──
  const pct = (u, l) => (l > 0 ? Math.min(100, (u / l) * 100) : 0);
  const fmtPct = (v) => (v >= 10 ? Math.round(v) : v.toFixed(1)) + '%';
  const cls = (v) => (v >= 90 ? 'err' : v >= 70 ? 'warn' : '');
  // 积分是小数（0.33816），但额度是整数（1500 / 500），按量级选精度。
  const fmtNum = (v) => {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (v === 0) return '0';
    if (v < 1) return v.toFixed(2);
    if (v < 100) return v.toFixed(2).replace(/\.?0+$/, '');
    return String(Math.round(v));
  };
  function until(ms) {
    if (!ms || ms <= Date.now()) return '—';
    let s = Math.floor((ms - Date.now()) / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return d + '天' + h + '小时';
    if (h > 0) return h + '小时' + m + '分';
    return m + '分';
  }
  // 药丸里要短：4h51m 这种写法比「4小时51分」省一半宽度。
  function eta(ms) {
    if (!ms || ms <= Date.now()) return '';
    let s = Math.floor((ms - Date.now()) / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return d + 'd' + h + 'h';
    if (h > 0) return h + 'h' + m + 'm';
    return m + 'm';
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ── 拦截 Notion 自己的推理流 ──
  // Notion streams NDJSON from /runInferenceTranscript; the payload carries
  // inputTokens / outputTokens patches and the first content patch marks the
  // first visible token. Watching the stream is the only way to see per-message
  // figures, since the UI never shows them.
  const STREAM_RE = /runInferenceTranscript/;

  function noteRequestStart() {
    const now = performance.now();
    state.last = {
      tokensIn: 0, tokensOut: 0,
      ttftMs: -1, totalMs: -1,
      model: '', at: Date.now(), startedAt: now,
    };
  }

  function noteToken(which, n) {
    if (!state.last || !(n > 0)) return;
    if (which === 'in') state.last.tokensIn = Math.max(state.last.tokensIn, n);
    else state.last.tokensOut = Math.max(state.last.tokensOut, n);
  }

  function noteFirstContent() {
    if (state.last && state.last.ttftMs < 0) {
      state.last.ttftMs = performance.now() - state.last.startedAt;
    }
  }

  function noteRequestEnd() {
    if (!state.last) return;
    if (state.last.totalMs < 0) {
      state.last.totalMs = performance.now() - state.last.startedAt;
    }
    state.totals.count++;
    state.totals.tokensIn += state.last.tokensIn;
    state.totals.tokensOut += state.last.tokensOut;
    render();
  }

  // Pull tokens/model out of one NDJSON line without fully parsing everything.
  function scanLine(line) {
    if (!line || line.length < 8) return;
    if (line.indexOf('inputTokens') >= 0) {
      const m = line.match(/"inputTokens"\s*:\s*(\d+)/);
      if (m) noteToken('in', Number(m[1]));
    }
    if (line.indexOf('outputTokens') >= 0) {
      const m = line.match(/"outputTokens"\s*:\s*(\d+)/);
      if (m) noteToken('out', Number(m[1]));
    }
    if (!state.last.model && line.indexOf('model') >= 0) {
      const m = line.match(/"model(?:Name)?"\s*:\s*"([^"]{2,40})"/);
      if (m) state.last.model = m[1];
    }
    // A content patch means the first visible character arrived.
    if (line.indexOf('"content"') >= 0 && state.last && state.last.ttftMs < 0) {
      noteFirstContent();
    }
  }

  function scanChunk(text) {
    if (!text) return;
    for (const line of text.split('\n')) scanLine(line);
  }

  function installStreamHook() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function') return;
    // Re-arm after a page reload replaced window.fetch, but never double-wrap.
    if (nativeFetch.__notionPanelPatched) return;
    const patched = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isStream = STREAM_RE.test(url);
      if (!isStream) return nativeFetch.apply(this, arguments);
      noteRequestStart();
      return nativeFetch.apply(this, arguments).then((resp) => {
        try {
          if (!resp.body) { noteRequestEnd(); return resp; }
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          const wrapped = new ReadableStream({
            start(controller) {
              function pump() {
                reader.read().then(({ done, value }) => {
                  if (done) { controller.close(); noteRequestEnd(); return; }
                  try { scanChunk(dec.decode(value, { stream: true })); } catch {}
                  controller.enqueue(value);
                  pump();
                }).catch((e) => { try { controller.error(e); } catch {} noteRequestEnd(); });
              }
              pump();
            },
          });
          return new Response(wrapped, {
            status: resp.status, statusText: resp.statusText, headers: resp.headers,
          });
        } catch {
          noteRequestEnd();
          return resp;
        }
      });
    };
    patched.__notionPanelPatched = true;
    window.fetch = patched;
  }

  // ── 取数 ──
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (!r.ok) {
      const err = new Error(url + ' → HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  // 记住真正能读到额度的 spaceId。个人空间在部分部署下取额度会 403，
  // 有了这个记忆，从 blank 页打开时也能直接命中业务空间。
  const GOOD_SPACE_KEY = 'notion-desktop-panel:goodSpaceId';
  function rememberGoodSpace(id) {
    try { if (id && localStorage.getItem(GOOD_SPACE_KEY) !== id) localStorage.setItem(GOOD_SPACE_KEY, id); } catch {}
  }
  function goodSpace() {
    try { return localStorage.getItem(GOOD_SPACE_KEY) || null; } catch { return null; }
  }

  // 收集库里出现过的全部 space uuid（排除 userId），用于当前空间失败时换一个再试。
  function knownSpaceCandidates(exclude) {
    const bad = knownUserIds();
    const seen = new Set();
    const out = [];
    const push = (id) => {
      if (!id) return;
      const k = id.toLowerCase();
      if (k === String(exclude).toLowerCase() || bad.has(k) || seen.has(k)) return;
      seen.add(k); out.push(id);
    };
    try {
      const lv = localStorage.getItem('LRU:KeyValueStore2:lastVisitedRouteSpaceId');
      const m = lv && lv.match(UUID_RE);
      if (m) push(m[0]);
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        if (!/space/i.test(k)) continue;
        const v = localStorage.getItem(k) || '';
        for (const hit of v.matchAll(new RegExp(UUID_RE.source, 'gi'))) push(hit[0]);
      }
    } catch {}
    return out.slice(0, 6);
  }

  // userId 和 spaceId 长得一模一样（都是 uuid），拿错就会被 Notion 判为
  // ValidationError 400。把已知的 userId 收集起来当黑名单。
  function knownUserIds() {
    const ids = new Set();
    try {
      const gist = localStorage.getItem('gist.web.userToken') || '';
      const hit = gist.match(UUID_RE);
      if (hit) ids.add(hit[0].toLowerCase());
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        if (!/userToken|userId|notion_user/i.test(k)) continue;
        const m = (localStorage.getItem(k) || '').match(UUID_RE);
        if (m) ids.add(m[0].toLowerCase());
      }
    } catch {}
    return ids;
  }

  function spaceId() {
    // The chat tab carries spaceId in its query string; other tabs (blank,
    // quick-search) do not. Query string is the only trustworthy source, so it
    // wins over anything cached from an earlier guess.
    const q = new URLSearchParams(location.search);
    const fromQuery = q.get('spaceId') || q.get('space_id');
    if (fromQuery && UUID_RE.test(fromQuery)) {
      cacheSpaceId(fromQuery);
      return fromQuery;
    }

    // 已经验证能读到额度的空间优先，避免个人空间 403。
    const known = goodSpace();
    if (known && UUID_RE.test(known)) return known;

    // Notion exposes the active space on a few globals depending on build.
    const candidates = [
      window.__notion_space_id,
      window.spaceId,
      window.__spaceId,
      window.notion && window.notion.spaceId,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && UUID_RE.test(c)) {
        cacheSpaceId(c);
        return c;
      }
    }

    const userIds = knownUserIds();
    const usable = (id) => !!id && !userIds.has(id.toLowerCase());

    // Notion keeps the active space here; it is a space, not a user.
    try {
      const raw = localStorage.getItem('LRU:KeyValueStore2:lastVisitedRouteSpaceId');
      if (raw) {
        const m = raw.match(UUID_RE);
        if (m && usable(m[0])) { cacheSpaceId(m[0]); return m[0]; }
      }
    } catch {}

    if (cachedSpaceId && usable(cachedSpaceId)) return cachedSpaceId;

    // Last resort: scan localStorage for anything shaped like a space uuid.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        if (!/space/i.test(k)) continue;
        const v = localStorage.getItem(k) || '';
        const hit = v.match(UUID_RE);
        if (hit && usable(hit[0])) {
          cacheSpaceId(hit[0]);
          return hit[0];
        }
      }
    } catch {}

    return null;
  }

  // 一份额度响应里到底有没有「真数据」。
  // 个人空间会返回 200，但 allowances 是空的；只看 HTTP 状态码会误判为正常，
  // 面板于是显示成一串「—」。必须按内容判断。
  const hasCredits = (v) => Array.isArray(v && v.allowances) && v.allowances.some(
    (a) => a && a.state === 'resolved' && a.cadence === 'billing_period');

  async function refresh() {
    let sid = spaceId();
    if (!sid) {
      state.lastError = '未取到 spaceId';
      render();
      return;
    }
    try {
      let v = null;
      let firstErr = null;
      try {
        v = await postJSON(ENDPOINTS.rolling, { spaceId: sid });
      } catch (err) { firstErr = err; }

      // 请求失败、或「200 但没有任何额度数据」，都换一个空间再试。
      if (!hasCredits(v)) {
        for (const cand of knownSpaceCandidates(sid)) {
          try {
            const r = await postJSON(ENDPOINTS.rolling, { spaceId: cand });
            if (hasCredits(r)) { v = r; sid = cand; cacheSpaceId(cand); break; }
          } catch {}
        }
      }
      if (!hasCredits(v)) {
        if (firstErr) throw firstErr;
        throw new Error('该空间没有可读的额度数据');
      }
      rememberGoodSpace(sid);

      state.status = v.status || '';

      // 限额标记：Notion 用三个不同层级的字段表达「这条额度对当前账号管不管用」。
      //   status: "not_applicable"  → 整套 6h 限速判定对本次查询不适用
      //   allowances[].state        → resolved = 有实际数值；not_exposed = 有这条但不对 UI 暴露
      //   allowances[].enforcement  → enforced = 真在计量/会拦
      // 三者含义不同，所以分开记，不要合成一个布尔。
      state.limits = (() => {
        const list = Array.isArray(v.allowances) ? v.allowances : [];
        const rollingEntry = list.find((a) => a && a.cadence === 'rolling') || null;
        const periodEntries = list.filter((a) => a && a.cadence === 'billing_period' && a.state === 'resolved');
        const verdicts = v.modelSelectionDecisions || {};
        const anyVerdict = Object.keys(verdicts).map((k) => verdicts[k] && verdicts[k].verdict).filter(Boolean);

        return {
          // 6h：顶层 status 不是 not_applicable，才算「这个账号受 6h 限速管」
          sixHour: {
            applicable: !!v.status && v.status !== 'not_applicable',
            exposed: !!(rollingEntry && rollingEntry.state === 'resolved'),
            verdictStatus: anyVerdict.length ? (anyVerdict[0].status || '') : '',
            windowExposure: anyVerdict.length ? (anyVerdict[0].windowExposure || '') : '',
          },
          // 月度：只要有一条 billing_period 额度的 enforcement 是 enforced，就是真在计量
          monthly: {
            enforced: periodEntries.some((a) => a && a.enforcement === 'enforced'),
            count: periodEntries.length,
            exhausted: anyVerdict.some((d) => d && d.allowanceExhausted === true),
          },
          pricingPhase: '', // 由 getBillingData 补
        };
      })();

      // Notion 7.43 起把 window / billingPeriodWindow 换成了 allowances 数组，
      // 旧结构保留兜底，两个版本都能读。
      if (Array.isArray(v.allowances)) {
        const resolved = v.allowances.filter((a) => a && a.state === 'resolved');
        const pick = (list, cadence) => list.filter((a) => a.cadence === cadence);

        // 7.43 把 rolling 项标成 not_exposed（UI 不展示），
        // 但同一次响应的 modelSelectionDecisions[].verdict.window 里带着真实 6h 数值。
        const fromDecisions = () => {
          const d = v.modelSelectionDecisions || {};
          for (const key of ['flex', 'auto']) {
            const w = d[key] && d[key].verdict && d[key].verdict.window;
            if (w && typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0) {
              return { used: w.used, limit: w.limit, window: w.window || '6h', periodEndMs: 0 };
            }
          }
          return null;
        };

        const rolling = pick(resolved, 'rolling')[0] || pick(resolved, 'session')[0] || fromDecisions();
        // billing_period 下按 bucket 分开记账，flex 是主力（数值带小数），auto 通常为 0。
        const periods = pick(resolved, 'billing_period');
        const byBucket = (id) => periods.find((a) => a.bucketId === id) || null;
        const monthly = byBucket('flex') || byBucket('auto') || periods[0] || null;

        if (rolling) {
          // 6h 窗口是滑动的，接口不给固定 periodEnd，用「现在 + 6h」当作近似重置点。
          const resetAt = rolling.periodEndMs
            || (rolling.window === '6h' ? Date.now() + 6 * 3600 * 1000 : 0);
          state.rolling = {
            used: rolling.used,
            limit: rolling.limit,
            percent: pct(rolling.used, rolling.limit),
            resetAt: resetAt,
            window: rolling.window || (rolling.cadence === 'rolling' ? '6h' : rolling.cadence),
          };
        }
        if (monthly) {
          state.monthly = {
            used: monthly.used,
            limit: monthly.limit,
            percent: pct(monthly.used, monthly.limit),
            resetAt: monthly.periodEndMs || 0,
          };
          // 积分口径（credits）比百分比更能反映真实消耗，卡片里要用到。
          if (monthly.credits && typeof monthly.credits.used === 'number') {
            state.credits = {
              used: monthly.credits.used,
              limit: monthly.credits.limit,
            };
          }
        }

        // 两套月度额度分开记：auto = 标准积分（Notion 替你选模型），
        // flex = 自选积分（自己指定模型 / 自建代理）。两者独立，互不抵扣。
        // resetAt 跟百分比同一个来源（periodEndMs），设置页那句「重置于 …」就是它。
        const bucketInfo = (a) => a && a.credits && typeof a.credits.used === 'number'
          ? { used: a.credits.used, limit: a.credits.limit, resetAt: a.periodEndMs || 0 }
          : null;
        state.standard = bucketInfo(byBucket('auto'));
        state.select = bucketInfo(byBucket('flex'));
      } else {
        // 旧结构（<= 7.42）
        if (v.window && typeof v.window.used === 'number') {
          state.rolling = {
            used: v.window.used,
            limit: v.window.limit,
            percent: pct(v.window.used, v.window.limit),
            resetAt: v.resetsInSeconds > 0 ? Date.now() + v.resetsInSeconds * 1000 : 0,
            window: v.window.window || '6h',
          };
        }
        if (v.billingPeriodWindow && typeof v.billingPeriodWindow.used === 'number') {
          const bp = v.billingPeriodWindow;
          state.monthly = {
            used: bp.used,
            limit: bp.limit,
            percent: pct(bp.used, bp.limit),
            resetAt: bp.periodEndMs || 0,
          };
        }
      }
      state.lastError = '';
      state.updatedAt = Date.now();
      recordDelta();
    } catch (e) {
      state.lastError = e.message || String(e);
    }

    // 套餐信息单独取，失败不影响用量显示。
    try {
      const b = await postJSON(ENDPOINTS.billing, { spaceId: sid });
      const bd = b.billingData || {};
      const sub = bd.subscription || {};
      const item = (sub.items || [])[0] || {};
      state.plan = {
        name: (item.price && item.price.product) || bd.type || '未知',
        status: sub.status || '',
        periodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : 0,
      };
      // "enforced" 表示该工作空间已完全切到新的统一积分计费。
      if (state.limits) state.limits.pricingPhase = bd.unifiedAgentPricingPhase || '';
    } catch {}

    render();
  }

  // ── 额度增量追踪 ──
  // Notion 桌面端的推理请求不出现在页面的网络层（已用 CDP 全量验证），所以
  // 单次 token 与首字时间拿不到。轮询时比较百分比差值，即可反映这段时间用了多少。
  function recordDelta() {
    const r = state.rolling, m = state.monthly;
    if (!r || !m) return;

    if (!state.session) {
      state.session = {
        startAt: Date.now(),
        usedUnits: 0,
        rollingDelta: 0,
        monthlyDelta: 0,
      };
    }

    if (state.prev) {
      const dR = r.percent - state.prev.r;
      const dM = m.percent - state.prev.m;
      // 只认正增量；重置或回退时差值会是负数，直接跳过。
      if (dR > 0.001) {
        state.session.rollingDelta += dR;
        state.session.usedUnits += (dR / 100) * r.limit;
        state.history.push({
          t: new Date().toLocaleTimeString().slice(0, 5),
          d: dR,
        });
        if (state.history.length > 50) state.history.shift();
      }
      if (dM > 0.001) {
        state.session.monthlyDelta += dM;
      }
    }
    state.prev = { r: r.percent, m: m.percent };
  }

  // ── 渲染 ──
  const el = {};
  function build() {
    const root = document.createElement('div');
    root.id = PANEL_ID;

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const card = document.createElement('div');
    card.className = 'np-card';
    card.hidden = true;
    card.innerHTML =
      '<div class="np-hd"><b>Notion AI 用量</b><button class="np-x" title="关闭">×</button></div>' +
      '<div id="np-body"></div>' +
      '<div class="np-ft"><span id="np-time">—</span><button class="np-btn" id="np-refresh">刷新</button></div>';
    root.appendChild(card);

    const pill = document.createElement('div');
    pill.className = 'np-pill';
    pill.innerHTML =
      '<i class="np-dot"></i>' +
      '<span class="np-pct" id="np-r" title="6h 用量" hidden></span>' +
      '<i class="np-sep" id="np-sep-r" hidden></i>' +
      '<span class="np-pct" id="np-standard" title="标准积分 (Auto) 用量" hidden></span>' +
      '<span class="np-eta" id="np-standard-eta" hidden></span>' +
      '<i class="np-sep" id="np-sep-standard" hidden></i>' +
      '<span class="np-pct" id="np-m" title="月度用量">—</span>' +
      '<i class="np-sep"></i>' +
      '<span class="np-mut" id="np-plan">—</span>';
    root.appendChild(pill);

    document.documentElement.appendChild(root);

    el.root = root; el.card = card; el.body = card.querySelector('#np-body');
    el.time = card.querySelector('#np-time');
    el.pill = pill;
    el.dot = pill.querySelector('.np-dot');
    el.r = pill.querySelector('#np-r');
    el.sepR = pill.querySelector('#np-sep-r');
    el.standard = pill.querySelector('#np-standard');
    el.standardEta = pill.querySelector('#np-standard-eta');
    el.sepStandard = pill.querySelector('#np-sep-standard');
    el.m = pill.querySelector('#np-m');
    el.plan = pill.querySelector('#np-plan');

    pill.addEventListener('click', () => {
      state.open = !state.open;
      card.hidden = !state.open;
      if (state.open) refresh();
    });
    card.querySelector('.np-x').addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.open = false;
      card.hidden = true;
    });
    card.querySelector('#np-refresh').addEventListener('click', (ev) => {
      ev.stopPropagation();
      refresh();
    });
  }

  function bar(v) {
    return '<div class="np-bar"><i class="' + cls(v) + '" style="width:' + Math.min(100, v).toFixed(1) + '%"></i></div>';
  }

  function render() {
    if (!el.root) return;
    const r = state.rolling, m = state.monthly;

    // 当前账号是否受 6h 限速管。不受管时：pill 最左格、6h 栏、6h 增量行全部收掉。
    const sixOff = !!(state.limits && state.limits.sixHour && !state.limits.sixHour.applicable);
    const showRolling = !!r && !sixOff;
    el.r.hidden = !showRolling;
    if (el.sepR) el.sepR.hidden = !showRolling;
    if (showRolling) el.r.textContent = fmtPct(r.percent);
    const standard = state.standard;
    const showStandard = !!standard && Number.isFinite(standard.used)
      && Number.isFinite(standard.limit) && standard.limit > 0;
    const standardPercent = showStandard ? pct(standard.used, standard.limit) : 0;
    el.standard.hidden = !showStandard;
    el.sepStandard.hidden = !showStandard;
    if (showStandard) {
      el.standard.textContent = fmtPct(standardPercent);
      el.standard.title = '标准积分 (Auto)：' + fmtNum(standard.used) + ' / ' + fmtNum(standard.limit) +
        (standard.resetAt ? ' · 重置于 ' + fmtDate(standard.resetAt) : '');
      // 剩不到 48 小时才把倒计时塞进药丸——平时不占位置，快到期时才提醒。
      const leftMs = standard.resetAt ? standard.resetAt - Date.now() : 0;
      if (leftMs > 0 && leftMs <= 48 * 3600 * 1000) {
        el.standardEta.hidden = false;
        el.standardEta.textContent = eta(standard.resetAt);
        el.standardEta.title = '标准积分将在 ' + fmtDate(standard.resetAt) + ' 重置';
      } else {
        el.standardEta.hidden = true;
        el.standardEta.textContent = '';
      }
    } else {
      el.standardEta.hidden = true;
      el.standardEta.textContent = '';
    }
    el.m.textContent = m ? fmtPct(m.percent) : '—';
    el.plan.textContent = state.plan ? state.plan.name : '—';

    const worst = Math.max(showRolling ? r.percent : 0, standardPercent, m ? m.percent : 0);
    el.dot.className = 'np-dot ' + (state.lastError ? 'err' : cls(worst));
    el.pill.classList.toggle('np-err', !!state.lastError);

    let h = '';

    if (sixOff) {
      h += '<div class="np-sec">' +
        '<div class="np-lab"><span>当前窗口 (6h)</span></div>' +
        '<div class="np-note">当前账号套餐无 6h 限制</div></div>';
    } else if (r) {
      h += '<div class="np-sec">' +
        '<div class="np-lab"><span>当前窗口 (' + (r.window || '6h') + ')</span><b>' + fmtPct(r.percent) + '</b></div>' +
        bar(r.percent) +
        '<div class="np-meta"><span>' + r.used.toFixed(1) + ' / ' + r.limit + '</span>' +
        '<span>' + until(r.resetAt) + ' 后重置</span></div></div>';
    }
    if (m) {
      // 重置时间统一放到下面「结束/重置时间」一行，这里不再重复一遍。
      h += '<div class="np-sec">' +
        '<div class="np-lab"><span>月度用量</span><b>' + fmtPct(m.percent) + '</b></div>' +
        bar(m.percent) +
        '<div class="np-meta"><span>' + m.used.toFixed(1) + ' / ' + m.limit + '</span></div></div>';
    }
    // 两套月度积分分开列，口径是「积分」而不是百分比，和 Notion 设置页对得上。
    const bucketRow = (label, b, hint) => b
      ? '<div class="np-sec">' +
          '<div class="np-lab"><span>' + label + '</span><b>' + fmtNum(b.used) + ' / ' + b.limit + '</b></div>' +
          bar(pct(b.used, b.limit)) +
          '<div class="np-meta"><span>' + hint + '</span>' +
          '<span>剩 ' + fmtNum(Math.max(0, b.limit - b.used)) + '</span></div></div>'
      : '';
    h += bucketRow('标准积分 (Auto)', state.standard, 'Notion 替你选模型');
    h += bucketRow('自选积分 (Select)', state.select, '自己指定模型 / 自建代理');
    // 两套积分共用同一个账单周期，重置时间只在这里说一次，不再在各自的行里重复。
    // 优先用积分额度的 periodEndMs（那才是额度真正重置的时刻），订阅周期作为兜底。
    const resetAt = (state.standard && state.standard.resetAt)
      || (state.select && state.select.resetAt)
      || (state.plan && state.plan.periodEnd) || 0;
    if (state.plan || resetAt) {
      h += '<div class="np-sec">';
      if (state.plan) {
        h += '<div class="np-row"><span>套餐</span><b>' + state.plan.name + '</b></div>' +
          '<div class="np-row"><span>状态</span><span>' + (state.plan.status || '—') + '</span></div>';
      }
      if (resetAt) {
        h += '<div class="np-row"><span>结束/重置时间</span><span>' + fmtDate(resetAt) +
          (resetAt > Date.now() ? ' · ' + eta(resetAt) : '') + '</span></div>';
      }
      h += '</div>';
    }
    // Notion 桌面版的推理不走页面 fetch/XHR，抓不到单次 token，所以这里用
    // 额度增量来反映「这次打开用了多少」：每次轮询比对百分比，累加所消耗的量。
    if (state.session) {
      const s = state.session;
      h += '<div class="np-sec">' +
        '<div class="np-lab"><span>本次打开消耗</span><b>' + s.usedUnits.toFixed(1) + ' 单位</b></div>' +
        (sixOff ? '' : '<div class="np-row"><span>6h 窗口增加</span><span>' + (s.rollingDelta > 0 ? '+' + s.rollingDelta.toFixed(1) + '%' : '—') + '</span></div>') +
        '<div class="np-row"><span>月度增加</span><span>' + (s.monthlyDelta > 0 ? '+' + s.monthlyDelta.toFixed(1) + '%' : '—') + '</span></div>' +
        '<div class="np-row"><span>打开时长</span><span>' + until(Date.now() + (Date.now() - s.startAt)) + '</span></div>' +
        '</div>';
    }
    if (state.history.length > 0) {
      h += '<div class="np-sec"><div class="np-lab"><span>最近变化</span><b>' + state.history.length + ' 次</b></div>' +
        state.history.slice(-4).reverse().map(function (it) {
          return '<div class="np-row"><span>' + it.t + '</span><span>+' + it.d.toFixed(1) + '%</span></div>';
        }).join('') + '</div>';
    }
    // not_applicable 是 6h 限速的判定结果，套餐无 6h 限制时没必要展示这行原始值。
    if (state.status && !sixOff) {
      h += '<div class="np-sec"><div class="np-row"><span>额度状态</span><span>' + state.status + '</span></div></div>';
    }
    if (state.lastError) {
      h += '<div class="np-sec"><div class="np-errmsg">' + state.lastError + '</div></div>';
    }
    if (!r && !m && !state.lastError) {
      h = '<div class="np-sec np-mut">正在读取…</div>';
    }
    el.body.innerHTML = h;
    el.time.textContent = state.updatedAt
      ? '更新 ' + new Date(state.updatedAt).toLocaleTimeString()
      : '—';
  }

  // Notion installs its own fetch wrapper after our early injection, which would
  // silently overwrite ours. Poll until the app settles, re-arming whenever the
  // patch is gone, and stop once it has stayed put for a while.
  installStreamHook();
  let rearmTries = 0;
  const rearmTimer = setInterval(() => {
    if (window.fetch && window.fetch.__notionPanelPatched) {
      if (++rearmTries > 6) clearInterval(rearmTimer);
      return;
    }
    installStreamHook();
    if (++rearmTries > 20) clearInterval(rearmTimer);
  }, 1500);

  build();
  render();
  refresh();
  setInterval(refresh, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  window.__notionPanel = {
    refresh, state,
    rearm: installStreamHook,
  };
  return 'ok';
})();