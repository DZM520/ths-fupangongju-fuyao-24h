/**
 * 连板情绪 · GitHub Actions 定时抓取
 * 零依赖：复用 lib/limit-pool.cjs（东方财富公开接口，无需 API Key）
 *
 * 环境变量：
 *   TZ_OVERRIDE  可选，默认 Asia/Shanghai
 *   KEEP_DAYS    可选，快照保留天数，默认 3650；<=0 永久保留
 *   DRY_RUN      可选，=1 时只抓取、不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 本脚本在 scripts/ 下，回退一级即仓库根（对比 store.mjs 在 scripts/lib/ 下需回退两级）
const ROOT = path.resolve(HERE, '..');
const LIMIT_DIR = path.join(ROOT, 'data', 'limit');
const require = createRequire(import.meta.url);
const { fetchSnapshot } = require('./lib/limit-pool.cjs');

const TZ = process.env.TZ_OVERRIDE || 'Asia/Shanghai';
const DRY_RUN = process.env.DRY_RUN === '1';
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 3650);
const pad = (n) => String(n).padStart(2, '0');

function nowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: p.hour, mm: p.minute };
}

function listIds() {
  try {
    return fs.readdirSync(LIMIT_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
}

function pruneOld() {
  if (!KEEP_DAYS || KEEP_DAYS <= 0) return 0;
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const id of listIds()) {
    const d = Date.parse(`${id.slice(0, 10)}T00:00:00+08:00`);
    if (Number.isFinite(d) && d < cutoff) {
      try { fs.unlinkSync(path.join(LIMIT_DIR, `${id}.json`)); removed++; } catch {}
    }
  }
  return removed;
}

function rebuildIndex() {
  const ids = listIds().slice().reverse();
  const items = ids.map((id) => {
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(path.join(LIMIT_DIR, `${id}.json`), 'utf8')); } catch {}
    const m = (snap && snap.sentiment) || {};
    return { id, capturedAt: snap?.capturedAt || id, tradeDate: snap?.tradeDate || '', score: m.score ?? null, level: m.level || '' };
  });
  fs.mkdirSync(LIMIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'limit-index.json'), JSON.stringify({
    updatedAt: new Date().toISOString(), total: items.length, items,
  }), 'utf8');
  return items;
}

// 保存策略：只在「交易日收盘后」落盘一条 <日期>_15-05；
// 主 workflow 每 15 分钟跑一次，窗口放宽到 15:00~16:00 防止 15:00 那次早于收盘漏抓，
// 其它时间一律只查看、不保存。id 固定 15-05，靠文件存在去重（同一天最多一条）。
const CLOSE_START = 15 * 60;   // 15:00 起即可进入（含 15:00 触发的任务）
const CLOSE_END = 16 * 60;

try {
  const t = nowParts();
  const mins = Number(t.hh) * 60 + Number(t.mm);

  // 非收盘窗口：直接跳过，不抓不存（省接口调用）
  if (mins < CLOSE_START || mins >= CLOSE_END) {
    console.log(`[skip] 当前 ${t.hh}:${t.mm} 不在收盘窗口 15:00~16:00，不保存`);
    process.exit(0);
  }

  const id = `${t.date}_15-05`;
  if (listIds().includes(id)) {
    console.log(`[skip] 今日收盘快照 ${id} 已存在，跳过`);
    process.exit(0);
  }

  const snap = await fetchSnapshot(new Date());
  const m = snap.sentiment || {};
  // 交易日判断：东财节假日回退到最近交易日（staleDays>0 / tradeDate≠今天）则非交易日，不保存
  const todayCompact = t.date.replace(/-/g, '');
  const tradeDay = String(snap.tradeDate || '').replace(/-/g, '') === todayCompact && !(snap.staleDays > 0);

  if (!tradeDay) {
    console.log(`[skip] 今日非交易日（tradeDate=${snap.tradeDate}, staleDays=${snap.staleDays}），不保存`);
    process.exit(0);
  }

  snap.id = id;
  snap.reason = 'close';
  if (DRY_RUN) {
    console.log(`[dry-run] ${id} 涨停=${m.limitUp} 炸板=${m.brokenCount} 情绪=${m.score}`);
  } else {
    fs.mkdirSync(LIMIT_DIR, { recursive: true });
    const file = path.join(LIMIT_DIR, `${id}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
    fs.renameSync(tmp, file);
    const items = rebuildIndex();
    const removed = pruneOld();
    console.log(`[ok] 连板情绪收盘 ${id}：涨停 ${m.limitUp} · 炸板 ${m.brokenCount}(${m.brokenRate}%) · 最高 ${m.maxStreak} 板 · 情绪 ${m.score}(${m.level}) → data/limit/${id}.json`);
    console.log(`[ok] 索引 data/limit-index.json：共 ${items.length} 条${removed ? `，清理 ${removed} 条超期` : ''}`);
  }
} catch (e) {
  console.error('[fail]', e.message);
  process.exit(1);
}
