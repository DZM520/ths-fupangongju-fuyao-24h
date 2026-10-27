/**
 * 同花顺热榜 · GitHub Actions 定时抓取
 * 零依赖：只用 Node 内置 fetch / fs（Node >= 20）
 *
 * 环境变量：
 *   FUYAO_API_KEY  必填，扶摇 API Key
 *   TZ             可选，默认 Asia/Shanghai（脚本内也显式按东八区取时间）
 *   KEEP_DAYS      可选，记录保留天数，默认 400；<=0 表示永久保留
 *   DRY_RUN        可选，=1 时只抓取、不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkbook } from './lib/xlsx.mjs';
import {
  ensureDirs,
  exportsDir,
  listRecordIds,
  pruneOld,
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

/* ---------------- API ---------------- */
async function apiGet(pathname, params) {
  const url = new URL(pathname, FUYAO_BASE);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: { 'X-api-key': API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await resp.text();
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

/* ---------------- 抓取 ---------------- */
async function capture() {
  if (!API_KEY) throw new Error('缺少环境变量 FUYAO_API_KEY（仓库 Settings → Secrets → Actions）');

  const t = nowParts();
  const id = `${t.date}_${pad(t.hour)}-${pad(t.minute)}`;
  const hourKey = `${t.date}_${pad(t.hour)}`;
  const already = listRecordIds().some((x) => x.startsWith(hourKey));
  if (already) {
    console.log(`[skip] 本小时（${hourKey}）已有记录，跳过`);
    return { skipped: true };
  }

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
          if (hit.price_ratio_pct != null) s.changePct = hit.price_ratio_pct;
          if (hit.price_change_ratio_pct != null) s.changePct = hit.price_change_ratio_pct;
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

/* ---------------- 主流程 ---------------- */
try {
  const r = await capture();
  if (!DRY_RUN && !r.skipped) {
    const t = nowParts();
    const items = rebuildIndex();
    console.log(`[ok] 索引已更新：共 ${items.length} 条记录`);
    if (!r.dryRun) writeDayWorkbook(t.date);
    const removed = pruneOld(KEEP_DAYS);
    if (removed) console.log(`[ok] 清理 ${removed} 条超过 ${KEEP_DAYS} 天的记录`);
  }
} catch (e) {
  console.error('[fail]', e.message);
  process.exit(1);
}
