import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openReadonly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export function tableRowCounts(path) {
  if (!existsSync(path)) return null;
  const database = openReadonly(path);
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    return Object.fromEntries(tables.map(({ name }) => [
      name,
      Number(database.prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count),
    ]));
  } finally {
    database.close();
  }
}

export function sqliteSnapshots(stateDirectory) {
  if (!existsSync(stateDirectory)) return {};
  const names = readdirSync(stateDirectory)
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  return Object.fromEntries(names.map((name) => [basename(name), tableRowCounts(join(stateDirectory, name))]));
}

export function sameSnapshots(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function changedTables(before, after) {
  const changed = [];
  for (const database of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = before[database] ?? {};
    const right = after[database] ?? {};
    for (const table of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (left[table] !== right[table]) changed.push(`${database}:${table}`);
    }
  }
  return changed.sort();
}
