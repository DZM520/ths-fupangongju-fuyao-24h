'use strict';
/**
 * 连板情绪数据（东方财富公开接口，无需 API Key）
 *
 * 数据源（均为公开无鉴权接口，GitHub 上 akshare 等项目同样使用）：
 *   push2ex.eastmoney.com/getTopicZTPool   今日涨停池（含连板数、涨停统计、封单、炸板次数、首封时间、行业）
 *   push2ex.eastmoney.com/getTopicZBPool   今日炸板池
 *   push2ex.eastmoney.com/getTopicDTPool   今日跌停池
 *   push2ex.eastmoney.com/getTopicZTPool   date=上一交易日 → 昨日涨停池（算晋级率）
 *   push2.eastmoney.com/api/qt/ulist.np/get 批量行情（算昨日涨停今日溢价）
 *   qt.gtimg.cn/q=...                     批量行情兜底（东财不可达时）
 *   data.10jqka.com.cn/dataapi/limit_up/limit_up_pool 涨停原因 / 板型 / 封板成功率（可选增强）
 *
 * 设计要点：
 *   - 纯函数 computeSentiment 独立可测，不依赖网络
 *   - 抓取失败只抛错，由调用方决定是否降级（不影响主热榜抓取）
 *   - 所有数值字段做单位换算：p 为价格×1000，fbt/lbt 为 HHMMSS 整数
 */

const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: '*/*',
};
// 同花顺涨停池（涨停原因 / 板型 / 封板成功率），公开接口，akshare 等项目同源
const THS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html',
  Accept: '*/*',
};
const TX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://gu.qq.com/',
  Accept: '*/*',
};

/* ---------------- 工具 ---------------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** HHMMSS 整数 → "09:25" */
function fmtTime(v) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  const s = String(Math.floor(Number(v))).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** 日期 → YYYYMMDD */
function ymd(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 上一个自然日（用于取昨日涨停池；周末/节假日接口会返回最近交易日数据） */
function prevDay(d) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() - 1);
  return x;
}

async function emGet(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: EM_HEADERS, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      throw new Error('返回不是 JSON: ' + txt.slice(0, 100));
    }
    // 东财业务错误码：rc=102 表示参数不合法（例如不支持的日期）
    if (json.rc != null && json.rc !== 0) throw new Error(`东财返回 rc=${json.rc}`);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓单个池，自动翻页（东财单页最多 100 左右，涨停多时需翻页） */
async function fetchPool(endpoint, dateYmd, sort) {
  const all = [];
  let total = 0;
  let qdate = null;
  for (let page = 0; page < 6; page++) {
    const qs = new URLSearchParams({
      ut: EM_UT,
      dpt: 'wz.ztzt',
      Pageindex: String(page),
      pagesize: '100',
      date: dateYmd,
    });
    if (sort) qs.set('sort', sort);
    const data = await emGet(`https://push2ex.eastmoney.com/${endpoint}?${qs.toString()}`);
    if (!data) break;
    total = data.tc || 0;
    if (data.qdate != null) qdate = String(data.qdate);
    const pool = data.pool || [];
    if (!pool.length) break;
    all.push(...pool);
    if (all.length >= total || pool.length < 100) break;
  }
  return { total, list: all, qdate };
}

/** YYYYMMDD 加减天数 */
function shiftYmd(ymdStr, delta) {
  const y = parseInt(ymdStr.slice(0, 4), 10);
  const m = parseInt(ymdStr.slice(4, 6), 10) - 1;
  const d = parseInt(ymdStr.slice(6, 8), 10);
  const dt = new Date(y, m, d + delta);
  return ymd(dt);
}

/** 代码集合指纹，用于判断两次请求是否拿到同一批数据 */
function poolFingerprint(list) {
  return list
    .map((r) => String(r.c))
    .sort()
    .join(',');
}

/** 批量行情：secids = ["0.000573", ...] */
async function fetchQuotesEM(secids) {
  const out = new Map();
  const CHUNK = 80;
  for (let i = 0; i < secids.length; i += CHUNK) {
    const batch = secids.slice(i, i + CHUNK);
    const qs = new URLSearchParams({
      fltt: '2',
      secids: batch.join(','),
      fields: 'f2,f3,f12,f14',
    });
    const data = await emGet(`https://push2.eastmoney.com/api/qt/ulist.np/get?${qs.toString()}`);
    for (const it of (data && data.diff) || []) {
      out.set(String(it.f12), {
        price: it.f2 === '-' ? null : it.f2,
        changePct: it.f3 === '-' ? null : it.f3,
        name: it.f14,
      });
    }
  }
  return out;
}

