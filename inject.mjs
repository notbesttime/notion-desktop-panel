// inject.mjs — 透過 Chrome DevTools Protocol 把 panel.js 注入所有 Notion 分頁。
// 零 npm 依賴：使用 Node 22+ 內建的 WebSocket 與 fetch。
//
// 行為：
//   * 連上 Notion 的 browser endpoint（--remote-debugging-port）
//   * 對所有現有與之後新開的 Notion 分頁（type=page、url 為 Notion 網址）：
//       - 立即執行 panel.js，掛上懸浮用量面板
//       - 註冊 Page.addScriptToEvaluateOnNewDocument，Ctrl+R 重新載入時在文件一開始就套用
//   * 監看 panel.js，變更時重新注入所有分頁並更新 new-document script
//   * browser endpoint 斷線（Notion 關閉）時自動結束
//
// 可單獨執行：node inject.mjs（前提是 Notion 已帶 --remote-debugging-port 啟動）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
// 9222 is usually taken by other Electron apps, so the default is 9223.
// Override with NOTION_DEBUG_PORT if it collides with something on your machine.
export const PORT = Number(process.env.NOTION_DEBUG_PORT || 9223);
export const HOST = '127.0.0.1';
export const PANEL_FILE = path.join(DIR, 'panel.js');
export const LOG_FILE = path.join(DIR, 'notion-panel.log');
export const PID_FILE = path.join(DIR, 'notion-panel.pid');
export const STYLE_ID = 'notion-desktop-panel-root';

const NOTION_URL_RE = /^https:\/\/(app\.notion\.com|www\.notion\.so|notion\.so)(\/|$)/;

// ---------- log ----------
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}
export function trimLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 1024 * 1024) {
      const buf = fs.readFileSync(LOG_FILE);
      fs.writeFileSync(LOG_FILE, buf.subarray(buf.length - 200 * 1024));
    }
  } catch {}
}

// ---------- 注入腳本（在頁面內執行） ----------
// The panel is plain JS rather than CSS: it needs to call Notion's own usage
// endpoints and paint live numbers, which a <style> tag cannot do.
export function buildInjectScript(panelSource) {
  return `(() => {
  try {
    if (window.__notionPanel && document.getElementById(${JSON.stringify(STYLE_ID)})) {
      window.__notionPanel.refresh();
      return 'already';
    }
    ${panelSource}
    return 'ok';
  } catch (e) {
    return 'error: ' + (e && e.message ? e.message : String(e));
  }
})();`;
}

// ---------- 極簡 CDP client（flat session） ----------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // event -> [fn]
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
      } else if (m.method) {
        for (const fn of this.handlers.get(m.method) || []) {
          try { fn(m.params, m.sessionId); } catch (err) { log('handler error', m.method, err.message); }
        }
      }
    };
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('websocket error'));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

function readPanel() {
  try { return fs.readFileSync(PANEL_FILE, 'utf8'); }
  catch (e) { log(`讀取 panel.js 失敗: ${e.message}`); return ''; }
}

