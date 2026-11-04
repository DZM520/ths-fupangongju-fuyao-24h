import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function recordsDir() {
  return path.join(ROOT, 'data', 'records');
}
export function exportsDir() {
  return path.join(ROOT, 'exports');
}
export function indexPath() {
  return path.join(ROOT, 'data', 'index.json');
}
export function ensureDirs() {
  fs.mkdirSync(recordsDir(), { recursive: true });
  fs.mkdirSync(exportsDir(), { recursive: true });
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 使用 Pretty Print 格式化，方便查看和 diff
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function listRecordIds() {
  try {
    return fs
      .readdirSync(recordsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export function rebuildIndex() {
  const ids = listRecordIds().slice().reverse();
  const items = [];
  for (const id of ids) {
    const rec = readJson(path.join(recordsDir(), `${id}.json`));
    if (!rec) continue;
    items.push({ id, capturedAt: rec.capturedAt, count: rec.count ?? (rec.rows || []).length });
  }
  writeJson(indexPath(), { updatedAt: new Date().toISOString(), total: items.length, items });
  return items;
}

export function pruneOld(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const id of listRecordIds()) {
    const d = Date.parse(`${id.slice(0, 10)}T00:00:00+08:00`);
    if (Number.isFinite(d) && d < cutoff) {
      try {
        fs.unlinkSync(path.join(recordsDir(), `${id}.json`));
        removed++;
      } catch {}
    }
  }
  return removed;
}

export function pruneOldExports(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(exportsDir())) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.xlsx$/);
      if (!m) continue;
      const d = Date.parse(`${m[1]}T00:00:00+08:00`);
      if (Number.isFinite(d) && d < cutoff) {
        try { fs.unlinkSync(path.join(exportsDir(), f)); removed++; } catch {}
      }
    }
  } catch {}
  return removed;
}