/** 腾讯批量行情兜底：东财 push2 不可达时仍能算昨涨停溢价 */
async function fetchQuotesTX(secids) {
  const out = new Map();
  const codes = secids.map((s) => {
    const p = String(s).split('.');
    const pre = p[0] === '1' ? 'sh' : p[0] === '2' ? 'bj' : 'sz';
    return pre + p[1];
  });
  const CHUNK = 60;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const batch = codes.slice(i, i + CHUNK);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    let txt;
    try {
      const resp = await fetch(`https://qt.gtimg.cn/q=${batch.join(',')}`, {
        headers: TX_HEADERS,
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      txt = await resp.text();
    } finally {
      clearTimeout(timer);
    }
    const re = /v_(sh|sz|bj)(\d{6})="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[3].split('~');
      out.set(m[2], {
        price: f[3] != null && f[3] !== '' ? Number(f[3]) : null,
        changePct: f[32] != null && f[32] !== '' ? Number(f[32]) : null,
        name: '',
      });
    }
  }
  return out;
}

async function fetchQuotes(secids) {
  try {
    const m = await fetchQuotesEM(secids);
    if (m.size) return m;
  } catch (_) {}
  return fetchQuotesTX(secids);
}

/**
 * 同花顺涨停池：涨停原因 / 板型 / 封板成功率
 * 失败不影响主流程（返回空 Map），仅少这些标签。
 */
