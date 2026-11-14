// services.mjs — MCP 服務 + cloudflared 隧道的常駐看護程式
//
// 為什麼要獨立成一支程式：
//   原本 launch.mjs 用子行程持有 MCP 與 cloudflared，並在自身退出時 taskkill 帶走它們。
//   但啟動器在「注入程式已在執行」時會立刻結束，而且一旦它被手動殺掉（或用 kill /T），
//   隧道就跟著斷，Notion 雲端那邊就會出現「本地編輯工具失敗」。
//
// 現在：這支程式由排程工作 NotionMcpServices（僅手動觸發，不隨開機啟動）拉起，
//       生命週期跟著 Notion 走：
//         - Notion 不在 → 完全不啟用隧道（沒開 Notion 就不佔資源）
//         - Notion 在   → 看護 MCP 與 cloudflared，死了 5 秒內補起來
//         - Notion 關掉滿 25 秒 → 收掉隧道與 MCP 後自行結束
//       之所以從「看 Notion」著手而不是「看啟動器」，是因為啟動器會被關掉、
//       也會因為注入程式已在執行而提早結束，用它判斷會造成隧道中途斷線。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.dirname(DIR);
// MCP 服務端預設放在上一層同級目錄，可用環境變數指到任何位置。
const MCP_DIR = process.env.SERVICES_MCP_DIR || path.join(BASE, 'notion-local-ops-mcp');
const MCP_PY = process.env.SERVICES_MCP_PYTHON || path.join(MCP_DIR, '.venv', 'Scripts', 'python.exe');
const MCP_LOG = path.join(MCP_DIR, 'mcp-runtime.log');
const MCP_PORT = Number(process.env.SERVICES_MCP_PORT || 8766);
// cloudflared 同樣可覆寫，找不到就在 PATH 裡找。
const CF_EXE = process.env.SERVICES_CLOUDFLARED || path.join(BASE, 'cloudflared', 'cloudflared.exe');

// ── 隧道 token ──
// 不要把 token 寫進原始碼：優先讀環境變數，其次讀同目錄的 tunnel.token
// （該檔已在 .gitignore 內）。兩者都沒有就完全不啟用隧道，只跑 MCP。
function readTunnelToken() {
  const fromEnv = (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  for (const p of [process.env.SERVICES_TUNNEL_TOKEN_FILE,
                   path.join(DIR, 'tunnel.token')].filter(Boolean)) {
    try {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch {}
  }
  return '';
}
const CF_TOKEN = readTunnelToken();
// 可用環境變數覆寫，方便做不影響正式服務的驗證。
const PID_FILE = process.env.SERVICES_PID_FILE || path.join(DIR, 'services.pid');
const LOG_FILE = process.env.SERVICES_LOG_FILE || path.join(DIR, 'services.log');
const WATCH_MS = 5000;
const MIN_GAP_MS = 4000;
const LOG_MAX = 200 * 1024;

// 生命週期綁定 Notion：Notion 不在就一直不啟用隧道（省資源），
// Notion 關掉滿 IDLE_EXIT_MS 就收工。留寬限是因為更新時 Notion 會短暫歸零。
const NOTION_IMAGE = process.env.SERVICES_NOTION_IMAGE || 'Notion.exe';
const IDLE_EXIT_MS = Number(process.env.SERVICES_IDLE_EXIT_MS || 25000);
const STARTUP_GRACE_MS = Number(process.env.SERVICES_STARTUP_GRACE_MS || 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { console.log(line); } catch {}
}

function trimLog() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-400).join('\n'));
    }
  } catch {}
}

function portInUse(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

function cfRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /cloudflared\.exe/i.test(r.stdout || '');
}

function loadEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
  } catch (e) { log('讀取 .env 失敗: ' + e.message); }
  return out;
}

// ── 單實例鎖 ──
function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /^"node\.exe"/im.test(r.stdout || '');
}

function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (pid && pid !== process.pid && pidAlive(pid)) {
      log('看護程式已在執行 (pid ' + pid + ')，本次啟動結束');
      return false;
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
  return true;
}

// ── 被看護的兩個服務 ──
let mcpProc = null;
let cfProc = null;
let lastMcpStart = 0;
let lastCfStart = 0;
// 只有真正進入「看護中」才允許收尾時清除服務。
// 否則「等不到 Notion 就退出」這條路會把別人正在用的隧道一起殺掉。
let armed = false;

function startMcp() {
  if (Date.now() - lastMcpStart < MIN_GAP_MS) return;
  lastMcpStart = Date.now();
  if (!fs.existsSync(MCP_PY)) { log('找不到 MCP python：' + MCP_PY); return; }
  // Python 需要可解析的 home；排程工作環境可能缺少 USERPROFILE，補上再給它。
  const home = process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : '')
    || (process.env.USERPROFILE || process.cwd());
  const env = Object.assign({}, process.env, {
    USERPROFILE: home,
    HOME: home,
    APPDATA: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    TEMP: process.env.TEMP || path.join(home, 'AppData', 'Local', 'Temp'),
    TMP: process.env.TMP || path.join(home, 'AppData', 'Local', 'Temp'),
    // 讓 Python 子行程一律用 UTF-8，避免中文輸出在 GBK 主控台炸掉。
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }, loadEnvFile(path.join(MCP_DIR, '.env')));
  log('啟動 MCP 服務...');
  const out = fs.openSync(MCP_LOG, 'a');
  mcpProc = spawn(MCP_PY, ['-m', 'notion_local_ops_mcp.server'], {
    cwd: MCP_DIR, env: env, windowsHide: true,
    stdio: ['ignore', out, out],
  });
  mcpProc.on('exit', (c) => { log('MCP 服務結束 (code=' + c + ')'); mcpProc = null; });
}

