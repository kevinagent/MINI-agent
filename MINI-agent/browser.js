// Browser automation via Edge CDP (Chrome DevTools Protocol)
// Zero external dependencies — uses Node.js built-in WebSocket

const { exec, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CDP_PORT = 9222;
function dlog(msg) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`); }

// ===== Self-healing: Edge process monitor =====
let edgeProcess = null;        // spawned Edge process handle
let edgeRestartCount = 0;      // consecutive restart count
const MAX_RESTARTS = 5;        // max auto-restarts before giving up
const RESTART_COOLDOWN = 60000;// reset restart count after 60s
let lastRestartReset = Date.now();
let watchdogTimer = null;      // health check interval
let tabCleanupTimer = null;    // tab cleanup interval

function findEdge() {
  const paths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return 'msedge.exe';
}

// 浏览器启动参数 - 有头模式 + 反自动化检测
const BROWSER_ARGS = [
  'remote-debugging-port=9222',
  'no-first-run',
  'no-default-browser-check',
  'disable-blink-features=AutomationControlled',
  'disable-infobars',
  'disable-translate',
  'disable-features=TranslateUI',
  'disable-background-networking',
  'disable-background-timer-throttling',
  'disable-backgrounding-occluded-windows',
  'disable-client-side-phishing-detection',
  'disable-crash-reporter',
  'disable-oopr-debug-crash-dump',
  'no-crash-upload',
  'disable-popup-blocking',
  'disable-prompt-on-repost',
  'disable-renderer-backgrounding',
  'disable-sync',
  'disable-breakpad',
  'disable-setuid-sandbox',
  'no-sandbox',
  'disable-dev-shm-usage',
  'window-size=1920,1080',
  'lang=zh-CN',
  'accept-lang=zh-CN,zh,en-US,en',
  'start-maximized',
  // Memory optimization (P1)
  'js-flags=--max-old-space-size=512 --optimize-for-size',
  'memory-model=low',
  'aggressive-cache-discard',
  'disable-gpu',              // reduce GPU memory if not needed
  'disable-software-rasterizer',
  'disable-extensions',       // fewer extension processes
  'disable-component-extensions-with-background-pages',
  'disable-default-apps',
  'no-default-browser-check',
  'disable-hang-monitor',
  'disable-ipc-flooding-protection',
  'disable-renderer-accessibility',
  // P1: More memory optimization
  'memory-pressure-off'
];

async function isEdgeHealthy() {
  try {
    const url = await getWsUrl();
    return !!url;
  } catch { return false; }
}

async function launchEdge() {
  const edge = findEdge();

  // If already healthy, just return
  try { if (await isEdgeHealthy()) { dlog('[BROWSER] Edge already running'); return; } } catch {}

  // Reset restart counter if enough time has passed
  if (Date.now() - lastRestartReset > RESTART_COOLDOWN) {
    edgeRestartCount = 0;
    lastRestartReset = Date.now();
  }
  if (edgeRestartCount >= MAX_RESTARTS) {
    throw new Error(`Edge auto-restart limit (${MAX_RESTARTS}) reached. Please check Edge installation.`);
  }

  const cdpProfile = path.join(require('os').homedir() || process.env.USERPROFILE || 'C:\\Users', '.edge-cdp-profile');

  // P0: Clean cdpProfile before launch (self-healing)
  try {
    if (fs.existsSync(cdpProfile)) {
      fs.rmSync(cdpProfile, { recursive: true, force: true });
      dlog('[BROWSER] cdpProfile cleaned');
    }
  } catch (e) { dlog(`[BROWSER] clean warn: ${e.message}`); }
  fs.mkdirSync(cdpProfile, { recursive: true });

  // Kill any stale Edge processes on the same CDP port first
  try {
    exec('taskkill /F /IM msedge.exe /FI "WINDOWTITLE eq *" 2>nul', () => {});
    await new Promise(r => setTimeout(r, 800));
  } catch {}

  // Build args array for spawn
  const args = [...BROWSER_ARGS.map(a => `--${a}`), `--user-data-dir=${cdpProfile}`];
  dlog(`[BROWSER] launching: ${edge} (attempt ${edgeRestartCount + 1}/${MAX_RESTARTS})`);

  // Use spawn to get process handle for monitoring
  edgeProcess = spawn(edge, args, {
    detached: false,
    windowsHide: false,
    stdio: 'ignore'
  });

  edgeProcess.on('error', (err) => {
    dlog(`[BROWSER] process error: ${err.message}`);
  });
  edgeProcess.on('exit', (code) => {
    dlog(`[BROWSER] process exited with code ${code}`);
    edgeProcess = null;
  });

  edgeRestartCount++;

  // Wait for CDP service ready, up to 20s
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const url = await getWsUrl();
      if (url) {
        dlog(`[BROWSER] CDP ready after ${(i+1)*0.5}s`);
        startWatchdog();
        startTabCleanup();
        return;
      }
    } catch {}
  }
  throw new Error('Edge CDP did not start');
}

// Watchdog: periodically check Edge health and auto-restart if dead
function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    const healthy = await isEdgeHealthy();
    if (!healthy) {
      dlog('[BROWSER] watchdog: Edge unhealthy, attempting restart...');
      try {
        edgeProcess = null;
        await launchEdge();
        dlog('[BROWSER] watchdog: restart successful');
      } catch (e) {
        dlog(`[BROWSER] watchdog: restart failed: ${e.message}`);
      }
    }
  }, 30000); // check every 30s
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (tabCleanupTimer) { clearInterval(tabCleanupTimer); tabCleanupTimer = null; }
}

async function getWsUrl() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const pages = JSON.parse(d);
          // Prefer non-blank page, fall back to first page
          const target = pages.find(p => p.type === 'page' && p.url !== 'about:blank') || pages.find(p => p.type === 'page');
          resolve(target?.webSocketDebuggerUrl || null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ===== Tab management: list and cleanup tabs (P1) =====
async function listAllTabs() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).filter(p => p.type === 'page')); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function closeTabById(targetId) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: CDP_PORT,
      path: `/json/close/${targetId}`, method: 'PUT'
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function cleanupBlankTabs() {
  try {
    const tabs = await listAllTabs();
    const blankTabs = tabs.filter(t => t.url === 'about:blank');
    // Keep one blank tab at most, close the rest
    if (blankTabs.length > 1) {
      const toClose = blankTabs.slice(1);
      dlog(`[TAB] closing ${toClose.length} extra blank tab(s)`);
      for (const t of toClose) {
        await closeTabById(t.id);
        await new Promise(r => setTimeout(r, 200));
      }
    }
    // Close stale tabs (unused > 30 min) — heuristic: if title is empty or 'New Tab'
    const stale = tabs.filter(t => {
      if (t.url === 'about:blank') return false; // already handled
      const staleTitle = !t.title || t.title === '新标签页' || t.title === 'New Tab';
      return staleTitle;
    });
    if (stale.length > 0) {
      dlog(`[TAB] closing ${stale.length} stale tab(s)`);
      for (const t of stale) {
        await closeTabById(t.id);
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (e) {
    dlog(`[TAB] cleanup error: ${e.message}`);
  }
}

function startTabCleanup() {
  if (tabCleanupTimer) clearInterval(tabCleanupTimer);
  tabCleanupTimer = setInterval(() => {
    cleanupBlankTabs().catch(() => {});
  }, 5 * 60 * 1000); // every 5 minutes
}

async function attachToTab(urlMatch) {
  return new Promise((resolve) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const pages = JSON.parse(d);
          // Find tab matching URL
          const target = pages.find(p => p.type === 'page' && (urlMatch ? p.url.includes(urlMatch) : (p.url !== 'about:blank'))) || pages.find(p => p.type === 'page');
          resolve(target?.webSocketDebuggerUrl || null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.cbs = new Map(); this.ws.onmessage = e => this._onMsg(e.data); }
  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.cbs.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.cbs.set(id, { resolve, reject, timer: t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  _onMsg(data) {
    try {
      const m = JSON.parse(data);
      if (m.id && this.cbs.has(m.id)) {
        const { resolve, reject, timer } = this.cbs.get(m.id);
        clearTimeout(timer); this.cbs.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    } catch {}
  }
}

// P1: Tab management - close excess tabs, keep newest
async function trimTabs() {
  const MAX_TABS = 6;
  try {
    const tabs = await listAllTabs();
    if (tabs.length <= MAX_TABS) return;
    // Sort by id (older tabs have smaller ids), keep newest MAX_TABS
    tabs.sort((a, b) => a.id.localeCompare(b.id));
    const toClose = tabs.slice(0, tabs.length - MAX_TABS);
    dlog(`[TAB] closing ${toClose.length} old tab(s), keeping ${MAX_TABS}`);
    for (const t of toClose) {
      await closeTabById(t.id);
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (e) { dlog(`[TAB] trim error: ${e.message}`); }
}

async function connect() {
  // P1: Trim excess tabs before acquiring new connection
  await trimTabs();

  // 优先复用已有非空白标签，避免每次创建 about:blank 新标签
  const existingWsUrl = await getWsUrl();
  if (existingWsUrl) {
    dlog(`[BROWSER] reusing existing tab`);
    // 健康检查：先验证标签可用，不可用则创建新标签
    try {
      const cdp = await connect_to(existingWsUrl);
      const hr = await Promise.race([
        cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('health_timeout')), 3000))
      ]);
      if (hr?.result?.value) { dlog('[BROWSER] tab health OK'); return cdp; }
      dlog('[BROWSER] tab health failed, creating new tab');
    } catch(e) {
      dlog(`[BROWSER] tab reuse failed (${e.message}), creating new tab`);
    }
  }
  // 创建新标签（带重试）
  return createNewTarget(3);
}

async function createNewTarget(retries = 1) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const newTarget = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: CDP_PORT,
          path: '/json/new?about:blank',
          method: 'PUT'
        }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); }
            catch { reject(new Error(`Failed to parse /json/new response: ${d.slice(0, 200)}`)); }
          });
        });
        req.on('error', (e) => reject(new Error(`Failed to create new target: ${e.message}`)));
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('/json/new timeout')); });
        req.end();
      });
      if (!newTarget?.webSocketDebuggerUrl) throw new Error('no wsUrl in /json/new');
      dlog(`[BROWSER] new target created: ${newTarget.id}`);
      const cdp = await connect_to(newTarget.webSocketDebuggerUrl);
      try { await navigate(cdp, 'https://www.baidu.com'); await waitForLoad(cdp, 4000); } catch {}
      return cdp;
    } catch(e) {
      if (attempt < retries - 1) {
        dlog(`[BROWSER] /json/new attempt ${attempt+1}/${retries} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
}

