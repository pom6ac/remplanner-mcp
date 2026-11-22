// 384: сверка ТОЛЬКО ЧТЕНИЕ (задание 384, п. 2) — GET текущей модели dev-объекта
// (без записи и без save) и сверка с бэкапом backup-<OBJECT_ID>-382.json по
// ИСПРАВЛЕННОМУ канону sig (фикс ревью 383 №28). Финальная сверка прогонов 382
// шла по ослабленному канону, скрывавшему пользовательские данные отделки.
// Расхождения канон — field-by-field пути (значения не печатаются), отчёт —
// .orca-reports/tmp/384-restore-check.log. ID — ТОЛЬКО из env командной строки.
// Гарды: probeWriteEnv + assertTargetPair (GET пары, плана, model.id/plan_id);
// записей нет, restore не нужен.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/384-restore-check.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { type LoadedModel } from "../../src/api.ts";
import { canon, sig } from "./probe-sig.ts";

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "384-restore-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const log: string[] = [];
const out = (s: string): void => {
  console.log(s);
  log.push(s);
};
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 10 * 60_000).unref();

let exitCode = 0;
try {
  const { probeWriteEnv, assertTargetPair } = await import("./probe-guard.ts");
  const ids = probeWriteEnv();
  const backupPath = `.orca-reports/backup-${ids.objectId}-382.json`;
  if (!existsSync(backupPath)) {
    out(`FAIL: бэкап не найден: ${backupPath}`);
    process.exit(1);
  }
  const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
  out(`бэкап: ${backupPath} (save_id=${ref.save_id})`);
  // гард пары + сам GET текущей модели (единственный запрос записи не делает)
  const got = await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  out(`GET: object_id=${got.object_id} plan_id=${got.plan_id} save_id=${got.save_id}`);
  const same = sig(got.model) === sig(ref.model);
  out(`sig (исправленный канон 384): ${same ? "СОВПАДАЕТ" : "РАСХОЖДЕНИЕ"}`);
  if (!same) {
    // канонический дифф: пути (без значений), до 30 первых
    type AnyRec = Record<string, unknown>;
    const paths: string[] = [];
    const walk = (a: unknown, b: unknown, p: string): void => {
      if (paths.length >= 30) return;
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
        const keys = [...new Set([...Object.keys(a as AnyRec), ...Object.keys(b as AnyRec)])].sort();
        for (const k of keys) {
          if (paths.length >= 30) return;
          walk((a as AnyRec)[k], (b as AnyRec)[k], `${p}.${k}`);
        }
        return;
      }
      const kind = (x: unknown): string => (x === undefined ? "нет" : Array.isArray(x) ? `массив(${(x as unknown[]).length})` : typeof x);
      paths.push(`${p}: в бэкапе ${kind(a)}, сейчас ${kind(b)}`);
    };
    walk(canon(ref.model), canon(got.model), "model");
    out(`канонический дифф (пути, значения не печатаются, до 30):`);
    for (const p of paths) out(`  - ${p}`);
    if (paths.length >= 30) out("  - … (обрезано)");
    exitCode = 1;
  }
} catch (e) {
  out(`FAIL: ${String((e as Error).message ?? e).slice(0, 500)}`);
  exitCode = 1;
}
await client.close().catch(() => {});
try { await closeBrowser(); } catch { /* */ }
writeFileSync(".orca-reports/tmp/384-restore-check.log", log.join("\n") + "\n");
process.exit(exitCode);