let cfTokenWarned = false;
function startCf() {
  if (Date.now() - lastCfStart < MIN_GAP_MS) return;
  lastCfStart = Date.now();
  if (!CF_TOKEN) {
    if (!cfTokenWarned) { cfTokenWarned = true; log('未設定隧道 token（CLOUDFLARE_TUNNEL_TOKEN 或 tunnel.token），跳過 cloudflared'); }
    return;
  }
  if (!fs.existsSync(CF_EXE)) { log('找不到 cloudflared：' + CF_EXE); return; }
  log('啟動 cloudflared 隧道...');
  cfProc = spawn(CF_EXE, ['tunnel', '--no-autoupdate', 'run', '--token', CF_TOKEN], {
    stdio: 'ignore', windowsHide: true,
  });
  cfProc.on('exit', (c) => { log('cloudflared 結束 (code=' + c + ')'); cfProc = null; });
}

function notionRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + NOTION_IMAGE, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return new RegExp(NOTION_IMAGE.replace(/\./g, '\\.'), 'i').test(r.stdout || '');
}

function killChildren() {
  for (const [p, name] of [[cfProc, 'cloudflared'], [mcpProc, 'MCP 服務']]) {
    if (!p || p.killed) continue;
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
      log(name + ' 已停止');
    } catch {}
  }
}

// 收工時要清乾淨——包括「接手看護」的情況（那時 mcpProc/cfProc 是 null，
// 手上沒有 pid，只能按映像名與模組名清除）。
// 驗證用：只記錄不真的清除，避免測試時影響正式在跑的服務。
const DRY_STOP = process.env.SERVICES_DRY_STOP === '1';

function stopAll() {
  if (DRY_STOP) {
    log('[DRY_STOP] 應清除 cloudflared 與 MCP 服務（實際未動）');
    return;
  }
  killChildren();
  try {
    const c = spawnSync('taskkill', ['/F', '/IM', 'cloudflared.exe'], { stdio: 'ignore', windowsHide: true });
    if (c.status === 0) log('cloudflared 已清除');
  } catch {}
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*notion_local_ops_mcp*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    log('MCP 服務已清除');
  } catch {}
}

async function main() {
  trimLog();
  if (!acquireLock()) return;
  log('=== 服務看護啟動 (pid ' + process.pid + ') ===');

  // 第一階段：等 Notion 出現。等不到就完全不啟用隧道，直接結束——這樣
  // 「沒開 Notion 的時候不會有隧道在背景吃資源」。
  const t0 = Date.now();
  while (!notionRunning()) {
    if (Date.now() - t0 > STARTUP_GRACE_MS) {
      log('Notion 在 ' + Math.round(STARTUP_GRACE_MS / 1000) + ' 秒內未啟動，看護程式結束（不啟用隧道）');
      return;
    }
    await sleep(1000);
  }
  log('偵測到 ' + NOTION_IMAGE + ' 已在執行，開始看護服務');
  armed = true;

  // 首次：缺什麼補什麼
  if (!(await portInUse(MCP_PORT))) startMcp();
  else log('MCP 服務已在 ' + MCP_PORT + ' 執行，接手看護');
  if (!cfRunning()) startCf();
  else log('cloudflared 已在執行，接手看護');

  let downTicks = 0;
  let notionAbsentSince = 0;
  while (true) {
    await sleep(WATCH_MS);

    // 第二階段：Notion 走了就收工（留寬限，避免更新重啟時誤殺隧道）
    if (!notionRunning()) {
      if (!notionAbsentSince) {
        notionAbsentSince = Date.now();
        log('偵測到 ' + NOTION_IMAGE + ' 不在，開始計時收工');
      }
      if (Date.now() - notionAbsentSince >= IDLE_EXIT_MS) {
        log('Notion 已關閉滿 ' + Math.round(IDLE_EXIT_MS / 1000) + ' 秒，關閉隧道與 MCP 服務後結束');
        // 子程序仍然活著時，main() 返回不會讓 Node 退出；必須明確退出，
        // 才會觸發 exit handler 收掉 MCP 和隧道。
        process.exit(0);
      }
      continue;
    }
    notionAbsentSince = 0;

    const mcpUp = await portInUse(MCP_PORT);
    const cfUp = cfRunning();
    if (!mcpUp) {
      downTicks++;
      if (downTicks === 1 || downTicks % 12 === 0) log('偵測到 MCP 服務未監聽 ' + MCP_PORT + '，重新拉起');
      startMcp();
    } else {
      downTicks = 0;
    }
    if (!cfUp) {
      if (!lastCfStart || Date.now() - lastCfStart >= MIN_GAP_MS) log('偵測到 cloudflared 不在，重新拉起');
      startCf();
    }
  }
}

process.on('exit', () => {
  if (armed) stopAll();
  try { if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

main().catch((e) => { log('看護程式異常: ' + (e && e.stack || e)); process.exit(1); });