async function connect_to(wsUrl) {
  if (!wsUrl) throw new Error('Edge CDP not available. Start Edge with --remote-debugging-port=9222');
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    const t = setTimeout(() => j(new Error('WebSocket open timeout')), 10000);
    ws.onopen = () => { clearTimeout(t); r(); };
    ws.onerror = (e) => { clearTimeout(t); j(new Error('WebSocket error')); };
  });
  const cdp = new CDP(ws);
  try { await cdp.send('Page.enable'); } catch (e) { dlog(`[BROWSER] Page.enable error: ${e.message}`); }
  try { await cdp.send('Runtime.enable'); } catch (e) { dlog(`[BROWSER] Runtime.enable error: ${e.message}`); }
  ws.onclose = () => { cdp.closed = true; };
  // 反检测：清除自动化标志
  try {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        window.chrome = { runtime: {} };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
      })()`,
      returnByValue: true
    });
  } catch {}
  return cdp;
}

async function doEval(cdp, expr) {
  try { return await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }); }
  catch {
    try { await cdp.send('Runtime.enable'); } catch {}
    return await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  }
}

async function navigate(cdp, url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await cdp.send('Page.navigate', { url });
      try { await cdp.send('Page.bringToFront'); } catch {}
      return; // Success
    } catch (e) {
      if (attempt < retries) {
        dlog(`[BROWSER] navigate retry ${attempt + 1}/${retries}: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
      } else {
        throw e; // Last attempt failed
      }
    }
  }
}

