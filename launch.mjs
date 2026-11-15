// launch.mjs — Notion 啟動器
//   1. （可選）若設 NOTION_PANEL_WITH_MCP=1，先確保 MCP 與隧道在跑；預設不做
//   2. 若 9223 已有 Notion 在回應，直接進入注入，不重啟
//   3. 否則結束所有 Notion.exe，再帶 --remote-debugging-port 啟動
//   4. 在同一個程序內啟動注入程式；Notion 關閉時本程式結束，
//      但不動 MCP 與隧道 —— 這兩者與 Notion 生命週期解耦，見 services.mjs。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startInjector, log, trimLog, DIR, PORT, HOST, PID_FILE, LOG_FILE } from './inject.mjs';

// LOCALAPPDATA can be empty in stripped environments, which silently produced
// a relative path. Probe the known install locations instead of trusting it.
function findNotionExe() {
  if (process.env.NOTION_EXE && fs.existsSync(process.env.NOTION_EXE)) return process.env.NOTION_EXE;
  const home = process.env.USERPROFILE || 'C:\\Users\\' + (process.env.USERNAME || '');
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Notion', 'Notion.exe'),
    home && path.join(home, 'AppData', 'Local', 'Programs', 'Notion', 'Notion.exe'),
    'C:\\Program Files\\Notion\\Notion.exe',
    'C:\\Program Files (x86)\\Notion\\Notion.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[1];
}
const NOTION_EXE = findNotionExe();
const READY_TIMEOUT_MS = 30_000;

// MCP 讓 Notion 能操作本機檔案；cloudflared 把它暴露到公網，Notion 雲端才連得進來。
const MCP_PORT = Number(process.env.SERVICES_MCP_PORT || 8766);

// 服務改由排程工作承載，本程式只負責「確認它們在跑」，不持有子程序。
// 這樣即使本程式被關掉或 taskkill，隧道也不會跟著斷。
const SERVICES_TASK = process.env.SERVICES_TASK_NAME || 'NotionMcpServices';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNotionUA = (v) => !!v && /Notion\//.test(v['User-Agent'] || '');