// ---------- 主程式 ----------
export async function startInjector() {
  trimLog();
  const versionUrl = `http://${HOST}:${PORT}/json/version`;
  let version;
  try {
    version = await (await fetch(versionUrl)).json();
  } catch (e) {
    log(`無法連線 ${versionUrl}：${e.message}`);
    throw e;
  }
  if (!/Notion\//.test(version['User-Agent'] || '')) {
    log(`警告：${PORT} 上的程式不是 Notion（UA: ${version['User-Agent']}）`);
  }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.open();
  log(`已連線 ${version.webSocketDebuggerUrl}  (${version.Browser})`);

  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  const cleanup = () => {
    try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
  };

  let panel = readPanel();
  let script = buildInjectScript(panel);

  const sessions = new Map(); // targetId -> { sessionId, scriptId, url }
  const isNotionPage = (t) => t.type === 'page' && NOTION_URL_RE.test(t.url || '');

  async function injectSession(s, why) {
    if (!s.sessionId) return;
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: script, returnByValue: true }, s.sessionId);
      const out = r?.exceptionDetails ? 'EXCEPTION ' + r.exceptionDetails.text : r?.result?.value;
      log(`注入(${why}) ${s.url} -> ${out}`);
    } catch (e) {
      log(`注入失敗 ${s.url}: ${e.message}`);
    }
  }

  async function registerNewDocScript(s) {
    try {
      if (s.scriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, s.sessionId).catch(() => {});
        s.scriptId = null;
      }
      const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, s.sessionId);
      s.scriptId = r.identifier;
    } catch (e) {
      log(`註冊 new-document script 失敗 ${s.url}: ${e.message}`);
    }
  }

  async function attach(t) {
    if (sessions.has(t.targetId)) return;
    const s = { sessionId: null, scriptId: null, url: t.url };
    sessions.set(t.targetId, s);
    try {
      const r = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      s.sessionId = r.sessionId;
      await cdp.send('Page.enable', {}, s.sessionId);
      await registerNewDocScript(s);
      await injectSession(s, 'attach');
    } catch (e) {
      log(`attach 失敗 ${t.url}: ${e.message}`);
      sessions.delete(t.targetId);
    }
  }

  cdp.on('Target.targetCreated', ({ targetInfo }) => {
    if (isNotionPage(targetInfo)) attach(targetInfo);
  });
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
    const s = sessions.get(targetInfo.targetId);
    if (s) s.url = targetInfo.url;
    else if (isNotionPage(targetInfo)) attach(targetInfo); // 新分頁的 url 由空字串變成 Notion 網址
  });
  cdp.on('Target.targetDestroyed', ({ targetId }) => {
    const s = sessions.get(targetId);
    if (s) { sessions.delete(targetId); log(`分頁關閉 ${s.url}`); }
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
    for (const [tid, s] of sessions) if (s.sessionId === sessionId) sessions.delete(tid);
  });
  // 重新載入後 new-document script 已在文件一開始套用；load 完成再補一次以防萬一
  cdp.on('Page.loadEventFired', (_p, sessionId) => {
    for (const s of sessions.values()) if (s.sessionId === sessionId) injectSession(s, 'load');
  });

  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // ---------- 監看 panel.js ----------
  let timer = null;
  const onPanelChange = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const next = readPanel();
      if (next === panel) return;
      panel = next;
      script = buildInjectScript(panel);
      log(`panel.js 變更 (${panel.length} bytes)，重新注入 ${sessions.size} 個分頁`);
      for (const s of sessions.values()) {
        if (!s.sessionId) continue;
        await registerNewDocScript(s);
        await injectSession(s, 'panel-change');
      }
    }, 150);
  };
  try {
    // 監看目錄而非檔案：編輯器常用「寫暫存檔再改名」存檔，直接監看檔案會失效
    const target = path.basename(PANEL_FILE).toLowerCase();
    fs.watch(DIR, (_ev, name) => { if (name && name.toLowerCase() === target) onPanelChange(); });
  } catch (e) {
    log(`fs.watch 失敗，改用輪詢: ${e.message}`);
    fs.watchFile(PANEL_FILE, { interval: 1000 }, onPanelChange);
  }

  // ---------- 結束條件 ----------
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  // main() returned here, so the process would exit immediately even though the
  // CDP socket is still open. Hold it alive until Notion disconnects.
  return new Promise((resolve) => {
    let closed = false;
    const onDrop = (why) => {
      if (closed) return;
      closed = true;
      log(`browser endpoint ${why}（Notion 結束或更新重啟），注入程式退出`);
      cleanup();
      resolve({ cdp, sessions });
    };
    cdp.ws.onclose = () => onDrop('已關閉');
    cdp.ws.onerror = () => onDrop('連線中斷');
  });
}

// 直接以 node inject.mjs 執行時
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startInjector().catch((e) => { log('啟動失敗:', e.message); process.exit(1); });
}