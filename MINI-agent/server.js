// Clean refactor: integrate RuleEngine properly
// Writes a completely new, clean version of server.js

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const browser = require('./browser.js');
const { exec } = require('child_process');

// ===== 处理锁: 防止并发竞态 =====
let isProcessing = false;
let pendingInput = null;
const inputQueue = [];

// ===== CDP idle auto-disconnect (P0) =====
const CDP_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
let lastCdpActiveTime = Date.now();
let cdpIdleTimer = null;

function updateCdpActivity() {
  lastCdpActiveTime = Date.now();
}

function startCdpIdleMonitor() {
  if (cdpIdleTimer) clearInterval(cdpIdleTimer);
  cdpIdleTimer = setInterval(() => {
    const idle = Date.now() - lastCdpActiveTime;
    if (browserCdp && !browserCdp.closed && idle > CDP_IDLE_TIMEOUT) {
      dlog(`[CDP] idle ${Math.round(idle/60000)}min > ${CDP_IDLE_TIMEOUT/60000}min, auto-disconnecting...`);
      try { browser.closeCDP(browserCdp); } catch {}
      browserCdp = null;
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

const DATA_DIR = path.join(__dirname, 'data');
const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const COMPRESS_DIR = path.join(DATA_DIR, 'compress');
const SEARCH_CACHE_DIR = path.join(DATA_DIR, 'search_cache');
const LOG_PATH = path.join(__dirname, 'debug.log');
const MAX_VISIBLE_MSGS = 30;
const MAX_STORE_MSGS = 200;
const MAX_LEARNED_PATTERNS = 500;

[DATA_DIR, COMPRESS_DIR, SEARCH_CACHE_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ===== 异步日志缓冲区 =====
const LOG_BUFFER = [];
let logFlushTimer = null;
const LOG_FLUSH_INTERVAL = 5000; // 5秒刷盘一次
const LOG_MAX_BUFFER = 100;     // 超过100条立即刷盘

async function flushLog() {
  if (LOG_BUFFER.length === 0) return;
  const lines = LOG_BUFFER.splice(0, LOG_BUFFER.length);
  const content = lines.join('\n') + '\n';
  try { await fsp.appendFile(LOG_PATH, content, 'utf8'); } catch {}
}

function dlog(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length >= LOG_MAX_BUFFER) {
    flushLog();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => { flushLog(); logFlushTimer = null; }, LOG_FLUSH_INTERVAL);
  }
}

// ── RuleEngine: 仅记录实体→URL映射，不存自然语言句子 ──
const SITE_LEARN_FILE = path.join(DATA_DIR, 'site_learn.json');
let siteLearn = {}; // { "百度": "www.baidu.com", "苹果": "apple.com" }

async function loadSiteLearn() {
  try { siteLearn = JSON.parse(await fsp.readFile(SITE_LEARN_FILE, 'utf8')); } catch { siteLearn = {}; }
}
async function saveSiteLearn() {
  try { await fsp.writeFile(SITE_LEARN_FILE, JSON.stringify(siteLearn, null, 2), 'utf8'); } catch {}
}
// 从用户输入学习站点: "苹果" -> 从normalizeUrl解析得到的域名
function learnSite(entity, url) {
  if (!entity || !url) return;
  // 提取域名
  const match = url.match(/https?:\/\/([^/]+)/);
  if (!match) return;
  const domain = match[1];
  // 过滤: 必须是有效域名，排除搜索引擎结果页
  if (domain.includes('baidu.com/s') || domain.includes('google.com/search')) return;
  // 记录映射
  const key = entity.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 20);
  if (key.length < 2) return;
  siteLearn[key] = domain;
  dlog(`[LEARN] 站点: ${key} -> ${domain}`);
  saveSiteLearn();
}
function resolveSite(name) {
  if (!name) return null;
  const key = name.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
  return siteLearn[key] || null;
}

class RuleEngine {
  constructor(p) { this._p = p; this._s = []; this._l = new Map(); this._st = new Map(); this._load(); }
  addStatic(pat, tools, pri = 50, gen) { this._s.push({ pat, tools, pri, gen }); this._s.sort((a,b) => b.pri - a.pri); }
  match(t) {
    for (const [p,r] of this._l) if (this._test(p,t)) { this._hit(p); return r; }
    for (const r of this._s) if (this._test(r.pat,t)) {
      this._hit(r.pat);
      const res = { tools: r.tools, feedback: r.fb !== undefined ? r.fb : false };
      if (r.gen) { const i = r.gen(t); if (i) res._instructions = i; }
      return res;
    }
    return null;
  }
  // 废弃自然语言学习，仅保留站点学习接口
  learn(inp, tools) {
    // 不再将自然语言存为规则，仅保留 learnSite() 接口
    dlog(`[RULE] 忽略自然语言学习: ${inp.slice(0, 30)}... (仅支持站点映射)`);
  }
  _test(pat, t) {
    t = t.trim();
    // 函数模式: 调用函数获取布尔值
    if (typeof pat === 'function') {
      try { return pat(t); } catch { return false; }
    }
    // 正则模式: 用 .test()
    if (pat instanceof RegExp) {
      const r = new RegExp(pat.source, pat.flags);
      if (r.test(t)) return true;
      // 动作词归一化后重试
      const n = t.replace(/打开|开启|访问|导航到|去/g, '开').replace(/点击|点|按下|选择|进入/g, '点');
      const r2 = new RegExp(pat.source.replace(/打开|开启|访问|导航到|去/g, '开').replace(/点击|点|按下|选择|进入/g, '点'), pat.flags);
      return r2.test(n);
    }
    // 字符串模式: 包含匹配 + 长度比防过拟合（长模式不能吞短输入）
    const p = pat.toLowerCase();
    const n = t.toLowerCase().replace(/打开|开启|访问|导航到|去/g, '开').replace(/点击|点|按下|选择|进入/g, '点');
    const np = p.replace(/打开|开启|访问|导航到|去/g, '开').replace(/点击|点|按下|选择|进入/g, '点');
    // np.includes(n) 是长模式吸收短输入 → 只允许 n.includes(np)（精确包含）
    if (n.includes(np)) return true;
    // np.includes(n) 仅在长度差 ≤ 3 时允许（几乎等长的变体匹配）
    if (Math.abs(np.length - n.length) <= 3 && np.includes(n)) return true;
    return false;
  }
  _hit(p) { this._st.set(p,(this._st.get(p)||0)+1); }
  async _load() { try { const d=JSON.parse(await fsp.readFile(this._p,'utf8')); if(d.learned) for(const [k,v] of Object.entries(d.learned)) this._l.set(k,v); if(d.stats) for(const [k,v] of Object.entries(d.stats)) this._st.set(k,v); } catch {} }
  async _save() { try { await fsp.writeFile(this._p,JSON.stringify({learned:Object.fromEntries(this._l),stats:Object.fromEntries(this._st)}),'utf8'); } catch {} }
}

const RULE_ENGINE = new RuleEngine(RULES_PATH);
loadSiteLearn(); // 加载站点学习

// Static rules
const dm={'桌面':'Desktop','下载':'Downloads','文档':'Documents','图片':'Pictures'};
RULE_ENGINE.addStatic(/打开\s*[\u4e00-\u9fa5]+\s*[,，]*(?:然后|再|接着|之后)?\s*点击/,['NAVIGATE','CLICK'],100,(t)=>{const m=t.match(/打开\s*"?([^"",，,。]+)"?\s*(?:然后|再|接着|，)?\s*点击\s*"?([^"",，,。]+)"?/);if(m)return[`NAVIGATE url=${resolveSite(m[1].trim())||normalizeUrl(m[1].trim())}`,`CLICK text=${m[2].trim()}`];return null;});
RULE_ENGINE.addStatic(/^打开.+(?:然后|再|接着|之后).*点/,['NAVIGATE','CLICK'],100,(t)=>{const m=t.match(/打开\s*"?([^"",，,。]+)"?\s*(?:然后|再|接着|，)?\s*点击\s*"?([^"",，,。]+)"?/);if(m)return[`NAVIGATE url=${resolveSite(m[1].trim())||normalizeUrl(m[1].trim())}`,`CLICK text=${m[2].trim()}`];return null;});
RULE_ENGINE.addStatic(/(?:搜索|搜一下?|查一下?|查找)\s*/,['NAVIGATE','SEARCH'],90,(t)=>{const m=t.match(/(?:搜索|搜一下?|查一下?|查找)\s*"?([^"",，,。]+)"?/);const q=m?m[1].trim():t.replace(/(?:搜索|搜一下?|查一下?|查找)/,'').trim();return[`NAVIGATE url=https://www.baidu.com`,`SEARCH input=搜索框 query=${q}`];});
Object.entries(dm).forEach(([cn,en])=>{RULE_ENGINE.addStatic(new RegExp(`^打开${cn}$|^打开${cn}文件夹$`),['FILE'],80,()=>[`FILE action=open path=${en}`]);});
['QQ','微信','抖音','企业微信'].forEach(a=>{RULE_ENGINE.addStatic(new RegExp(`^打开${a}$`),['APP'],80,()=>[`APP app_name=${a}`]);});
RULE_ENGINE.addStatic(/^打开\s*([A-Z])盘$/,['FILE'],70,(t)=>{const m=t.match(/^打开\s*([A-Z])盘$/);return m?[`FILE action=open path=${m[1]}:\\`]:null;});
RULE_ENGINE.addStatic(/[A-Z]:[/\\]/,['FILE'],70,(t)=>{const m=t.match(/([A-Z]:[/\\][^\s，,。]*(?:\s+[^\s，,。]+)*)/);return m?[`FILE action=open path=${m[1].trim()}`]:null;});
RULE_ENGINE.addStatic(/[A-Z]\s*盘[的里上下]/,['FILE'],70,(t)=>{const m=t.match(/([A-Z])\s*盘[的里上下]?\s*([^\s，,。]+(?:\s+[^\s，,。]+)*)/);return m?[`FILE action=open path=${m[1]}:\\${m[2].trim()}`]:null;});
RULE_ENGINE.addStatic(/(?:把|将).+?(?:存[到入]|写入|保存[到入]|追加[到入]|存[到入])/,['FILE'],85,(t)=>{const ia=/追加[到入]/.test(t);return[`FILE action=${ia?'append':'save'}`];});
RULE_ENGINE.addStatic(/(?:搜索|搜[一-龥]?下?|查[一-龥]?下?|找[一-龥]?下?).*(?:出[0-9\u4e00-\u9fa5]?[道个]?题|写[一-龥]?封|写[一-龥]?篇|总结|翻译|介绍|梳理|归纳|列举)/,['CHAT'],95);
RULE_ENGINE.addStatic(/^点击\s*/,['CLICK'],75,(t)=>{const m=t.match(/^点击\s*"?([^"",，,。]+)"?/);const x=m?m[1].trim():t.replace(/^点击\s*/,'').trim();return x?[`CLICK text=${x}`]:null;});

// ── Site Map ──
const SITES = {'洛谷':'www.luogu.com.cn','luogu':'www.luogu.com.cn','力扣':'leetcode.cn','leetcode':'leetcode.cn','B站':'www.bilibili.com','bilibili':'www.bilibili.com','哔哩哔哩':'www.bilibili.com','百度':'www.baidu.com','baidu':'www.baidu.com','微博':'www.weibo.com','知乎':'www.zhihu.com','淘宝':'www.taobao.com','京东':'www.jd.com','掘金':'juejin.cn','CSDN':'www.csdn.net','豆瓣':'www.douban.com','小红书':'www.xiaohongshu.com','拼多多':'www.pinduoduo.com','飞书':'www.feishu.cn','贴吧':'tieba.baidu.com','QQ邮箱':'mail.qq.com','百度贴吧':'tieba.baidu.com'};
const SITE_LIST = Object.entries(SITES).filter(([k])=>/[\u4e00-\u9fff]/.test(k)).map(([k,v])=>`${k}=${v}`).join(',');

function normalizeUrl(name) {
  if(!name) return 'https://www.baidu.com';
  if(/^https?:\/\//i.test(name)) return name;
  const s=resolveSite(name)||SITES[name]||Object.entries(SITES).find(([k])=>k.toLowerCase()===name.toLowerCase())?.[1];
  return s?`https://${s}`:`https://www.baidu.com/s?wd=${encodeURIComponent(name)}`;
}

// ── Store: 对话历史分片 (按convId拆分) ──
const CONV_DIR = path.join(DATA_DIR, 'conversations');

async function initStore() {
  if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
}
initStore();

function getConvPath(convId) { return path.join(CONV_DIR, `${convId}.json`); }

async function loadConv(convId) {
  try { return JSON.parse(await fsp.readFile(getConvPath(convId), 'utf8')); } catch { return { id: convId, msgs: [], created: Date.now() }; }
}
async function saveConv(convId, data) {
  try { await fsp.writeFile(getConvPath(convId), JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// 兼容旧store.json迁移
function loadStore() {
  try {
    const old = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    // 迁移旧数据到分片文件
    if (old.messages) {
      for (const [cid, msgs] of Object.entries(old.messages)) {
        const conv = { id: cid, msgs: msgs, created: Date.now() };
        saveConv(cid, conv);
      }
    }
    // 删除旧文件
    try { fs.unlinkSync(STORE_PATH); } catch {}
    return { conversations: {}, messages: {} };
  } catch { return { conversations: {}, messages: {} }; }
}
function genId() { return crypto.randomUUID().slice(0,8); }
function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

// ── 智能内容压缩：去噪 + 去重 + 高价值行优先 ──
function compressContent(text, maxChars = 3000) {
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim());
  // 第一遍：质量过滤
  const clean = lines.filter(l => {
    const n = l.length;
    if (n < 8 || n > 300) return false;
    if ((new Set([...l])).size < Math.min(6, n * 0.3)) return false;
    const cjk = (l.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk >= 3 || (n < 20 && /[a-zA-Z]{2,}/.test(l));
  });
  // 第二遍：按信息密度排序（CJK字符占比越高越靠前）
  const scored = clean.map(l => {
    const cjk = (l.match(/[\u4e00-\u9fff]/g) || []).length;
    const score = cjk / Math.max(l.length, 1);
    return { line: l, score };
  }).sort((a, b) => b.score - a.score);
  // 第三遍：贪心收集到 maxChars
  let total = 0;
  const result = [];
  for (const item of scored) {
    if (total + item.line.length > maxChars) break;
    result.push(item.line);
    total += item.line.length + 1;
  }
  return result.join('\n');
}
async function loadJSON(p, def) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return def; } }
async function saveJSON(p, d) { try { await fsp.writeFile(p, JSON.stringify(d, null, 2), 'utf8'); } catch {} }
let store = { conversations: {}, messages: {} };

function getSearchCachePath(cid) { return path.join(SEARCH_CACHE_DIR,`${cid}.json`); }
async function loadSearchCache(cid) { return loadJSON(getSearchCachePath(cid),{entries:[]}); }
async function saveSearchCache(cid,data) { await saveJSON(getSearchCachePath(cid),data); }

// 修复缓存腐化: 使用更严格的匹配逻辑
// 1. 关键词必须完全匹配(而非包含)
// 2. 查询长度差异不能太大
// 3. 使用编辑距离防止"苹果手机"命中"苹果电脑"
function levenshtein(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length];
}

async function lookupSearchCache(cid, query, minMatch = 0.7) {  // 提高阈值到0.7
  if (!cid) return null;
  const c = await loadSearchCache(cid);
  const n = Date.now();
  // 清理过期
  c.entries = c.entries.filter(e => n - e.ts < 86400000);
  if (c.entries.length > 0) await saveSearchCache(cid, c);

  const qNorm = query.toLowerCase().replace(/\s+/g, '');
  let best = null, bestScore = 0;

  for (const e of c.entries) {
    const eqNorm = e.query.toLowerCase().replace(/\s+/g, '');
    // 完全匹配
    if (eqNorm === qNorm) return e;
    // 严格子串匹配: 查询A完全包含查询B 或 反之，且长度差<=3
    const lenDiff = Math.abs(eqNorm.length - qNorm.length);
    if ((qNorm.includes(eqNorm) || eqNorm.includes(qNorm)) && lenDiff <= 3) {
      return e; // 高置信度
    }
    // 编辑距离过滤: 差异超过30%视为不匹配
    const maxLen = Math.max(eqNorm.length, qNorm.length);
    const dist = levenshtein(eqNorm, qNorm);
    const similarity = 1 - dist / maxLen;
    if (similarity > bestScore && lenDiff <= 5) {
      bestScore = similarity;
      best = e;
    }
  }
  return bestScore >= minMatch ? best : null;
}

async function appendSearchCache(cid, query, result) {
  if (!cid) return;
  const c = await loadSearchCache(cid);
  c.entries.push({ query, ts: Date.now(), title: result.title || '', summary: result.summary || compressContent(result.text || '', 800), text: result.text || '' });
  if (c.entries.length > 20) c.entries = c.entries.slice(-20);
  await saveSearchCache(cid, c);
}

function getCompressPath(cid) { return path.join(COMPRESS_DIR,`${cid}.json`); }
async function compressConversation(conv, model) {
  if (!conv || !conv.msgs) return;
  const msgs = conv.msgs;
  const ac = msgs.filter(m => m.role === 'assistant').length;
  if (ac === 0 || ac % 5 !== 0) return;
  const comp = await loadJSON(getCompressPath(conv.id), { summaries: [] });
  if (comp.lastAssistantCount === ac) return;
  const win = msgs.slice(-12);
  const text = win.map(m => `${m.role}: ${compressContent(m.content, 300)}`).join('\n');
  const r = await ollamaOnce(model, [{ role: 'system', content: '用30-50字总结下面这段对话的意图和用户偏好。只输出总结。' }, { role: 'user', content: text }], { num_predict: 120, temperature: 0 });
  const s = (r.content || '').trim();
  if (!s) return;
  comp.summaries = comp.summaries || [];
  comp.summaries.push({ ts: now(), summary: s });
  comp.lastAssistantCount = ac;
  if (comp.summaries.length > 10) comp.summaries = comp.summaries.slice(-10);
  await saveJSON(getCompressPath(conv.id), comp);
}

async function getHistoryContext(convId) {
  if (!convId) return [];
  const conv = await loadConv(convId);
  if (!conv || !conv.msgs) return [];
  const msgs = conv.msgs;
  const recent = msgs.slice(-MAX_VISIBLE_MSGS);
  // 过滤掉工具调用和工具返回值，只保留用户问题和助手回答
  const filtered = recent.filter(m => m.role === 'user' || (m.role === 'assistant' && !m.content?.includes('>>>')));
  const ctx = filtered.map(m => ({ role: m.role, content: compressContent(m.content, 500) }));
  const comp = await loadJSON(getCompressPath(convId), { summaries: [] });
  if (comp.summaries && comp.summaries.length > 0) {
    const hist = comp.summaries.map(s => s.summary).join('; ');
    if (hist) ctx.unshift({ role: 'system', content: `对话历史摘要：${hist}` });
  }
  return ctx;
}

async function saveAssistant(convId, content) {
  if (!convId) return;
  const conv = await loadConv(convId);
  conv.msgs = conv.msgs || [];
  conv.msgs.push({ role: 'assistant', content, timestamp: Date.now() });
  if (conv.msgs.length > MAX_STORE_MSGS) conv.msgs = conv.msgs.slice(-MAX_STORE_MSGS);
  conv.name = conv.name || content.slice(0, 30);
  conv.timestamp = Date.now();
  await saveConv(convId, conv);
}

// ── Ollama ──
let localModels=[];
async function refreshModels() {
  try {
    const res=await fetch('http://127.0.0.1:11434/api/tags');
    const d=await res.json();
    localModels=(d.models||[]).map(m=>m.name);
  } catch { localModels=['qwen2.5:3b','gemma2:2b']; }
}
refreshModels();

async function ollamaOnce(model,messages,opts={}) {
  const {num_predict=2048,temperature=0.3}={...opts};
  if(model==='auto'||!model||model.includes('7b')) model='qwen2.5:3b';
  const ctrl=new AbortController(),to=setTimeout(()=>ctrl.abort(),60000);
  try {
    const body=JSON.stringify({model, messages, stream:false, options:{num_predict,temperature}});
    dlog(`[OLLAMA] model=${model} msgs=${messages.length}`);
    const res=await fetch('http://127.0.0.1:11434/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body,
      signal:ctrl.signal
    });
    clearTimeout(to);
    if(!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data=await res.json();
    return{content:data.message?.content||data.response||''};
  } catch(e) { clearTimeout(to); dlog(`[OLLAMA] err: ${e.message}`); throw e; }
}

function pickRouterModel(mainModel) {
  // 用主模型作为路由模型（避免小模型误判）
  // 如果主模型是 3b 以下用 gemma2:2b，否则直接用主模型
  const m=mainModel.match(/(\d+\.?\d*)b/i);
  const s=m?parseFloat(m[1]):3;
  if(s<=2) return 'gemma2:2b';
  return mainModel;
}

// ── Learned Sites (已迁移到顶部，使用 siteLearn) ──

// ── ROUTER ──
const ROUTER_PROMPT=`你是路由员。决定用哪些工具，输出格式：TOOL1|TOOL2@true_or_false
@true=需要把执行结果返回给用户；@false=纯操作（打开/删除）不返回。
工具：
- NAVIGATE：开网页（仅http/https网址）
- SEARCH  ：搜信息（要先打开搜索页，再点搜索框）
- CLICK   ：点网页元素
- APP     ：启动本地程序
- FILE    ：操作文件/文件夹（开D盘→ FILE action=open path=D:）
- CHAT    ：纯聊天/知识问答/生成内容
- SKILL   ：调用技能（skill_id=xxx action=xxx params=xxx）
强制规则：
- 只输出一行，前面不要"好的"、"下面是"、"示例："等任何中文
- 工具名只能是大写英文，不能是中文
- 有动作（打开/点击/搜/删/启动/运行）→ 对应工具，不能选CHAT
- 开网页/搜信息先NAVIGATE
格式严格：TOOL|TOOL2@true/false
示例：打开百度点地图 → NAVIGATE|CLICK@true；搜洛谷 → NAVIGATE|SEARCH@true；你好 → CHAT@true；打开QQ → APP@false；打开D盘 → FILE@false。`;

// ── 复杂度计算 ──
// 5维度打分：动作链密度、参数模糊度、领域专业度、句子长度、承接词
function calculateComplexity(userInput, tools, messages) {
  const text = userInput || '';
  let score = 0;

  // 1. 动作链密度 (0-20)：工具数量越多越复杂
  const toolCount = tools?.length || 0;
  if (toolCount >= 3) score += 20;
  else if (toolCount === 2) score += 12;
  else if (toolCount === 1) score += 5;

  // 2. 参数模糊度 (0-20)：缺少关键参数/泛指词
  const vagueWords = ['那个', '它', '这个', '刚才', '之前', '上次', '类似的', '随便', '都行', '帮我'];
  const hasVague = vagueWords.some(w => text.includes(w));
  const hasSpecific = /\d{4,}|\.com|\.cn|http|[\u4e00-\u9fa5]{2,4}(?:网|站|平台|app|软件)/.test(text);
  if (hasVague && !hasSpecific) score += 20;
  else if (hasVague) score += 10;

  // 3. 领域专业度 (0-20)：技术/法律/医疗等专业术语
  const techTerms = /代码|函数|算法|接口|配置|部署|调试|编译|安装|卸载|更新|版本|bug|报错|异常|崩溃|内存|cpu|gpu|服务器|域名|ssl|tls|加密|解密|压缩|解压/i.test(text);
  const lawTerms = /合同|协议|条款|法规|法律|诉讼|仲裁|维权|赔偿|侵权|专利|商标|版权|授权|许可/i.test(text);
  const financeTerms = /股票|基金|债券|期货|期权|理财|投资|收益|亏损|市值|估值|ipo|融资|并购|财报|营收|利润/i.test(text);
  if (techTerms || lawTerms || financeTerms) score += 20;
  else if (/[\u4e00-\u9fa5]{5,}/.test(text)) score += 5; // 长中文词

  // 4. 句子长度 (0-20)：越 长越复杂
  const len = text.length;
  if (len > 100) score += 20;
  else if (len > 50) score += 12;
  else if (len > 30) score += 6;

  // 5. 承接词 (0-20)：多步骤/条件/因果
  const chainWords = /然后|接着|再|然后再|之后|同时|并且|而且|但是|如果|那么|因为|所以|虽然|尽管|虽然说/i.test(text);
  const multiStep = /(?:第[一二三四五六七八九十]+|首先|其次|最后|第一步|第二步)/.test(text);
  if (chainWords && multiStep) score += 20;
  else if (chainWords) score += 12;
  else if (multiStep) score += 8;

  // 额外：上下文依赖 (messages中有历史)
  const hasHistory = messages?.length > 2;
  if (hasHistory) score += 10;

  // 额外：文件上下文
  const hasFileCtx = /文件|代码|内容|这个|那个|上面|下文/.test(text) && (messages?.some(m => m.role === 'system' && m.content?.includes('[文件:')));
  if (hasFileCtx) score += 10;

  dlog(`[COMPLEXITY] score=${score} tools=${toolCount} len=${len} history=${hasHistory}`);
  return Math.min(score, 100); // 上限100
}

// 判断是否需要用主模型（复杂度>50）
function needsMainModel(complexity) {
  return complexity > 50;
}

async function phase1_route(routerModel,userInput) {
  dlog(`[P1] raw input: "${userInput.slice(0,40)}" (len=${userInput.length})`);

  // Step 0: RuleEngine（所有硬编码pattern已迁移到这里）
  const er=RULE_ENGINE.match(userInput);
  if(er) {
    // 修正：learned pattern 可能过拟合——无动词问句不应走 NAVIGATE
    const noVerb=!/打开|启动|运行|点击|访问|去|进入/.test(userInput.toLowerCase());
    const looksQuestion=/(啥|什么|怎么|哪些|哪个|有没有|推荐|好看|好玩|热门|排行|有哪些)/.test(userInput);
    if(noVerb&&looksQuestion&&er.tools.includes('NAVIGATE')&&!er._instructions){
      dlog(`[P1] 🔧 无动词问句 → SEARCH+CHAT 替代 NAVIGATE`);
      return{tools:['SEARCH','CHAT'],feedback:true};
    }
    // 修正：learned pattern（无 _instructions）路由到工具无 CHAT → 强制 CHAT
    if(needsOnlineSearch(userInput)&&!er.tools.includes('CHAT')&&!er._instructions){
      dlog(`[P1] 🔧 learned→CHAT: "${userInput.slice(0,40)}" tools=${JSON.stringify(er.tools)}`);
      er.tools=['CHAT']; er.feedback=true;
    }
    dlog(`[P1] ✅ RULE_ENGINE: "${userInput.slice(0,60)}" → ${JSON.stringify(er.tools)}`);
    return er;
  }

  // Step 1: 快速预判——已知网站单步骤
  if(!/点击|然后|最后|再|接着|进入|打开.*后/.test(userInput)) {
    const fs=resolveSite(userInput.replace(/^打开\s*/,''));
    if(fs){dlog(`[P1] fast-site: "${userInput.slice(0,60)}" → NAVIGATE`);return{tools:['NAVIGATE'],feedback:false,_instructions:[`NAVIGATE url=${fs}`]};}
  }

  // Step 2: 未知"打开X"实体
  if(/^打开/.test(userInput)) {
    const cls=await modelClassifyOpen(userInput,routerModel);
    if(cls){dlog(`[P1] model-classify: "${userInput.slice(0,60)}" → ${JSON.stringify(cls)}`);return cls;}
  }

  // Step 3: 全路由
  const r=await ollamaOnce(routerModel,[{role:'system',content:ROUTER_PROMPT},{role:'user',content:userInput}],{num_predict:40,temperature:0});
  const raw=(r.content||'').trim();
  dlog(`[P1] router:${routerModel} input:"${userInput.slice(0,60)}" → raw:"${raw}"`);

  function parseRouterOutput(s) {
    if(!s) return null;
    const at=s.lastIndexOf('@');
    if(at<1) return null;
    const tools=s.slice(0,at).split('|').map(t=>t.trim()).filter(Boolean);
    const fb=s.slice(at+1).trim().toLowerCase()==='true';
    const KNOWN=new Set(['NAVIGATE','SEARCH','CLICK','APP','FILE','CHAT','SKILL']);
    return tools.length>0&&tools.every(t=>KNOWN.has(t))?{tools,feedback:fb}:null;
  }

  let parsed=parseRouterOutput(raw);
  if(!parsed) parsed=strictFallback(raw);
  dlog(`[P1] result: tools=${JSON.stringify(parsed?.tools)} feedback=${parsed?.feedback}`);

  const KNOWN=new Set(['NAVIGATE','SEARCH','CLICK','APP','FILE','CHAT','SKILL']);
  let safeTools=(parsed?.tools||[]).filter(t=>KNOWN.has(t));
  // Bug D: 升级 noCommand —— 拦截"在X上打开"等伪装命令
  const noCommand=!/^打开\s+\S|打开$|启动|运行|^点击\s|访问$|在.*上打开|切换[到至]|进入/.test(userInput.toLowerCase());
  const looksGen=/出[0-9一二三四五六七八九十百千万]?[道个]?题|写[一-龥]?封|写[一-龥]?篇|总结|翻译|介绍[一-龥]?下|梳理|归纳|啥|什么|怎么|哪些|哪个|有没有|推荐|好看|好玩|热门|排行|有哪些/.test(userInput);
  if(noCommand&&looksGen&&!safeTools.includes('CHAT')){safeTools=['CHAT'];parsed={tools:safeTools,feedback:true};}
  if(safeTools.length===0) safeTools.push('CHAT');
  return{tools:safeTools,feedback:parsed?.feedback||false};
}

function strictFallback(s) {
  const l=s.toLowerCase();
  if(/打开|开/.test(l)) return{tools:['NAVIGATE'],feedback:false};
  if(/搜|查|找/.test(l)) return{tools:['SEARCH'],feedback:true};
  if(/点|按|选/.test(l)) return{tools:['CLICK'],feedback:true};
  return{tools:['CHAT'],feedback:true};
}

async function modelClassifyOpen(text,routerModel) {
  if(!/^打开/.test(text)) return null;
  const target=text.replace(/^打开\s*/,'').trim();
  if(!target) return null;
  if(resolveSite(target)) return null;
  const r=await ollamaOnce(routerModel,[{role:'system',content:`用户要"打开X"。X是什么类型？只输出一个词：SITE / APP / SKIP。已知站点：${SITE_LIST}。已知应用：QQ、微信、抖音、企业微信。只输出一个词。`},{role:'user',content:target}],{num_predict:8,temperature:0});
  const cls=(r.content||'').trim().toUpperCase();
  dlog(`[P1] classify: "${target}" → ${cls}`);
  if(cls==='SITE'){const host=await searchAndLearnSite(target);return{tools:['NAVIGATE'],feedback:false,_instructions:[`NAVIGATE url=${host||`https://www.baidu.com/s?wd=${encodeURIComponent(target+'官网')}`}`]};}
  if(cls==='APP') return{tools:['APP'],feedback:false};
  return null;
}

function needsOnlineSearch(text) {
  const t=(text||'').trim().toLowerCase();
  if(t.length<3||t.length>200) return false;
  if(/世界杯|奥运会|nba|cba|股票|汇率|天气|新闻|头条|发布|财报|price|score|win/i.test(t)) return true;
  if(/猜测|预测|可能|会不会|可能考|可能出|啥|什么|好看|推荐|高质量|热门|排行|有哪些/.test(t)) return true;
  if(/今年|最新|现在|今天|最近|当前|刚刚|今日/i.test(t)&&/谁|哪些|怎么|什么|多少|怎么样/i.test(t)) return true;
  return false;
}

async function searchAndLearnSite(target) {
  try {
    const r=await fetch(`https://www.baidu.com/s?wd=${encodeURIComponent(target+'官网')}`);
    const html=await r.text();
    const m=html.match(/href="(https?:\/\/[^"]+)"[^>]*>(?:官方|首页|<[^>]*>)*/i);
    if(m) {
      const url=new URL(m[1]);
      const host=url.hostname.replace(/^www\./,'');
      learnSite(target,host);
      return `https://${host}`;
    }
  } catch {}
  return null;
}

// ── Skills ──
function loadSkills() {
  const f = path.join(DATA_DIR, 'skills.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {available:[],installed:[]}; }
}
async function saveSkills(s) { await fsp.writeFile(path.join(DATA_DIR, 'skills.json'), JSON.stringify(s, null, 2), 'utf8'); }

// ── Skills execution ──
const ID_MAP={1:'file-manager',2:'excel-master',3:'browser-cdp',4:'software-automation',5:'qq-email',6:'material-organizer',7:'pdf-reader',8:'github-assistant',9:'ai-code',10:'terminal-helper',11:'code-review',12:'project-scaffold'};

async function execSkill(params) {
  const{skill_id,action,params:sp}=params;
  const s=loadSkills();
  if(!s) return'Skills未加载';
  const actualId=ID_MAP[skill_id]||skill_id;
  const all=[...s.office,...s.coding];
  const skill=all.find(x=>x.id===actualId);
  if(!skill) return'未找到Skill: '+skill_id;
  dlog(`[execSkill] skill=${skill.id} action=${action} params=${JSON.stringify(sp||{})}`);
  switch(skill.id) {
    case'browser-cdp':
      if(action==='navigate') return await execNavigate({url:sp});
      if(action==='click') return await execClick({text:sp});
      return'browser-cdp不支持action: '+action;
    case'file-manager':
      if(action==='open') return await execFileOp({action:'open',path:sp});
      return'file-manager不支持action: '+action;
    case'qq-email': return'请在浏览器中登录QQ邮箱';
    default: return skill.name+' (action='+action+') — 暂未实现';
  }
}

// ── Phase 2 ──
async function phase2_instructions(mainModel,userInput,tools,messages,{single=false}={}) {
  const toolList=tools.join('→');
  const prompt=single
    ?`用户要求：${userInput}\n可用工具链：${toolList}。输出一条操作指令，示例：NAVIGATE url=https://www.baidu.com。只输出指令，不要写TOOL前缀，不要解释。`
    :`用户要求：${userInput}\n可用工具链：${toolList}。输出操作指令序列，每行一条，示例：NAVIGATE url=https://www.baidu.com。只输出指令，不要写TOOL前缀，不要解释。`;
  const r=await ollamaOnce(mainModel,[{role:'system',content:prompt},{role:'user',content:userInput}],{num_predict:400,temperature:0});
  const raw=(r.content||'').trim();
  const targets=raw.split('\n').map(l=>l.trim()).filter(Boolean);
  dlog(`[P2] targets:${JSON.stringify(targets)}`);
  // 调试：解析每个指令
  for(const t of targets){
    const inst=parseInstruction(t);
    dlog(`[P2] parsed: ${JSON.stringify(inst)}`);
  }
  return targets;
}

// ── Phase 3 ──
async function ensureCdp() {
  // Start idle monitor on first call
  if (!cdpIdleTimer) startCdpIdleMonitor();
  // P1: Trim excess tabs before acquiring new connection
  await browser.trimTabs().catch(() => {});
  // 复用已有连接
  if(browserCdp&&!browserCdp.closed) { updateCdpActivity(); return; }
  // 关闭旧连接，防止 about:blank 标签堆积
  if(browserCdp) try{browser.closeCDP(browserCdp);}catch{}
  browserCdp=null;
  try {
    dlog('[CDP] connecting...');
    browserCdp=await browser.targetPool.acquire();
    dlog('[CDP] connected');
    updateCdpActivity();
  } catch(e) {
    dlog(`[CDP] connect failed: ${e.message}, launching Edge...`);
    try {
      await browser.launchEdge();
      browserCdp=await browser.targetPool.acquire();
      dlog('[CDP] connected after launch');
      updateCdpActivity();
    } catch(e2){
      dlog(`[CDP] failed: ${e2.message}`);
      throw new Error(`CDP连接失败: ${e2.message}`);
    }
  }
  if(!browserCdp) throw new Error('CDP未初始化');
}
let browserCdp=null;

async function execFileOp(params) {
  const{action,path:fp,content}=params;
  const home=process.env.USERPROFILE||'C:\\\\Users\\\\'+process.env.USERNAME;
  if(!fp) return'缺少文件路径';
  let fpath=fp;
  if(fp==='Desktop') fpath=path.join(home,'Desktop');
  else if(fp==='Downloads') fpath=path.join(home,'Downloads');
  else if(fp==='Documents') fpath=path.join(home,'Documents');
  try{
    switch(action){
      case'open':
        exec(`start "" "${fpath}"`);
        return`已打开: ${fp}`;
      case'list':
        if(fs.existsSync(fpath)){const files=fs.readdirSync(fpath);return'文件列表:\\n'+files.slice(0,20).join('\\n');}
        return'目录不存在: '+fp;
      case'write':
      case'save':
        fs.writeFileSync(fpath,content||'','utf8');
        return`已保存: ${fp}`;
      case'append':
        fs.appendFileSync(fpath,content||'','utf8');
        return`已追加: ${fp}`;
      default:
        return`FILE ${action}: ${fp}`;
    }
  }catch(e){return`FILE失败: ${e.message}`;}
}

async function execNavigate(params) {
  try {
    await ensureCdp();
    let url=params.url||(typeof params==='string'?normalizeUrl(params):'https://www.baidu.com');
    if(!/^https?:\/\//i.test(url)) url='https://'+url;
    dlog(`[NAVIGATE] url=${url}`);
    await browser.navigate(browserCdp,url);
    await browser.waitForLoad(browserCdp,12000);
    // 尝试获取快照，失败时降级为仅标题
    let snap={title:'',text:'',els:[]};
    try {
      snap=await browser.snapshot(browserCdp);
    } catch(e) {
      dlog(`[NAVIGATE] snapshot 超时，降级读取标题`);
      try {
        const t=await browser.doEval(browserCdp,'document.title');
        snap.title=(t?.value||t?.result?.value||'')+'';
      } catch {}
    }
    const isStale=/^(about:blank|新标签页|New Tab|360|hao\.|导航已取消|about:newtab)$/i;
    if(!snap.title||isStale.test(snap.title)){
      dlog(`[NAVIGATE] ⚠ page stuck on "${snap.title}", re-navigating...`);
      await browser.navigate(browserCdp,url);
      await browser.waitForLoad(browserCdp,12000);
      const snap2=await browser.snapshot(browserCdp);
      if(snap2.title&&snap2.title!=='about:blank') snap=snap2;
    }
    // 移除webdriver标记
    try { await browser.doEval(browserCdp,'Object.defineProperty(navigator,"webdriver",{get:()=>undefined})'); } catch {}
    const content = compressContent(snap.text, 3000) || snap.title || '无内容';
    return `页面: ${url}\n标题: ${snap.title}\n\n${content}`;
  }catch(e){return`NAVIGATE失败: ${e.message}`;}
}

async function execSearch(params) {
  // 防爬优化：预热 + 随机延迟 + 安全验证检测
  try {
    const{input,query,q,originalQuery}=typeof params==='object'?params:{};
    // 回退：如果 query 是明显错误的占位符（如"用户要求"），使用 originalQuery 或忽略
    let raw=query||q||input||'';
    // 检测占位符错误：只有1-4个字符，或明显不是用户问题
    if(raw && (raw.length<4 || /^(用户要求|请|帮我|查询|搜索)$/.test(raw)) && originalQuery){
      dlog('[SEARCH] 检测到占位符参数，使用 originalQuery');
      raw=originalQuery;
    }
    // 智能解码：只有检测到 URL 编码格式（%XX）才解码，避免乱码
    let rawQuery=raw;
    if(/%[0-9A-Fa-f]{2}/.test(raw)){
      try{rawQuery=decodeURIComponent(raw);}catch{rawQuery=raw;}
    }
    if(!rawQuery) return'SEARCH失败: 无搜索词';
    const url=`https://www.baidu.com/s?wd=${encodeURIComponent(rawQuery)}&tn=baidu`;
    await ensureCdp();

    // 防爬优化1：先访问百度首页预热，建立正常访问轨迹
    const currentUrl=await browser.doEval(browserCdp,'location.href');
    if(!currentUrl.result?.value?.includes('baidu.com')){
      await browser.navigate(browserCdp,'https://www.baidu.com');
      await browser.waitForLoad(browserCdp,4000);
    }

    // 防爬优化2：随机延迟（1-2秒），模拟人类操作节奏
    const randomDelay=1000+Math.random()*1000;
    await new Promise(r=>setTimeout(r,randomDelay));

    await browser.navigate(browserCdp,url);
    await browser.waitForLoad(browserCdp,8000);

    // 防爬优化3：检测安全验证页并自动 fallback 到必应中国
    let finalSnap=await browser.snapshot(browserCdp);
    const title=finalSnap.title||'';
    const text=finalSnap.text||'';
    if(title.includes('安全验证')||title.includes('验证码')||title.includes('verify')||text.includes('安全验证')||text.includes('验证码')){
      dlog('[SEARCH] 百度触发安全验证，fallback 到必应中国...');
      const bingUrl=`https://cn.bing.com/search?q=${encodeURIComponent(rawQuery)}`;
      await browser.navigate(browserCdp,bingUrl);
      await browser.waitForLoad(browserCdp,8000);
      finalSnap=await browser.snapshot(browserCdp);
    }
    // 通用内容清洗：基于行质量过滤噪音（导航、广告、编码乱码等）
    const content = compressContent(finalSnap.text, 3000) || finalSnap.title || '无内容';
    return`已搜索: ${rawQuery}\n\n${content}`;
  }catch(e){return`SEARCH失败: ${e.message}`;}
}

async function execClick(params) {
  try {
    await ensureCdp();
    await browser.waitForLoad(browserCdp,5000);
    const text=params?.text||params?.selector||(typeof params==='string'?params:'');
    dlog(`[CLICK] text="${text}"`);
    const result=await browser.clickByRole(browserCdp,text,'');
    await browser.waitForLoad(browserCdp,3000);
    const snap=await browser.snapshot(browserCdp);
    return`${result}\\n当前页面: ${snap.title}\\n元素: ${(snap.els||[]).slice(0,8).join(' | ')}`;
  }catch(e){return`CLICK失败: ${e.message}`;}
}

async function execApp(params) {
  const name=params.app_name||params;
  exec(`start "" "${name}"`);
  return`已启动: ${name}`;
}

async function executeInstruction(inst,userContent,tools) {
  if(!inst) return'';
  try {
    const result=await (async()=>{
      switch(inst.action){
        case'NAVIGATE':return await execNavigate(inst.params);
        case'SEARCH':return await execSearch(inst.params);
        case'CLICK':return await execClick(inst.params);
        case'APP':return await execApp(inst.params);
        case'FILE':return await execFileOp(inst.params);
        case'SKILL':return await execSkill(inst.params);
        default:return`未知指令: ${inst.action}`;
      }
    })();
    // 从成功执行中学习
    if(result&&!result.includes('失败')&&!result.includes('错误')&&!result.includes('未找到')){
      try{RULE_ENGINE.learn(userContent,tools);}catch{}
    }
    return result;
  }catch(e){return`执行失败: ${e.message}`;}
}

function parseInstruction(line) {
  if(!line) return null;
  // Bug A: strip "TOOL" prefix that 3B models mistakenly output from prompt
  let clean=line.replace(/^TOOL\s+/i,'').trim();
  if(!clean) return null;
  const parts=clean.split(/\s+/);
  const KNOWN=new Set(['NAVIGATE','SEARCH','CLICK','APP','FILE','CHAT','SKILL']);
  let action=parts[0];
  let params={};
  // 严格解析：action 必须是 KNOWN 集合
  if(KNOWN.has(action)){
    for(const p of parts.slice(1)){
      const eq=p.indexOf('=');
      if(eq>0){ const k=p.slice(0,eq),v=p.slice(eq+1); params[k]=v; }
      else if(eq===0){ params[p.slice(1)]=true; }
    }
    return{action,params};
  }
  // Bug B: 宽松解析 —— 匹配 "ACTION k1=v1 k2=v2" 格式
  const m=clean.match(/^(\w+)\s+(.+)$/);
  if(m){
    action=m[1];
    if(KNOWN.has(action)){
      const rest=m[2];
      const kvRe=/(\S+?)=(\S+)/g;
      let kv;
      while((kv=kvRe.exec(rest))!==null) params[kv[1]]=kv[2];
      return{action,params};
    }
  }
  return null;
}

// ── Pipeline ──
async function runPipeline({mainModel,routerModel,userContent,fileContext,messages,convId}) {
  // 计算复杂度，选择模型
  const complexity = calculateComplexity(userContent, [], messages);
  const effectiveMainModel = needsMainModel(complexity) ? mainModel : routerModel; // 简单任务用小模型
  dlog(`[MODEL] complexity=${complexity} → ${needsMainModel(complexity) ? mainModel : routerModel}`);

  // 文件上下文压缩：使用 headroom 算法单独压缩
  let compressedFileCtx = '';
  if (fileContext) {
    // 提取文件内容部分 [文件: xxx] ... 内容
    const fileMatch = fileContext.match(/\[文件: ([^\]]+)\]\n([\s\S]*?)$/);
    if (fileMatch) {
      const fileName = fileMatch[1];
      const fileContent = fileMatch[2];
      compressedFileCtx = `[文件: ${fileName}]\n${compressContent(fileContent, 800)}`;
      dlog(`[FILE] compressed ${fileContent.length} → ${compressedFileCtx.length} chars`);
    } else {
      compressedFileCtx = compressContent(fileContext, 800);
    }
  }

  const route=await phase1_route(routerModel,userContent);
  if(!route) return'无法理解请求';
  const{tools,feedback,_instructions}=route;
  // 通用：needsOnlineSearch 时强制 SEARCH+CHAT（路由模型可能误判为纯 CHAT）
  if(needsOnlineSearch(userContent)){
    if(!tools.includes('SEARCH')){tools.push('SEARCH');dlog('[P1] 🔧 +SEARCH: needsOnlineSearch');}
    if(!tools.includes('CHAT')){tools.push('CHAT');dlog('[P1] 🔧 +CHAT: needsOnlineSearch');}
  }

  // 组装完整 prompt（问题 + 压缩后的文件上下文）
  const fullPrompt=compressedFileCtx?`${compressedFileCtx}\n\n---\n用户问题: ${userContent}`:userContent;

  // needsOnlineSearch 时：SEARCH 执行搜索 → 结果传给 CHAT 回答
  if(needsOnlineSearch(userContent)&&tools.includes('SEARCH')&&tools.includes('CHAT')){
    const cached=await lookupSearchCache(convId,userContent);
    let searchCtx='';
    if(cached){
      searchCtx=`[缓存搜索结果] ${cached.summary||cached.text||cached.title}`;
      dlog(`[SEARCH] cache hit for "${userContent.slice(0,30)}"`);
    }else{
      // 绕过 phase2，LLM 生成的 SEARCH 指令参数经常错误（如"用户要求"），直接用 userContent
      dlog(`[SEARCH] direct search: "${userContent.slice(0,30)}"`);
      const sr=await execSearch({q: userContent, originalQuery: userContent});
      if(sr && !sr.includes('失败')){
        appendSearchCache(convId,userContent,{title:userContent,summary:sr,text:sr});
        searchCtx=`[实时搜索]\n${sr}`;
        dlog(`[SEARCH] result for "${userContent.slice(0,30)}": ${sr.slice(0,60)}`);
      }
    }
    if(tools.includes('CHAT')){
      dlog(`[CHAT] search${searchCtx?' with context':''} → calling ollamaOnce...`);
      const ctx=await getHistoryContext(convId);
      if(!ctx.length) ctx.unshift({role:'system',content:'你是助手。若有搜索结果则基于搜索回答；若无搜索结果，如实说"无法获取实时信息，据我所知..."然后用自身知识回答。用中文。'});
      const r=await ollamaOnce(mainModel,[
        ...ctx,
        ...messages,
        {role:'user',content:searchCtx?`${searchCtx}\n\n${fullPrompt}`:fullPrompt}
      ]);
      const ans=(r.content||'').trim();
      saveAssistant(convId,ans);
      await compressConversation(convId,mainModel);
      return ans;
    }
    return searchCtx||'未找到相关信息';
  }

  if(tools.includes('CHAT')) {
    const ctx=await getHistoryContext(convId);
    const r=await ollamaOnce(effectiveMainModel,[
      ...ctx,
      {role:'user',content:fullPrompt}
    ]);
    const ans=(r.content||'').trim();
    saveAssistant(convId,ans);
    await compressConversation(convId,effectiveMainModel);
    return ans;
  }

  // 执行指令
  let instructions=_instructions||[];
  dlog(`[P3] _instructions=${JSON.stringify(_instructions?.slice(0,3))} count=${instructions.length} tools=${JSON.stringify(tools)}`);
  if(instructions.length===0&&tools.length>0){
    const targets=await phase2_instructions(mainModel,userContent,tools,messages,{single:tools.length===1});
    for(const t of targets){
      const inst=parseInstruction(t);
      if(inst) instructions.push(t);
    }
    // 补全缺失的工具指令（SEARCH 已 URL 化，无需 NAVIGATE 前置）
    const covered=new Set(instructions.map(s=>parseInstruction(s)?.action).filter(Boolean));
    if(tools.includes('SEARCH')&&!covered.has('SEARCH')) {
      instructions.push(`SEARCH query=${encodeURIComponent(userContent)}`);
    }
    if(instructions.length===0){
      dlog('[P3] phase2 解析失败，fallback 搜索');
      instructions.push(`SEARCH q=${encodeURIComponent(userContent)}`);
    }
    // NAVIGATE URL 修正：检测编码乱码/搜索型 URL，改为 SEARCH 保留语义
    instructions=instructions.map(i=>{
      const inst=parseInstruction(i);
      if(inst?.action!=='NAVIGATE') return i;
      const url=inst.params?.url||'';
      const hasGarbledQuery=url.length>80&&/(search\?q|browse\/search\?q|s\?wd)/.test(url);
      if(!hasGarbledQuery) return i;
      // 从用户输入提取站点词，构造带站点限定词的搜索
      const sites={贴吧:'tieba.baidu.com',百度:'www.baidu.com',知乎:'www.zhihu.com',微博:'weibo.com',B站:'www.bilibili.com',bilibili:'www.bilibili.com',淘宝:'www.taobao.com',京东:'www.jd.com',抖音:'www.douyin.com',小红书:'www.xiaohongshu.com',CSDN:'www.csdn.net',掘金:'juejin.cn',GitHub:'github.com',Bing:'www.bing.com'};
      for(const[k,domain]of Object.entries(sites)){
        if(userContent.includes(k)){
          dlog(`[P3] NAVIGATE→SEARCH: 用 "${k}" 限定搜索`);
          return`SEARCH q=${encodeURIComponent(k+' 推荐 热门')}`;
        }
      }
      // 无匹配站点 → 回退为用原始问题搜索
      dlog(`[P3] NAVIGATE URL 修正: 回退搜索 "${userContent.slice(0,20)}"`);
      return`SEARCH q=${encodeURIComponent(userContent)}`;
    });
  }

  const results=[];
  for(let i=0;i<instructions.length;i++){
    const instStr=instructions[i];
    let inst=parseInstruction(instStr)||{action:instStr,params:{}};
    // 修复：检测 SEARCH 参数是否为占位符，如果是则使用 userContent
    if(inst.action==='SEARCH'){
      const{query,q,input}=inst.params||{};
      const raw=query||q||input||'';
      if(raw && (raw.length<4 || /^(用户要求|请|帮我|查询|搜索)$/.test(raw))){
        dlog('[P3] 检测到占位符 SEARCH 参数，替换为 userContent');
        inst={...inst,params:{...inst.params,q:userContent,originalQuery:userContent}};
      }
    }
    dlog(`[P3] >>> 执行: ${inst.action} params=${JSON.stringify(inst.params||{})}`);
    const r=await executeInstruction(inst,userContent,tools);
    dlog(`[P3] <<< 结果: ${r.slice(0,100)}`);
    results.push(r);
    // 步骤验证：根据复杂度决定修复策略
    if(/(?:失败|timeout|not found|error|无法|不能)/i.test(r)){
      if(complexity > 50) {
        // P0: 复杂度>50，用主模型(8b)修复，最多3次
        dlog(`[P3] ⚠ 复杂度=${complexity}>50，使用主模型修复...`);
        let fixSuccess = false;
        for(let tryCount=0; tryCount<3; tryCount++) {
          if(browserCdp) try{browser.closeCDP(browserCdp);browserCdp=null;}catch{}
          const fixPrompt = `用户指令: ${userContent}\n工具: ${inst.action}\n参数: ${JSON.stringify(inst.params)}\n错误结果: ${r}\n请生成修复后的工具调用指令，只输出一行指令。`;
          const fixResult = await ollamaOnce(mainModel, [
            {role:'system',content:'你是工具修复助手。根据错误信息生成正确的工具调用指令。只输出一行指令，格式如 SEARCH q=xxx 或 NAVIGATE url=xxx。'},
            {role:'user',content:fixPrompt}
          ], {num_predict: 100});
          const fixInstStr = (fixResult.content||'').trim().split('\n')[0];
          const fixInst = parseInstruction(fixInstStr);
          if(fixInst) {
            dlog(`[P3] 🔧 修复尝试${tryCount+1}: ${fixInstStr}`);
            const r3 = await executeInstruction(fixInst, userContent, tools);
            if(!/(?:失败|timeout|not found|error|无法|不能)/i.test(r3)) {
              results[results.length-1] = r3;
              fixSuccess = true;
              dlog(`[P3] ✓ 修复成功`);
              break;
            }
          }
        }
        if(!fixSuccess) {
          results[results.length-1] = `[修复失败] ${r}`;
        }
      } else {
        // P1: 复杂度<=50，小模型修复一次，还不行就报错
        dlog(`[P3] ⚠ 复杂度=${complexity}<=50，使用小模型修复...`);
        if(browserCdp) try{browser.closeCDP(browserCdp);browserCdp=null;}catch{}
        const r2=await executeInstruction(inst,userContent,tools);
        if(!/(?:失败|timeout|not found|error|无法|不能)/i.test(r2)){
          results[results.length-1]=r2;
          dlog(`[P3] ✓ 小模型重试成功`);
        } else {
          results[results.length-1] = `[小模型修复失败] ${r2 || r}`;
          dlog(`[P3] ✗ 小模型修复失败`);
        }
      }
    }
    // NAVIGATE fallback：页面无有效内容 → 关闭 CDP → 自动搜索
    if(inst.action==='NAVIGATE'){
      const body=(results[results.length-1]||'').replace(/^页面:.*?\n标题:.*?\n\n/s,'').trim();
      if(body.length<50){
        dlog('[P3] NAVIGATE 无有效内容，关闭 CDP 后 fallback 搜索');
        if(browserCdp) try{browser.closeCDP(browserCdp);browserCdp=null;}catch{}
        const sr=await execSearch({q:userContent,originalQuery:userContent});
        results[results.length-1]='[页面内容不足，已自动搜索]\n'+sr;
        dlog(`[P3] <<< 搜索: ${sr.slice(0,100)}`);
      }
    }
    // 步骤间等待页面稳定
    if(i<instructions.length-1){
      try{if(browserCdp&&!browserCdp.closed) await browser.waitForLoad(browserCdp,8000);}catch{}
      await new Promise(r=>setTimeout(r,2000)); // 额外 2s 缓冲
    }
  }

  const finalResult=results.join('\n---\n');
  // 有文件上下文时，始终让模型基于文件内容+操作结果回答用户
  if(fileContext){
    const r2=await ollamaOnce(mainModel,[
      {role:'system',content:'你收到了用户拖拽的文件内容和操作结果。请基于文件内容，用中文简洁回答用户的问题。'},
      {role:'user',content:`${fullPrompt}\n\n操作结果:\n${finalResult}`}
    ],{num_predict:2048,temperature:0.3});
    const ans=(r2.content||'').trim();
    if(ans) saveAssistant(convId,ans);
    await compressConversation(convId,mainModel);
    return ans||finalResult;
  }
  const showResult=feedback||tools.includes('CLICK')||tools.includes('SEARCH')||tools.includes('NAVIGATE')||tools.includes('READ');
  if(showResult) saveAssistant(convId,finalResult);
  // 通用：非CHAT路径下，只要有搜索结果或需要反馈，始终让模型生成回答
  if((feedback||needsOnlineSearch(userContent))&&!tools.includes('CHAT')&&finalResult){
    const r2=await ollamaOnce(mainModel,[
      {role:'system',content:'基于以下操作结果，用中文简洁回答用户的问题。'},
      {role:'user',content:`问题: ${userContent}\n\n结果:\n${finalResult}`}
    ],{num_predict:2048,temperature:0.3});
    const ans=(r2.content||'').trim();
    if(ans) saveAssistant(convId,ans);
    await compressConversation(convId,mainModel);
    return ans||finalResult;
  }
  else saveAssistant(convId,`[操作完成: ${tools.join(', ')}]`);
  await compressConversation(convId,mainModel);
  return finalResult;
}

// ── CLI ──
const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', 
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', 
  magenta:'\x1b[35m', cyan:'\x1b[36m', white:'\x1b[37m', gray:'\x1b[90m' };
const B = (s,c) => C[c] + s + C.reset;
const clear = () => process.stdout.write('\x1b[2J\x1b[H');

let cliConvId = null;           // 当前对话ID
let cliModel = 'qwen2.5:3b';    // 当前模型
let cliHistory = [];            // 当前对话历史 [{role,content}]

function banner() {
  clear();
  console.log(B('  ╔══════════════════════════════════════════╗', 'cyan'));
  console.log(B('  ║', 'cyan') + B('  🐑  轻 量  A g e n t   C L I          ', 'yellow') + B('║', 'cyan'));
  console.log(B('  ║', 'cyan') + B('    本地 Ollama + CDP 浏览器 · 命令行版   ', 'dim') + B('║', 'cyan'));
  console.log(B('  ╚══════════════════════════════════════════╝', 'cyan'));
}

function showMenu() {
  console.log('');
  console.log(B('  📋 命令菜单', 'bold'));
  console.log(B('  ──────────────────────────────────────────', 'dim'));
  console.log('  ' + B('/chat', 'green') + ' 或直接输入    ' + B('💬 日常对话', 'white'));
  console.log('  ' + B('/new', 'green')  + '              ' + B('✨ 新开对话', 'white'));
  console.log('  ' + B('/hist', 'green') + '             ' + B('📜 对话历史', 'white'));
  console.log('  ' + B('/resume <id>', 'green') + '       ' + B('🔙 回溯对话', 'white'));
  console.log('  ' + B('/skills', 'green') + '           ' + B('📦 查看技能库', 'white'));
  console.log('  ' + B('/installed', 'green') + '        ' + B('📥 已装技能', 'white'));
  console.log('  ' + B('/install <name>', 'green') + '   ' + B('🔧 安装技能', 'white'));
  console.log('  ' + B('/rm <name>', 'green') + '         ' + B('🗑 卸载技能', 'white'));
  console.log('  ' + B('/log', 'green') + '              ' + B('📝 撰写日志', 'white'));
  console.log('  ' + B('/log today', 'green') + '         ' + B('📖 今日日志', 'white'));
  console.log('  ' + B('/model', 'green') + '            ' + B('🤖 切换模型', 'white'));
  console.log('  ' + B('/clear', 'green') + '            ' + B('🧹 清屏', 'white'));
  console.log('  ' + B('/help', 'green') + '  exit/quit    ' + B('❓ 帮助 / 退出', 'white'));
  console.log(B('  ──────────────────────────────────────────', 'dim'));
  console.log('');
  console.log(B('  当前模型: ' + cliModel + '  |  对话: ' + (cliConvId ? cliConvId : '无'), 'dim'));
  console.log('');
}

async function handleCmd(line) {
  const q = line.trim();
  if (!q) return;

  // ===== 处理锁: 防止并发竞态 =====
  if (isProcessing) {
    inputQueue.push(line);
    console.log(B('  ⏳ 上一个任务处理中，输入已排队...', 'yellow'));
    return;
  }
  isProcessing = true;

  try {
  // 退出
  if (q === 'exit' || q === 'quit') {
    console.log(B('\n  👋 再见！', 'yellow'));
    await browser.targetPool.closeAll().catch(() => {});
    await flushLog();
    process.exit(0);
  }

  // 帮助
  if (q === '/help') { banner(); showMenu(); return; }
  if (q === '/clear') { banner(); showMenu(); return; }

  // 模型切换
  if (q.startsWith('/model')) {
    const m = q.split(' ')[1];
    if (m) { cliModel = m; console.log(B('  ✅ 模型已切换: ' + m, 'green')); }
    else { console.log(B('  📋 可用: ', 'dim') + localModels.join(', ')); }
    return;
  }

  // 对话管理
  if (q === '/new') {
    cliConvId = null; cliHistory = [];
    console.log(B('  ✨ 新对话已创建', 'green'));
    return;
  }

  if (q === '/hist') {
    // 列出conversations目录下的所有对话文件
    const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json'));
    const convs = [];
    for (const f of files) {
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
        convs.push(conv);
      } catch {}
    }
    convs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (!convs.length) { console.log(B('  📭 暂无对话', 'dim')); return; }
    console.log(B('\n  📜 最近对话', 'bold'));
    for (const c of convs.slice(0, 10)) {
      const preview = c.msgs && c.msgs.length ? c.msgs[c.msgs.length - 1].content.slice(0, 30) : '(空)';
      console.log(B(`    [${c.id}]`, 'green') + ` ${c.name || '...'}  ${B(preview, 'dim')}`);
    }
    console.log('');
    return;
  }

  if (q.startsWith('/resume')) {
    const id = q.split(' ')[1];
    if (!id) { console.log(B('  ⚠ 用法: /resume <对话ID>', 'yellow')); return; }
    const conv = await loadConv(id);
    if (!conv || !conv.msgs) { console.log(B('  ❌ 对话不存在', 'red')); return; }
    cliConvId = id;
    cliHistory = conv.msgs.slice(-20);
    console.log(B('  🔙 已回溯: ' + id + ' (' + cliHistory.length + ' 条消息)', 'green'));
    return;
  }

  // 技能管理
  if (q === '/skills') {
    const skills = loadSkills();
    console.log(B('\n  📦 技能库', 'bold'));
    if (!skills.available.length) {
      // 预置默认技能库
      skills.available = [
        {name:'file-manager', desc:'文件管理器', icon:'📁'},
        {name:'excel-master', desc:'Excel大师', icon:'📊'},
        {name:'browser-cdp', desc:'浏览器自动化', icon:'🌐'},
        {name:'qq-email', desc:'QQ邮箱', icon:'📧'},
        {name:'material-organizer', desc:'资料整理助手', icon:'📚'},
        {name:'pdf-reader', desc:'PDF阅读器', icon:'📄'},
        {name:'code-review', desc:'代码审查', icon:'🔍'},
        {name:'terminal-helper', desc:'终端助手', icon:'💻'},
      ];
      saveSkills(skills);
    }
    for (const s of skills.available) {
      const inst = skills.installed.find(i => i.name === s.name);
      const tag = inst ? B('✓ 已装', 'green') : B('○', 'dim');
      console.log(`    ${tag}  ${s.icon || '📌'} ${B(s.name, 'cyan')} — ${B(s.desc, 'dim')}`);
    }
    console.log('');
    return;
  }

  if (q === '/installed') {
    const skills = loadSkills();
    if (!skills.installed.length) { console.log(B('  📭 暂无已装技能', 'dim')); return; }
    console.log(B('\n  📥 已装技能', 'bold'));
    for (const s of skills.installed) {
      console.log(`    ${s.icon || '📌'} ${B(s.name, 'cyan')} — ${B(s.desc, 'dim')}`);
    }
    console.log('');
    return;
  }

  if (q.startsWith('/install')) {
    const name = q.split(' ')[1];
    if (!name) { console.log(B('  ⚠ 用法: /install <技能名>', 'yellow')); return; }
    const skills = loadSkills();
    const target = skills.available.find(s => s.name === name);
    if (!target) { console.log(B('  ❌ 技能不存在，请先 /skills 查看', 'red')); return; }
    if (skills.installed.find(s => s.name === name)) {
      console.log(B('  ⚠ 已安装', 'yellow')); return;
    }
    skills.installed.push(target);
    saveSkills(skills);
    console.log(B('  ✅ 已安装: ' + name, 'green'));
    return;
  }

  if (q.startsWith('/rm')) {
    const name = q.split(' ')[1];
    if (!name) { console.log(B('  ⚠ 用法: /rm <技能名>', 'yellow')); return; }
    const skills = loadSkills();
    skills.installed = skills.installed.filter(s => s.name !== name);
    saveSkills(skills);
    console.log(B('  🗑 已卸载: ' + name, 'green'));
    return;
  }

  // 日志
  const LOG_DIR = path.join(DATA_DIR, 'logs');
  if (q === '/log') {
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    console.log(B('\n  📝 撰写日志 (' + ymd + ')', 'bold'));
    console.log(B('  输入内容，空行结束', 'dim'));
    const lines = [];
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.setPrompt('  > ');
    rl2.prompt();
    for await (const l of rl2) {
      if (!l.trim()) { rl2.close(); break; }
      lines.push(l.trim());
      rl2.prompt();
    }
    if (lines.length) {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, {recursive:true});
      fs.appendFileSync(path.join(LOG_DIR, `${ymd}.md`), `\n### ${now.toLocaleTimeString('zh-CN')}\n${lines.join('\n')}\n`, 'utf8');
      console.log(B('  ✅ 日志已保存', 'green'));
    }
    banner(); showMenu();
    return;
  }

  if (q === '/log today') {
    const now = new Date();
    const ymd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const f = path.join(LOG_DIR, `${ymd}.md`);
    if (fs.existsSync(f)) {
      console.log(B('\n  📖 今日日志', 'bold'));
      console.log(fs.readFileSync(f, 'utf8'));
    } else {
      console.log(B('  📭 今日暂无日志', 'dim'));
    }
    console.log('');
    return;
  }

  // 日常对话
  console.log(B('  🤔 思考中...', 'dim'));
  try {
    const router = pickRouterModel(cliModel);
    const msgs = cliHistory.length ? [...cliHistory] : [];
    msgs.push({ role: 'user', content: q });
    // 确保有convId
    if (!cliConvId) cliConvId = genId();
    const result = await runPipeline({
      mainModel: cliModel, routerModel: router,
      userContent: q, fileContext: '', messages: cliHistory, convId: cliConvId
    });
    // 加载最新对话历史
    const conv = await loadConv(cliConvId);
    cliHistory = (conv.msgs || []).slice(-20);
    console.log(B('\n  ┌─ AI ──────────────────────────────', 'cyan'));
    console.log('  ' + result.split('\n').join('\n  '));
    console.log(B('  └────────────────────────────────────', 'cyan'));
  } catch (e) { console.log(B('  ❌ ' + e.message, 'red')); }
  console.log('');

  // ===== 释放处理锁并处理队列 =====
  } finally {
    isProcessing = false;
    if (inputQueue.length > 0) {
      const next = inputQueue.shift();
      dlog(`[QUEUE] 处理排队输入: ${next.slice(0, 20)}...`);
      setTimeout(() => handleCmd(next), 100);
    }
  }
}

// ── 主入口 ──
async function main() {
  clear();
  banner();
  showMenu();

  const cliArg = process.argv.slice(2).join(' ');
  if (cliArg) {
    console.log(B('  🤔 处理中...', 'dim'));
    try {
      const router = pickRouterModel(cliModel);
      const result = await runPipeline({
        mainModel: cliModel, routerModel: router,
        userContent: cliArg, fileContext: '', messages: [], convId: genId()
      });
      console.log(B('\n  ┌─ AI ──────────────────────────────', 'cyan'));
      console.log('  ' + result.split('\n').join('\n  '));
      console.log(B('  └────────────────────────────────────', 'cyan'));
    } catch(e) { console.log(B('  ❌ ' + e.message, 'red')); }
    console.log('');
    await browser.targetPool.closeAll().catch(() => {});
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(B('  🐑 ', 'yellow') + '> ');
  rl.prompt();
  rl.on('line', async (line) => { await handleCmd(line); rl.prompt(); });
  rl.on('close', async () => {
    await browser.targetPool.closeAll().catch(() => {});
    process.exit(0);
  });
}

main().catch(e => { console.error(B('启动失败: ' + e.message, 'red')); process.exit(1); });
process.on('SIGINT', () => { browser.targetPool.closeAll().catch(() => {}); process.exit(); });