function showError(msg) {
  log('錯誤:', msg);
  const psString = "'" + msg.replace(/'/g, "''") + "'";
  const ps = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(' + psString + ", 'Notion 啟動器')";
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function probeVersion(timeoutMs = 1500) {
  try {
    const r = await fetch('http://' + HOST + ':' + PORT + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
    return await r.json();
  } catch { return null; }
}

function notionPids() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Notion.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const pids = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"Notion\.exe","(\d+)"/i);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

async function killNotion() {
  let pids = notionPids();
  if (pids.length === 0) { log('沒有執行中的 Notion.exe'); return; }
  log('結束 Notion.exe（' + pids.length + ' 個程序）');
  spawnSync('taskkill', ['/IM', 'Notion.exe'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 8 && notionPids().length > 0; i++) await sleep(500);
  if (notionPids().length > 0) {
    log('仍有殘留，強制結束');
    spawnSync('taskkill', ['/F', '/T', '/IM', 'Notion.exe'], { stdio: 'ignore', windowsHide: true });
  }
  for (let i = 0; i < 20 && notionPids().length > 0; i++) await sleep(500);
  pids = notionPids();
  if (pids.length > 0) throw new Error('無法結束 Notion.exe（剩餘 PID: ' + pids.join(',') + '）');
  log('Notion.exe 已全部結束');
}

function injectorAlreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /^"node\.exe"/im.test(r.stdout || '');
  } catch { return false; }
}

// ── 附屬服務 ──

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

function triggerServicesTask() {
  const r = spawnSync('schtasks', ['/Run', '/TN', SERVICES_TASK], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

// 面板只靠 CDP 注入，跟 MCP / 隧道完全无关。
// 只有显式设了 NOTION_PANEL_WITH_MCP=1 才会去碰那两个服务（那是另一件事）。
// 仓库里没有 .with-mcp 这个文件，所以默认就是纯面板。
const WITH_MCP = process.env.NOTION_PANEL_WITH_MCP === '1'
  || fs.existsSync(path.join(DIR, '.with-mcp'));

async function ensureServices() {
  if (!WITH_MCP) return;
  const mcpUp = await portInUse(MCP_PORT);
  const cfUp = cfRunning();
  if (mcpUp && cfUp) {
    log('MCP 與隧道都在執行，略過啟動');
    return;
  }
  log('服務狀態 MCP=' + (mcpUp ? 'up' : 'down') + ' tunnel=' + (cfUp ? 'up' : 'down') + '，交由看護程式補起');
  if (triggerServicesTask()) {
    log('已觸發排程工作 ' + SERVICES_TASK);
  } else {
    // 排程工作不存在時退回到直接拉起看護程式（它自己會做單實例鎖）。
    log('無法觸發排程工作 ' + SERVICES_TASK + '，直接啟動 services.mjs');
    spawn(process.execPath, [path.join(DIR, 'services.mjs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  }
  for (let i = 0; i < 30; i++) {
    if (await portInUse(MCP_PORT, 400)) {
      log('MCP 已就緒（' + (i * 0.5).toFixed(1) + 's）');
      return;
    }
    await sleep(500);
  }
  log('等待 MCP 就緒逾時，請檢查 services.log');
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { process.exit(0); });
}

// Notion 更新後會用 "Notion.exe --updated" 自己重啟，新進程不帶調試端口，
// 注入器因此斷線。這裡負責把帶端口的 Notion 重新拉起來。
async function ensureDebugPort() {
  let v = await probeVersion();
  if (isNotionUA(v)) {
    log('Notion 已在 ' + PORT + ' 上回應，略過重啟');
    return;
  }
  if (v) throw new Error('127.0.0.1:' + PORT + ' 已被其他程式佔用（' + (v['User-Agent'] || v.Browser) + '）');

  const running = notionPids();
  if (running.length > 0) {
    log('Notion 正在執行但未開調試端口（多為更新完成後自行重啟），將帶端口重新啟動');
  }
  await killNotion();
  log('啟動 ' + NOTION_EXE + ' --remote-debugging-port=' + PORT);
  spawn(NOTION_EXE, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore', cwd: path.dirname(NOTION_EXE) });
  const t0 = Date.now();
  while (true) {
    v = await probeVersion(1000);
    if (isNotionUA(v)) break;
    if (Date.now() - t0 > READY_TIMEOUT_MS) {
      throw new Error('等待 ' + (READY_TIMEOUT_MS / 1000) + ' 秒後 debug port 仍無回應，詳見 ' + LOG_FILE);
    }
    await sleep(500);
  }
  log('debug port 就緒（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）: ' + v.Browser);
}

// Notion 關閉時不要立刻拆隧道：更新重啟的過程中進程會短暫歸零，
// 給一段寬限時間等它回來，回來就繼續接管。
async function waitForNotion(seconds) {
  for (let i = 0; i < seconds; i++) {
    if (notionPids().length > 0) return true;
    await sleep(1000);
  }
  return notionPids().length > 0;
}

async function supervise() {
  trimLog();
  log('=== 啟動器開始 ===');
  if (!fs.existsSync(NOTION_EXE)) {
    throw new Error('找不到 Notion.exe：' + NOTION_EXE);
  }

  // 服務與 Notion 並行起，互不阻塞。
  await ensureServices();

  let takeovers = 0;
  while (true) {
    await ensureDebugPort();
    if (injectorAlreadyRunning()) {
      log('注入程式已在執行，本次啟動器結束');
      return;
    }
    await startInjector(); // 直到 Notion 斷線才返回

    if (!(await waitForNotion(20))) {
      log('Notion 已關閉（20 秒內未重啟），啟動器結束');
      return;
    }
    if (++takeovers > 6) {
      log('重新接管已達 ' + takeovers + ' 次，停止以免反覆重啟 Notion');
      return;
    }
    log('Notion 仍在執行但注入連線中斷（更新後自動重啟），第 ' + takeovers + ' 次重新接管');
    await ensureServices(); // MCP 或隧道若掉了則補起
  }
}

supervise().catch((e) => { showError(e.message); setTimeout(() => process.exit(1), 500); });