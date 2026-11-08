/**
 * 同花顺热榜 · GitHub Actions 定时抓取
 * 零依赖：只用 Node 内置 fetch / fs（Node >= 20）
 *
 * 环境变量：
 *   FUYAO_API_KEY  必填，扶摇 API Key
 *   TZ             可选，默认 Asia/Shanghai
 *   KEEP_DAYS      可选，记录保留天数，默认 400；<=0 表示永久保留
 *   DRY_RUN        可选，=1 时只抓取、不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWorkbook } from './lib/xlsx.mjs';
import {
  ensureDirs,
  exportsDir,
  listRecordIds,
  pruneOld,
  pruneOldExports,
  readJson,
  rebuildIndex,
  recordsDir,
  writeJson,
} from './lib/store.mjs';

const FUYAO_BASE = 'https://fuyao.aicubes.cn';
const API_HOT = '/api/a-share/special-data/hot-stock-list';
const API_SNAP = '/api/a-share/prices/snapshot';
const TZ = process.env.TZ_OVERRIDE || 'Asia/Shanghai';
const SHEET_HEADER = ['排名', '股票代码', '股票名称', '现价', '当时涨幅(%)', '热度', '交易所', '抓取时间'];
const SHEET_WIDTHS = [6, 10, 12, 9, 11, 10, 6, 18];

const API_KEY = (process.env.FUYAO_API_KEY || '').trim();
const DRY_RUN = process.env.DRY_RUN === '1';
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 400);

/* ---------------- 时间（显式东八区） ---------------- */
function nowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    time: `${parts.hour}:${parts.minute}`,
    hh: parts.hour,
    mm: parts.minute,
  };
}
const pad = (n) => String(n).padStart(2, '0');