// Close a CDP session and its WebSocket properly
async function closeCDP(cdp) {
  if (!cdp || cdp.closed) return;
  try {
    cdp.send('Page.disable').catch(() => {});
    cdp.send('Runtime.disable').catch(() => {});
  } catch {}
  try { cdp.ws.close(); } catch {}
  cdp.closed = true;
}

async function waitForLoad(cdp, maxMs = 6000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await Promise.race([
        cdp.send('Runtime.evaluate', { expression: 'document.readyState' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('eval_timeout')), 3000))
      ]);
      if (r.result?.value === 'complete') return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
}

async function snapshot(cdp) {
  const r = await doEval(cdp, `(() => {
    const els = document.querySelectorAll('a,button,input,select,textarea,[onclick],[role=button]');
    const items = [];
    els.forEach((el,i) => {
      const text = (el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||'').trim().slice(0,50);
      const id = el.id||'', href = el.href||'';
      if (text||id) items.push('['+i+'] '+(id?'#'+id+' ':'')+text+(href?' '+href:''));
    });
    return {title:document.title,url:location.href,els:items.slice(0,30),text:document.body?.innerText?.slice(0,1500)||''};
  })()`);
  return r.result?.value || {};
}

async function clickByRole(cdp, text, role) {
  dlog(`[CLICK] start: text="${text}" role="${role}"`);
  try { await cdp.send('Page.bringToFront'); } catch {}
  // Find element + its href
  const e = (text || '').replace(/"/g, '\\"');
  const r = await doEval(cdp, `(function(){
    var t="${e}";
    var el = [...document.querySelectorAll('a,button,span,[onclick]')].find(e => (e.innerText||e.value||'').trim() === t);
    if (!el) el = [...document.querySelectorAll('a,button,span,[onclick]')].find(e => (e.innerText||e.value||'').includes(t));
    if (!el) return null;
    var href = el.href || '';
    var r2 = el.getBoundingClientRect();
    return {href, text: (el.innerText||el.value||'').trim().slice(0,30), tag: el.tagName};
  })()`);
  const target = r.result?.value;
  dlog(`[CLICK] target: ${JSON.stringify(target)}`);
  if (!target) return 'not found: ' + text;
  // If it's a link with a valid href, navigate directly (most reliable)
  dlog(`[CLICK] is link check: tag=${target.tag} href=${target.href?.slice(0,50)}`);
  if (target.tag === 'A' && target.href && target.href.startsWith('http')) {
    dlog(`[CLICK] navigate to: ${target.href}`);
    await cdp.send('Page.navigate', { url: target.href });
    return 'navigated to: ' + target.href;
  }
  // Fallback to mouse click
  try {
    const rect = await doEval(cdp, `(()=>{var t="${e}";var el=[...document.querySelectorAll('button,span,[onclick]')].find(e=>(e.innerText||e.value||'').includes(t));if(!el)return null;var r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (rect.result?.value) {
      const {x, y} = rect.result.value;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 30));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return 'mouse clicked: ' + target.text;
    }
  } catch {}
  return 'clicked (no nav): ' + target.text;
}

async function typeText(cdp, selectorOrPlaceholder, text) {
  const s = (selectorOrPlaceholder||'').replace(/"/g, '\\"'), t = (text||'').replace(/"/g, '\\"');
  const r = await doEval(cdp, `(function(){
    const s="${s}",t="${t}";
    let el=document.querySelector(s)||[...document.querySelectorAll('input,textarea,[contenteditable=true]')].find(e=>e.placeholder?.includes(s)||e.name?.includes(s)||e.id?.includes(s));
    if(el){el.focus();el.value=t;el.dispatchEvent(new Event('input',{bubbles:true}));return'typed';}
    return'not found';
  })()`);
  return r.result?.value || 'no result';
}


// ===== Target pool: prevent Edge instances from leaking =====
// Maintains a pool of reusable CDP sessions with automatic cleanup
const targetPool = {
  maxIdle: 3,  // Max idle sessions to keep
  sessions: [], // {cdp, createdAt, url}
  activeSession: null,

  async acquire() {
    // Try to reuse an existing session
    const now = Date.now();
    const MAX_AGE = 10 * 60 * 1000; // 10 min max per session
    const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 min idle timeout

    // Clean up old sessions first
    this.sessions = this.sessions.filter(s => {
      if (s.closed || (now - s.createdAt) > MAX_AGE) {
        closeCDP(s.cdp).catch(() => {});
        return false;
      }
      return true;
    });

    // Reuse oldest idle session
    if (this.sessions.length > 0) {
      const s = this.sessions.shift();
      if (!s.cdp.closed) {
        this.activeSession = s;
        return s.cdp;
      }
    }

    // Create fresh session
    const cdp = await connect();
    this.activeSession = { cdp, createdAt: Date.now(), url: null };
    return cdp;
  },

  release(cdp) {
    if (!cdp || cdp.closed) return;
    const existing = this.sessions.find(s => s.cdp === cdp);
    if (existing) {
      existing.createdAt = Date.now(); // Reset age
    } else if (this.sessions.length < this.maxIdle) {
      this.sessions.push({ cdp, createdAt: Date.now(), url: null });
    } else {
      // Pool full, close it
      closeCDP(cdp).catch(() => {});
    }
    if (this.activeSession?.cdp === cdp) this.activeSession = null;
  },

  async closeAll() {
    for (const s of this.sessions) {
      closeCDP(s.cdp).catch(() => {});
    }
    this.sessions = [];
    if (this.activeSession) {
      closeCDP(this.activeSession.cdp).catch(() => {});
      this.activeSession = null;
    }
  }
};

module.exports = {
  launchEdge, connect, connect_to, navigate, waitForLoad, snapshot, clickByRole, typeText, doEval,
  attachToTab, CDP_PORT, closeCDP, targetPool,
  // Self-healing & tab management exports
  isEdgeHealthy, stopWatchdog, cleanupBlankTabs, listAllTabs, closeTabById, trimTabs
};