async function fetchThsReasons(dateYmd) {
  const qs = new URLSearchParams({
    page: '1',
    limit: '200',
    field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004',
    filter: 'HS,GEM2STAR',
    order_field: '330324',
    order_type: '0',
    date: dateYmd,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const resp = await fetch(`https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?${qs.toString()}`, {
      headers: THS_HEADERS,
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.status_code !== 0) throw new Error('同花顺返回异常');
    const map = new Map();
    for (const it of (json.data && json.data.info) || []) {
      const code = String(it.code || '');
      if (!code) continue;
      map.set(code, {
        reason: String(it.reason_type || '').trim(),
        boardType: String(it.limit_up_type || '').trim(),
        sucRate: Number.isFinite(Number(it.limit_up_suc_rate)) ? Number((Number(it.limit_up_suc_rate) * 100).toFixed(1)) : null,
      });
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 归一化 ---------------- */

function normLimitUp(r) {
  return {
    code: String(r.c),
    market: r.m === 1 ? 'sh' : r.m === 2 ? 'bj' : 'sz',
    name: r.n,
    price: r.p != null ? r.p / 1000 : null,
    changePct: r.zdp != null ? Number(r.zdp.toFixed(2)) : null,
    streak: r.lbc || 1, // 连板数
    firstSealAt: fmtTime(r.fbt), // 首次封板
    lastSealAt: fmtTime(r.lbt), // 最后封板
    sealFund: r.fund || 0, // 封单额（元）
    breakCount: r.zbc || 0, // 炸板次数
    turnover: r.hs != null ? Number(r.hs.toFixed(2)) : null, // 换手率 %
    amount: r.amount || 0, // 成交额
    floatCap: r.ltsz || 0, // 流通市值
    industry: (r.hybk || '').trim(),
    statDays: r.zttj ? r.zttj.days : null, // N天
    statBoards: r.zttj ? r.zttj.ct : null, // M板
    sealRatio: r.fund && r.ltsz ? Number(((r.fund / r.ltsz) * 100).toFixed(2)) : null, // 封单/流通市值 %
    reason: '',
    boardType: '',
    sucRate: null,
  };
}

function normBroken(r) {
  return {
    code: String(r.c),
    market: r.m === 1 ? 'sh' : r.m === 2 ? 'bj' : 'sz',
    name: r.n,
    price: r.p != null ? r.p / 1000 : null,
    changePct: r.zdp != null ? Number(r.zdp.toFixed(2)) : null,
    turnover: r.hs != null ? Number(r.hs.toFixed(2)) : null,
    firstSealAt: fmtTime(r.fbt),
    breakCount: r.zbc || 0,
    amplitude: r.zf != null ? Number(r.zf.toFixed(2)) : null,
    industry: (r.hybk || '').trim(),
    streak: r.lbc || 1,
  };
}

function normLimitDown(r) {
  return {
    code: String(r.c),
    market: r.m === 1 ? 'sh' : r.m === 2 ? 'bj' : 'sz',
    name: r.n,
    price: r.p != null ? r.p / 1000 : null,
    changePct: r.zdp != null ? Number(r.zdp.toFixed(2)) : null,
    sealFund: r.fund || 0,
    lastSealAt: fmtTime(r.lbt),
    days: r.days || 1, // 连续跌停天数
    industry: (r.hybk || '').trim(),
  };
}

/* ---------------- 情绪计算（纯函数） ---------------- */

/**
 * @param {object} p
 * @param {Array} p.today     今日涨停池（归一化）
 * @param {Array} p.broken    今日炸板池
 * @param {Array} p.down      今日跌停池
 * @param {Array} p.yesterday 昨日涨停池（归一化，仅需 code/streak）
 * @param {Map}   p.quoteMap  昨日涨停股 → 今日行情 {changePct}
 */
function computeSentiment({ today = [], broken = [], down = [], yesterday = [], quoteMap = null }) {
  const limitUp = today.length;
  const brokenCount = broken.length;
  const limitDown = down.length;

  // 炸板率 = 炸板 / (涨停 + 炸板)；分母为 0 时记 0
  const denom = limitUp + brokenCount;
  const brokenRate = denom > 0 ? brokenCount / denom : 0;

  // 连板梯队
  const ladderMap = new Map();
  for (const s of today) {
    const k = s.streak || 1;
    if (!ladderMap.has(k)) ladderMap.set(k, []);
    ladderMap.get(k).push(s);
  }
  const ladder = [...ladderMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([streak, list]) => ({
      streak,
      count: list.length,
      stocks: list
        .slice()
        .sort((a, b) => b.sealFund - a.sealFund)
        .map((s) => ({
          code: s.code,
          name: s.name,
          streak: s.streak,
          sealFund: s.sealFund,
          sealRatio: s.sealRatio,
          firstSealAt: s.firstSealAt,
          breakCount: s.breakCount,
          turnover: s.turnover,
          industry: s.industry,
          reason: s.reason || '',
          boardType: s.boardType || '',
          sucRate: s.sucRate,
          statLabel: s.statDays && s.statBoards ? `${s.statDays}天${s.statBoards}板` : '',
        })),
    }));

  const maxStreak = today.reduce((m, s) => Math.max(m, s.streak || 1), 0);

  // 晋级率：昨日 N 板 → 今日 ≥N+1 板
  const todayByCode = new Map(today.map((s) => [s.code, s]));
  const promo = [];
  let yesterdayLimitUpCount = 0;
  if (yesterday.length) {
    const buckets = new Map();
    for (const y of yesterday) {
      if (!y || !y.code) continue;
      yesterdayLimitUpCount += 1;
      const k = y.streak || 1;
      if (!buckets.has(k)) buckets.set(k, { total: 0, promoted: 0 });
      const b = buckets.get(k);
      b.total += 1;
      const t = todayByCode.get(y.code);
      if (t && (t.streak || 1) >= k + 1) b.promoted += 1;
    }
    for (const [from, b] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
      promo.push({
        from,
        total: b.total,
        promoted: b.promoted,
        rate: b.total ? b.promoted / b.total : 0,
      });
    }
  }
  // 整体晋级率：昨日涨停中，今日仍涨停（≥2板）的占比
  const promotedTotal = promo.reduce((n, x) => n + x.promoted, 0);
  const promotionRate = yesterdayLimitUpCount ? promotedTotal / yesterdayLimitUpCount : 0;

  // 昨涨停今日溢价：昨日涨停股今日涨跌幅均值（情绪核心）
  let premium = null;
  let premiumUp = 0;
  let premiumSamples = 0;
  if (yesterday.length && quoteMap) {
    let sum = 0;
    for (const y of yesterday) {
      const q = quoteMap.get(y.code);
      if (!q || q.changePct == null) continue;
      sum += q.changePct;
      premiumSamples += 1;
      if (q.changePct > 0) premiumUp += 1;
    }
    if (premiumSamples) premium = sum / premiumSamples;
  }
  const premiumWinRate = premiumSamples ? premiumUp / premiumSamples : null;

  // 昨日连板股（≥2板）今日溢价 —— 接力资金的真实赚钱效应
  let streakPremium = null;
  if (yesterday.length && quoteMap) {
    let sum = 0;
    let n = 0;
    for (const y of yesterday) {
      if ((y.streak || 1) < 2) continue;
      const q = quoteMap.get(y.code);
      if (!q || q.changePct == null) continue;
      sum += q.changePct;
      n += 1;
    }
    if (n) streakPremium = sum / n;
  }

  // 晋级名单：昨日涨停今日继续涨停的个股（按连板提升幅度、连板数排序）
  const promotedStocks = [];
  if (yesterday.length) {
    for (const y of yesterday) {
      if (!y || !y.code) continue;
      const t = todayByCode.get(y.code);
      if (!t) continue;
      const from = y.streak || 1;
      const to = t.streak || 1;
      if (to < from + 1) continue;
      const q = quoteMap ? quoteMap.get(y.code) : null;
      promotedStocks.push({
        code: t.code,
        name: t.name,
        from,
        to,
        statLabel: t.statDays && t.statBoards ? `${t.statDays}天${t.statBoards}板` : '',
        sealFund: t.sealFund,
        firstSealAt: t.firstSealAt,
        breakCount: t.breakCount,
        industry: t.industry,
        reason: t.reason || '',
        boardType: t.boardType || '',
        changePct: q && q.changePct != null ? Number(q.changePct.toFixed(2)) : t.changePct,
      });
    }
    promotedStocks.sort((a, b) => b.to - a.to || b.from - a.from || b.sealFund - a.sealFund);
  }

  // 题材分布（涨停池按行业聚合）
  const indMap = new Map();
  for (const s of today) {
    const k = s.industry || '其他';
    if (!indMap.has(k)) indMap.set(k, { industry: k, count: 0, maxStreak: 0 });
    const it = indMap.get(k);
    it.count += 1;
    it.maxStreak = Math.max(it.maxStreak, s.streak || 1);
  }
  const industries = [...indMap.values()].sort((a, b) => b.count - a.count || b.maxStreak - a.maxStreak);

  // 涨停原因聚合（同花顺 reason_type，按 + / 、 / 空格 拆词）
  const themeMap = new Map();
  for (const s of today) {
    if (!s.reason) continue;
    const tokens = s.reason
      .split(/[+＋、,，/／;；|｜\s]+/)
      .map((t) => t.trim())
      .filter((t) => t && t.length >= 2 && t.length <= 10);
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!themeMap.has(t)) themeMap.set(t, { theme: t, count: 0, maxStreak: 0 });
      const it = themeMap.get(t);
      it.count += 1;
      it.maxStreak = Math.max(it.maxStreak, s.streak || 1);
    }
  }
  const themes = [...themeMap.values()]
    .sort((a, b) => b.count - a.count || b.maxStreak - a.maxStreak)
    .slice(0, 8);

  // 情绪分（0-100）：规则显式写死，便于核对
  //   涨停家数  0-30 分：limitUp/100 封顶
  //   炸板率    0-20 分：brokenRate 0 → 20，0.5 及以上 → 0
  //   最高板    0-20 分：maxStreak/7 封顶
  //   昨涨停溢价 0-30 分：-5% → 0，+5% 及以上 → 30（无数据按中性 15）
  const sLimit = Math.min(limitUp / 100, 1) * 30;
  const sBroken = Math.max(0, 1 - brokenRate / 0.5) * 20;
  const sStreak = Math.min(maxStreak / 7, 1) * 20;
  const sPremium = premium == null ? 15 : Math.max(0, Math.min((premium + 5) / 10, 1)) * 30;
  const score = Math.round(sLimit + sBroken + sStreak + sPremium);

  let level;
  if (score >= 70) level = '强';
  else if (score >= 45) level = '中性';
  else level = '弱';

  // 情绪周期定位（冰点 → 修复 → 发酵 → 高潮 → 退潮），无历史依赖，按当日强弱与溢价判
  let stage;
  if (score >= 78) stage = '高潮';
  else if (score >= 62) stage = '发酵';
  else if (score >= 45) stage = premium != null && premium < 0 ? '退潮' : '修复';
  else if (score >= 32) stage = '退潮';
  else stage = '冰点';

  return {
    limitUp,
    limitDown,
    brokenCount,
    brokenRate: Number((brokenRate * 100).toFixed(1)),
    maxStreak,
    promotionRate: Number((promotionRate * 100).toFixed(1)),
    yesterdayLimitUpCount,
    premium: premium == null ? null : Number(premium.toFixed(2)),
    premiumWinRate: premiumWinRate == null ? null : Number((premiumWinRate * 100).toFixed(1)),
    streakPremium: streakPremium == null ? null : Number(streakPremium.toFixed(2)),
    premiumSamples,
    ladder,
    promotion: promo.map((x) => ({ ...x, rate: Number((x.rate * 100).toFixed(1)) })),
    promotedStocks: promotedStocks.slice(0, 40),
    industries: industries.slice(0, 12),
    themes,
    score,
    level,
    stage,
    scoreParts: {
      limitUp: Number(sLimit.toFixed(1)),
      broken: Number(sBroken.toFixed(1)),
      streak: Number(sStreak.toFixed(1)),
      premium: Number(sPremium.toFixed(1)),
    },
  };
}

/* ---------------- 抓取入口 ---------------- */

/**
 * 抓一次完整快照
 * @param {Date} [now]
 * @returns {Promise<object>} 快照对象
 */
async function fetchSnapshot(now = new Date()) {
  const todayYmd = ymd(now);

  // 第一步：请求自然日。东财对「未来/无数据日期」会回退到最近交易日，
  // 因此实际交易日以返回的 qdate 为准（无法靠请求日期判断）。
  const [ztRes, zbRes, dtRes] = await Promise.allSettled([
    fetchPool('getTopicZTPool', todayYmd, 'fbt:asc'),
    fetchPool('getTopicZBPool', todayYmd, 'fbt:asc'),
    fetchPool('getTopicDTPool', todayYmd, 'fund:asc'),
  ]);

  if (ztRes.status === 'rejected') throw new Error('涨停池抓取失败：' + ztRes.reason.message);
  const ztData = ztRes.value;
  if (!ztData.list.length) throw new Error('涨停池为空（可能全市场无涨停或接口异常）');

  const tradeDate = ztData.qdate || todayYmd;

  // 第二步：昨日池 = 实际交易日往前找的第一个「不同批次」交易日。
  // 直接用 qdate-1 在周末/节假日前会拿到同一批数据，故用代码集合比对排除。
  const todayFp = poolFingerprint(ztData.list);
  let yesterdayRaw = [];
  let yesterdayDate = '';
  for (let i = 1; i <= 5; i++) {
    const probe = shiftYmd(tradeDate, -i);
    let res;
    try {
      res = await fetchPool('getTopicZTPool', probe, 'fbt:asc');
    } catch (_) {
      continue;
    }
    if (!res.list.length) continue;
    // 回退到同一批数据（说明该日无真实数据），继续往前
    if (poolFingerprint(res.list) === todayFp) continue;
    yesterdayRaw = res.list;
    yesterdayDate = probe;
    break;
  }

  const today = ztData.list.map(normLimitUp);
  const broken = (zbRes.status === 'fulfilled' ? zbRes.value.list : []).map(normBroken);
  const down = (dtRes.status === 'fulfilled' ? dtRes.value.list : []).map(normLimitDown);
  const yesterday = yesterdayRaw.map(normLimitUp);

  // 同花顺涨停原因（可选增强，失败不影响情绪计算）
  let reasonError = null;
  try {
    const reasons = await fetchThsReasons(tradeDate);
    for (const s of today) {
      const r = reasons.get(s.code);
      if (!r) continue;
      s.reason = r.reason;
      s.boardType = r.boardType;
      s.sucRate = r.sucRate;
    }
  } catch (e) {
    reasonError = e.message;
  }

  // 昨日涨停股今日行情（算溢价）
  let quoteMap = null;
  let quoteError = null;
  if (yesterday.length) {
    try {
      const secids = yesterday.map((s) => `${s.market === 'sh' ? 1 : s.market === 'bj' ? 2 : 0}.${s.code}`);
      quoteMap = await fetchQuotes(secids);
    } catch (e) {
      quoteError = e.message;
    }
  }

  const sentiment = computeSentiment({ today, broken, down, yesterday, quoteMap });

  // 涨停股代码 → 连板信息（供热榜联动）
  const streakMap = {};
  for (const s of today) {
    streakMap[s.code] = {
      streak: s.streak,
      statLabel: s.statDays && s.statBoards ? `${s.statDays}天${s.statBoards}板` : '',
      firstSealAt: s.firstSealAt,
      breakCount: s.breakCount,
      sealFund: s.sealFund,
    };
  }

  return {
    capturedAt: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    capturedAtIso: now.toISOString(),
    tradeDate,
    yesterdayTradeDate: yesterdayDate,
    staleDays: Math.max(0, Math.round((now - new Date(
      parseInt(tradeDate.slice(0, 4), 10),
      parseInt(tradeDate.slice(4, 6), 10) - 1,
      parseInt(tradeDate.slice(6, 8), 10)
    )) / 86400000)),
    sentiment,
    streakMap,
    limitUp: today,
    broken,
    down,
    yesterdayLimitUpCount: yesterday.length,
    quoteError,
    reasonError,
    source: 'eastmoney+ths',
  };
}

module.exports = {
  fetchSnapshot,
  computeSentiment,
  fetchThsReasons,
  fmtTime,
  normLimitUp,
  normBroken,
  normLimitDown,
};