/* ---------------- API（加入重试机制） ---------------- */
async function apiGet(pathname, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const url = new URL(pathname, FUYAO_BASE);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
      const resp = await fetch(url, {
        headers: { 'X-api-key': API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(25000),
      });
      const text = await resp.text();

      // 鉴权或限流错误直接抛出，不重试
      if (resp.status === 401 || resp.status === 403) throw new Error(`HTTP ${resp.status} Key 无效或无权限: ${text.slice(0, 120)}`);
      if (resp.status === 429) throw new Error('HTTP 429 调用频率超限');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('返回不是 JSON: ' + text.slice(0, 120));
      }
      if (json.code !== 0) throw new Error(`API code=${json.code}: ${json.message || json.msg || '未知错误'}`);
      return json.data;
    } catch (e) {
      if (i === retries - 1 || e.message.includes('HTTP 401') || e.message.includes('HTTP 403') || e.message.includes('HTTP 429')) {
        throw e;
      }
      console.warn(`[retry] ${pathname} 第 ${i + 1} 次失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

function normalizeStock(it, i) {
  const heat = it.heat ?? it.hot_value ?? it.hot ?? it.score ?? it.value;
  const price = it.price ?? it.last_price ?? it.close_price ?? it.current_price;
  const chg = it.changePct ?? it.change_pct ?? it.price_change_ratio_pct ?? it.pct_chg ?? it.change_ratio;
  const thscode = it.thscode || '';
  return {
    rank: it.rank ?? i + 1,
    ticker: it.ticker || '',
    thscode,
    name: it.name || '',
    price: price != null && price !== '' ? Number(price) : null,
    changePct: chg != null && chg !== '' ? Number(chg) : null,
    heat: heat != null && heat !== '' ? Number(heat) : null,
    exchange: thscode.endsWith('.SH') ? '沪' : thscode.endsWith('.SZ') ? '深' : thscode.endsWith('.BJ') ? '北' : '',
  };
}

/* 把 "YYYY-MM-DD_HH-mm" 解析为东八区时间戳（毫秒），失败返回 NaN */
function parseRecordId(id) {
  const m = id && id.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const t = new Date(`${m[1]}T${m[2]}:${m[3]}:00+08:00`).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/* 同一小时只保留最后一条：id 形如 2026-11-08_17-46，前 13 位就是小时 */
function hourKeyOf(id) { return id.slice(0, 13); }
function pickHourlyIds(ids) {
  const m = new Map();
  for (const id of ids) m.set(hourKeyOf(id), id); // ids 升序，同小时后出现的覆盖前面
  return [...m.values()].sort();
}

/* ---------------- 抓取（按小时去重，每小时只落一条） ---------------- */
async function capture() {
  if (!API_KEY) throw new Error('缺少环境变量 FUYAO_API_KEY（仓库 Settings → Secrets → Actions）');

  const t = nowParts();
  const id = `${t.date}_${pad(t.hour)}-${pad(t.minute)}`;
  const hourKey = `${t.date}_${pad(t.hour)}`;

  const existingIds = listRecordIds();

  if (existingIds.length > 0) {
    const lastId = existingIds[existingIds.length - 1];
    const lastTime = parseRecordId(lastId);
    const gapMinutes = (Date.now() - lastTime) / 60000;

    // 主判断：本小时已经抓过 → 跳过。外部定时器每 15 分钟来一次也不怕，
    // 每个自然小时只会写入一条，时间点固定在该小时第一次触发附近。
    if (hourKeyOf(lastId) === hourKey) {
      console.log(`[skip] ${hourKey} 时已有记录 ${lastId}，本次跳过（每小时仅保留一条）`);
      return { skipped: true };
    }

    // 兜底：上次抓取若因延迟落在小时末尾，避免下一小时刚开始就又抓一条
    if (Number.isFinite(gapMinutes) && gapMinutes < 20) {
      console.log(`[skip] 距上次抓取 (${lastId}) 仅 ${gapMinutes.toFixed(0)} 分钟，跳过本次抓取`);
      return { skipped: true };
    }

    // 超过 90 分钟没有数据，说明定时任务可能被吞了
    if (Number.isFinite(gapMinutes) && gapMinutes > 90) {
      console.warn(`[warn] ⚠️ 数据断层！上一次抓取是 ${lastId}，距今已过去 ${gapMinutes.toFixed(0)} 分钟。`);
    }
  }

  // --- 以下为原有的抓取逻辑 ---
  const hot = await apiGet(API_HOT, { period: 'hour', limit: '100' });
  const list = hot && hot.item;
  if (!Array.isArray(list)) throw new Error('热榜返回结构异常');
  const rows = list.slice(0, 100).map(normalizeStock);

  const thscodes = rows.map((s) => s.thscode).filter(Boolean).join(',');
  if (thscodes) {
    try {
      const snap = await apiGet(API_SNAP, { thscodes });
      const map = new Map(((snap && snap.item) || []).map((s) => [s.thscode, s]));
      for (const s of rows) {
        const hit = map.get(s.thscode);
        if (hit) {
          if (hit.last_price != null) s.price = hit.last_price;
          s.changePct = hit.price_change_ratio_pct ?? hit.price_ratio_pct ?? s.changePct;
        }
      }
    } catch (e) {
      console.warn('[warn] 行情快照失败（涨幅/现价可能为空）:', e.message);
    }
  }

  const record = {
    id,
    sheetName: id,
    capturedAt: `${t.date} ${t.time}`,
    capturedAtIso: new Date().toISOString(),
    timezone: TZ,
    count: rows.length,
    rows,
  };

  if (DRY_RUN) {
    console.log(`[dry-run] ${id} 抓到 ${rows.length} 只，未写盘`);
    return { dryRun: true, record };
  }

  ensureDirs();
  writeJson(path.join(recordsDir(), `${id}.json`), record);
  console.log(`[ok] 记录 ${id}：${rows.length} 只 → data/records/${id}.json`);
  return { record };
}

/* ---------------- 生成当日 Excel ---------------- */
function buildDayWorkbook(date) {
  const ids = listRecordIds().filter((id) => id.startsWith(date));
  if (!ids.length) return null;

  const indexRows = [['工作表', '抓取时间', '股票数']];
  const sheets = [];
  for (const id of ids) {
    const rec = readJson(path.join(recordsDir(), `${id}.json`));
    if (!rec) continue;
    indexRows.push([rec.sheetName || id, rec.capturedAt || '', (rec.rows || []).length]);
    const rows = [SHEET_HEADER.slice()];
    for (const s of rec.rows || []) {
      rows.push([
        s.rank ?? '',
        s.ticker || '',
        s.name || '',
        s.price != null && Number.isFinite(s.price) ? s.price : '',
        s.changePct != null && Number.isFinite(s.changePct) ? s.changePct : '',
        s.heat != null && Number.isFinite(s.heat) ? s.heat : '',
        s.exchange || '',
        rec.capturedAt || '',
      ]);
    }
    sheets.push({ name: rec.sheetName || id, rows, widths: SHEET_WIDTHS });
  }
  if (!sheets.length) return null;
  return buildWorkbook([{ name: '索引', rows: indexRows, widths: [22, 20, 8] }, ...sheets]);
}

function writeDayWorkbook(date) {
  const buf = buildDayWorkbook(date);
  if (!buf) return null;
  const file = path.join(exportsDir(), `${date}.xlsx`);
  fs.writeFileSync(file, buf);
  const size = (buf.length / 1024).toFixed(0);
  console.log(`[ok] 导出 exports/${date}.xlsx（${size} KB）`);
  return file;
}

/* ---------------- 排名时序数据（Bump Chart 排位赛图用） ---------------- */

// 高区分度调色板（按 ticker 哈希稳定取色，保证刷新时颜色不漂移）
const PALETTE = [
  '#e24b4a', '#378add', '#1d9e75', '#d4537e', '#ba7517', '#7f77dd',
  '#639922', '#d85a30', '#185fa5', '#993556', '#0f6e56', '#854f0b',
  '#3c3489', '#5f5e5a', '#ed93b1', '#85b7eb', '#97c459', '#f09595',
  '#5dcaa5', '#888780', '#ef9f27', '#a32d2d', '#534ab7', '#3b6d11',
  '#e2579f', '#0c447c', '#712b13', '#26215c', '#b34a90', '#4a1b0c',
];

function hashIndex(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const stockKey = (s) => s.ticker || s.thscode || s.name;

export function buildRankTimeline(topN = 30, windowHours = 24) {
  // 历史密集记录（早期 15 分钟轮询 / 旧 bug 重复触发）按小时合并，看板每小时一个点
  const ids = pickHourlyIds(listRecordIds());
  const now = Date.now();
  const windowMs = windowHours * 3600 * 1000;

  const records = [];
  for (const id of ids) {
    const t = parseRecordId(id);
    if (!Number.isFinite(t) || now - t > windowMs) continue;
    const rec = readJson(path.join(recordsDir(), `${id}.json`));
    if (!rec || !Array.isArray(rec.rows)) continue;
    records.push({ t, rec });
  }
  records.sort((a, b) => a.t - b.t);
  const times = records.map((r) => r.rec.capturedAt || '');

  // 候选：近窗口内任一时刻进入过前 topN 的股票
  const cand = new Map();
  for (const { rec } of records) {
    for (const s of rec.rows) {
      if (s.rank != null && s.rank <= topN) {
        const key = stockKey(s);
        if (key && !cand.has(key)) {
          cand.set(key, { ticker: s.ticker || '', name: s.name || '', exchange: s.exchange || '' });
        }
      }
    }
  }

  const stocks = [];
  for (const [key, info] of cand) {
    const ranks = records.map(({ rec }) => {
      const s = rec.rows.find((x) => stockKey(x) === key);
      return s && s.rank != null && s.rank <= topN ? s.rank : null;
    });

    let lastRank = null;
    let lastChangePct = null;
    for (let i = ranks.length - 1; i >= 0; i--) {
      if (ranks[i] != null) {
        lastRank = ranks[i];
        const s = records[i].rec.rows.find((x) => stockKey(x) === key);
        lastChangePct = s && s.changePct != null && Number.isFinite(s.changePct) ? s.changePct : null;
        break;
      }
    }

    let bestRank = 9999;
    for (const r of ranks) if (r != null && r < bestRank) bestRank = r;

    stocks.push({ ...info, color: PALETTE[hashIndex(key) % PALETTE.length], ranks, lastRank, lastChangePct, bestRank });
  }

  // 排序：当前在榜的按最新排名升序在前；已跌出的按历史最佳排名接在后面
  stocks.sort((a, b) => {
    const la = a.lastRank == null ? 100000 + a.bestRank : a.lastRank;
    const lb = b.lastRank == null ? 100000 + b.bestRank : b.lastRank;
    return la - lb;
  });

  return {
    updatedAt: new Date().toISOString(),
    windowHours,
    topN,
    times,
    total: stocks.length,
    stocks,
  };
}

function writeBump() {
  const data = buildRankTimeline(30, 24);
  const file = path.join(recordsDir(), '..', 'bump.json');
  writeJson(file, data);
  console.log(`[ok] 生成排名时序 data/bump.json（${data.total} 只 / ${data.times.length} 个时刻）`);

  // 同步一份到 docs/，供 GitHub Pages 可视化看板读取
  const root = path.resolve(recordsDir(), '..', '..');
  const docFile = path.join(root, 'docs', 'bump.json');
  writeJson(docFile, data);
  console.log(`[ok] 同步看板数据 docs/bump.json`);
  return file;
}

/* ---------------- 各时刻完整榜单快照（看板在线查看用） ---------------- */
/* ---------------- 榜单明细：全量时刻索引 + 按需加载的单条快照 ---------------- */
/* 不再把所有时刻塞进一个大 JSON（会随历史线性膨胀），改为：
   docs/times.json            全量时刻列表（最新在前，含完整日期）
   docs/records/<id>.json     单个时刻的 100 只股票，页面点选时才请求
   每次抓取只新增/更新一个文件，历史全部可选。                          */
export function writeRecordFeed() {
  const ids = listRecordIds(); // 全量历史，不截断
  const root = path.resolve(recordsDir(), '..', '..');
  const outDir = path.join(root, 'docs', 'records');
  fs.mkdirSync(outDir, { recursive: true });

  const num2 = (v) => (v != null && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const times = [];

  for (const id of ids) {
    const rec = readJson(path.join(recordsDir(), `${id}.json`));
    if (!rec || !Array.isArray(rec.rows)) continue;
    const m = id.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/);
    const time = rec.capturedAt || (m ? `${m[1]} ${m[2]}:${m[3]}` : id);

    // 数组代替对象压缩体积：[排名, 代码, 名称, 现价, 涨幅, 热度, 市场]
    const rows = rec.rows.map((s) => [
      s.rank,
      s.ticker || '',
      s.name || '',
      num2(s.price),
      num2(s.changePct),
      s.heat != null && Number.isFinite(s.heat) ? Math.round(s.heat) : null,
      s.exchange || '',
    ]);

    const json = JSON.stringify({
      id, time,
      fields: ['rank', 'code', 'name', 'price', 'chg', 'heat', 'ex'],
      rows,
    });
    // 内容没变就不重写，避免每小时把全量历史文件全部改动一遍
    const target = path.join(outDir, `${id}.json`);
    let changed = true;
    try { changed = fs.readFileSync(target, 'utf8') !== json; } catch { /* 文件不存在 */ }
    if (changed) fs.writeFileSync(target, json, 'utf8');

    times.push({ id, time, count: rows.length });
  }

  times.reverse(); // 最新在前
  const index = { updatedAt: new Date().toISOString(), total: times.length, times };
  const idxJson = JSON.stringify(index);
  fs.writeFileSync(path.join(root, 'docs', 'times.json'), idxJson, 'utf8');
  fs.writeFileSync(path.join(recordsDir(), '..', 'times.json'), idxJson, 'utf8');

  // 已被 pruneOld 清理的记录，同步删掉对应的快照文件
  const keep = new Set(ids.map((id) => `${id}.json`));
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith('.json') && !keep.has(f)) {
      try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ }
    }
  }

  // 迁移：移除旧版聚合快照（已被上面的拆分格式取代）
  for (const f of [path.join(recordsDir(), '..', 'snapshots.json'), path.join(root, 'docs', 'snapshots.json')]) {
    try { fs.unlinkSync(f); } catch { /* 已删除 */ }
  }

  console.log(`[ok] 生成榜单明细 docs/times.json（${times.length} 个时刻 / 全量历史）`);
  return index;
}

/* ---------------- 主流程（修复了索引与清理的顺序） ---------------- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const r = await capture();
    if (!DRY_RUN && !r.skipped) {
      const t = nowParts();
      // 先清理旧数据
      const removed = pruneOld(KEEP_DAYS);
      if (removed) console.log(`[ok] 清理 ${removed} 条超过 ${KEEP_DAYS} 天的记录`);

      const removedXlsx = pruneOldExports(KEEP_DAYS);
      if (removedXlsx) console.log(`[ok] 清理 ${removedXlsx} 个过期 Excel`);

      // 再重建索引
      const items = rebuildIndex();
      console.log(`[ok] 索引已更新：共 ${items.length} 条记录`);

      // 再生成排名时序数据
      writeBump();

      // 再生成榜单明细索引 + 全量单条快照（看板在线查看）
      writeRecordFeed();

      // 最后生成 Excel
      if (!r.dryRun) writeDayWorkbook(t.date);
    }
  } catch (e) {
    console.error('[fail]', e.message);
    process.exit(1);
  }
}
