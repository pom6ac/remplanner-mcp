// 142: живая проверка свободных концов на dev-объекте (ID только из env, inline).
// Схема: бэкап (model_get full) → control GET до → project_open → baseline validate →
// свободная перегородка (kind=partition) + свободная стена (initial) вне контура →
// в ответе предупреждение wall_free_ends (мм) → model_validate (WALL_DANGLING —
// информационные) → project_save (ожидаем verified=true) → reopen → обе стены на
// месте с несоединёнными концами → wall_delete созданных → project_save (verified)
// → GET-сверка с бэкапом (исключения: session/log_plan/logs, id комнат и id граней
// eds2 — редактор перегенерирует при каждом save; комнаты по содержимому, сортировка
// по контуру) → control GET после — байт-в-байт без служебных полей.
// Watchdog 8 минут, таймауты, finally closeBrowser, явный process.exit.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { loadModel } from "../../src/api.ts";
import { loadSession, type SessionState } from "../../src/session.ts";
import { STATE_PATH } from "../../src/config.ts";
import { refuseLegacyProbe } from "./probe-guard.ts";
refuseLegacyProbe(); // 322 N3г: старая пишущая проба без гардов — запуск запрещён

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID || !SNAP_ID || !SNAP_PLAN) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN и REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });

setTimeout(() => { console.error("WATCHDOG"); process.exit(9); }, 8 * 60_000).unref();

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} (${ms} мс)`)), ms)),
  ]);
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await withTimeout(client.callTool({ name, arguments: args }), 180_000, name);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 800)}`);
  return JSON.parse(text(res as never));
}

const session: SessionState = loadSession(STATE_PATH);

/** Ключи сессии и служебные логи в файлы-дампы не пишем. */
function sanitizeForFile(m: AnyRec): AnyRec {
  const c = structuredClone(m);
  for (const k of ["session", "log_plan", "logs"]) delete c[k];
  return c;
}

// ---- сверка с бэкапом: канонизация (исключения перечислены в отчёте) ----
type AnyRec = Record<string, any>;
/** Округление до 0,01 см для устойчивой сортировки комнат по контуру. */
const rr = (n: number) => Math.round(n * 100) / 100;
function canonRooms(rooms: AnyRec | undefined): string {
  const list = Object.entries<AnyRec>(rooms ?? {}).map(([id, r]) => {
    const c: AnyRec = structuredClone(r);
    delete c.id;
    // производные поля, перегенерируемые редактором при каждом save:
    // id зон/рёбер комнаты, порядковый номер зоны по площади, флаги примыкания комнат
    for (const z of c.zones ?? []) { delete z.id; delete z.number_by_area; }
    for (const e of c.edges ?? []) delete e.id;
    for (const w of Object.values<AnyRec>(c.walls ?? {})) { delete w.room_on_left; delete w.room_on_right; }
    return { key: JSON.stringify((c.polygon ?? []).map((p: any) => [rr(p.x), rr(p.y)])), body: c };
  });
  list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return JSON.stringify(list.map((x) => x.body));
}
function canonModel(m: AnyRec): AnyRec {
  const c: AnyRec = structuredClone(m);
  for (const k of ["session", "log_plan", "logs"]) delete c[k];
  // id комнат перегенерируются при каждом save — комнаты сверяются по содержимому
  delete c.rooms1;
  delete c.rooms2;
  c.__rooms1 = canonRooms(m.rooms1);
  c.__rooms2 = canonRooms(m.rooms2);
  // id граней стен (eds2.*.*.id) перегенерируются при каждом пересчёте комнат;
  // room_on_left/right — производные флаги примыкания, редактор пересчитывает их
  // при каждом save (в пробе 0 ↔ true без изменения геометрии)
  for (const w of Object.values<AnyRec>(c.walls ?? {})) {
    const eds = w.eds2 as AnyRec | undefined;
    if (eds) {
      for (const side of ["l", "r", "s", "e", "sl"] as const) {
        for (const e of eds[side] ?? []) delete e.id;
      }
    }
    delete w.room_on_left;
    delete w.room_on_right;
  }
  return c;
}
function deepDiff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 10) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} ≠ ${JSON.stringify(b)?.slice(0, 60)}`);
    return;
  }
  const ka = new Set(Object.keys(a as AnyRec));
  const kb = new Set(Object.keys(b as AnyRec));
  for (const k of new Set([...ka, ...kb])) {
    deepDiff((a as AnyRec)[k], (b as AnyRec)[k], `${path}.${k}`, out);
  }
}

async function main() {
  // 0. control GET до
  const snapBefore = await withTimeout(loadModel(session, SNAP_ID!, SNAP_PLAN!), 60_000, "control GET before");

  // 1. бэкап dev-объекта
  const ctxMod = await import("../../src/server/context.ts");
  const serverMod = await import("../../src/server.ts");
  const ctxObj = new (ctxMod.ServerContext as any)();
  const server = serverMod.buildServer(ctxObj);
  const client = new Client({ name: "142-free-ends", version: "0.0.0" });
  const [ta, tb] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ta), client.connect(tb)]);

  console.log("open dev project…");
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const backup = await call(client, "model_get", { detail: "full" });
  writeFileSync(`${OUT}/142-free-backup.json`, JSON.stringify(sanitizeForFile(backup), null, 1) + "\n");
  const baseline = await call(client, "model_validate");
  console.log("baseline validate:", JSON.stringify(baseline).slice(0, 400));
  const dangBefore = (baseline.problems ?? []).filter((p: any) => p.code === "WALL_DANGLING").length;
  console.log("WALL_DANGLING до:", dangBefore);

  // место для свободных стен — правее и ниже габарита всех стен
  const walls = backup.walls as Record<string, AnyRec>;
  let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of Object.values<AnyRec>(walls)) {
    for (const p of [w.p1, w.p2]) {
      maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const xMm = Math.round((maxX + 200) * 10); // 2 м правее габарита
  const y1Mm = Math.round(minY * 10), y2Mm = Math.round((minY + 150) * 10);

  // 2. свободная перегородка (kind=partition) — ожидаем wall_free_ends в ответе
  const part = await call(client, "wall_add", {
    start: { x: xMm, y: y1Mm }, end: { x: xMm, y: y2Mm }, kind: "partition", material: "gypsum",
  });
  const partWarnings = part.warnings ?? [];
  console.log("partition added:", JSON.stringify(part.entity?.id ?? part.id), "warnings:", JSON.stringify(partWarnings));
  if (!partWarnings.some((w: string) => w.startsWith("wall_free_ends"))) {
    throw new Error("в ответе wall_add нет предупреждения wall_free_ends");
  }

  // 3. свободная стена (initial) ниже перегородки
  const wall = await call(client, "wall_add", {
    start: { x: xMm, y: y2Mm + 2000 }, end: { x: xMm + 3000, y: y2Mm + 2000 },
  });
  const wallWarnings = wall.warnings ?? [];
  console.log("wall added:", JSON.stringify(wall.entity?.id ?? wall.id), "warnings:", JSON.stringify(wallWarnings));
  if (!wallWarnings.some((w: string) => w.startsWith("wall_free_ends"))) {
    throw new Error("в ответе wall_add (initial) нет предупреждения wall_free_ends");
  }

  // 4. validate: WALL_DANGLING — информационные
  const val = await call(client, "model_validate");
  const dangNew = (val.problems ?? []).filter((p: any) => p.code === "WALL_DANGLING");
  console.log("WALL_DANGLING после добавления:", dangNew.length, "(было", dangBefore, ")");
  if (dangNew.length !== dangBefore + 4) throw new Error(`ожидалось +4 WALL_DANGLING, получено ${dangNew.length - dangBefore}`);

  // 5. save с несоединёнными стенами — ключевой шаг
  const saved = await call(client, "project_save");
  console.log("save:", JSON.stringify({ verified: saved.verified, rounds: saved.rounds, save_id: saved.save_id, warnings: saved.warnings }));
  if (saved.verified !== true) throw new Error(`save не verified: ${JSON.stringify(saved).slice(0, 500)}`);

  // 6. reopen: обе свободные стены на месте с несоединёнными концами
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await call(client, "model_get", { detail: "full" });
  writeFileSync(`${OUT}/142-free-after-reopen.json`, JSON.stringify(sanitizeForFile(after), null, 1) + "\n");
  const freeWalls = Object.entries<AnyRec>(after.walls).filter(([, w]) => !w.p1.link && !w.p2.link);
  console.log("свободные стены после reopen:", JSON.stringify(freeWalls.map(([id, w]) => ({ id, plan: w.plan, material: w.material, depth: w.depth }))));
  if (freeWalls.length < 2) throw new Error(`свободных стен после reopen ${freeWalls.length}, ожидалось 2`);
  const partBack = freeWalls.find(([, w]) => w.plan === "c" && w.material === "c_gypsum");
  const wallBack = freeWalls.find(([, w]) => w.plan === "a" && w.material === "a_block");
  if (!partBack || !wallBack) throw new Error(`не найдены созданные стены: ${JSON.stringify(freeWalls.map(([id, w]) => [id, w.plan, w.material]))}`);
  const pt = partBack[1];
  const gotAxis = { x1: pt.p1.x, y1: pt.p1.y, x2: pt.p2.x, y2: pt.p2.y };
  console.log("перегородка после reopen, ось см:", JSON.stringify(gotAxis));

  // 7. удаление созданных стен
  await call(client, "wall_delete", { wall_id: partBack[0] });
  await call(client, "wall_delete", { wall_id: wallBack[0] });
  await new Promise((r) => setTimeout(r, 5200)); // ≤1 сохранения в 5 с
  const saved2 = await call(client, "project_save");
  console.log("save после удаления:", JSON.stringify({ verified: saved2.verified, rounds: saved2.rounds, warnings: saved2.warnings }));
  if (saved2.verified !== true) throw new Error(`повторный save не verified: ${JSON.stringify(saved2).slice(0, 500)}`);

  // 8. сверка с бэкапом
  const finalModel = await call(client, "model_get", { detail: "full" });
  writeFileSync(`${OUT}/142-free-final.json`, JSON.stringify(sanitizeForFile(finalModel), null, 1) + "\n");
  const cb = canonModel(backup);
  const cf = canonModel(finalModel);
  const diff: string[] = [];
  deepDiff(cb, cf, "model", diff);
  console.log("расхождения с бэкапом:", diff.length === 0 ? "НЕТ" : JSON.stringify(diff, null, 1));
  const valFinal = await call(client, "model_validate");
  console.log("validate в конце:", JSON.stringify(valFinal).slice(0, 300));
  writeFileSync(`${OUT}/142-free-check.json`, JSON.stringify({
    dang_before: dangBefore, dang_after_add: dangNew.length,
    save1: { verified: saved.verified, rounds: saved.rounds },
    save2: { verified: saved2.verified, rounds: saved2.rounds },
    free_after_reopen: freeWalls.map(([id, w]) => ({ id, plan: w.plan, material: w.material })),
    backup_diff: diff, validate_final: valFinal,
  }, null, 1) + "\n");

  await client.close().catch(() => {});

  // 9. control GET после — не изменился
  const snapAfter = await withTimeout(loadModel(session, SNAP_ID!, SNAP_PLAN!), 60_000, "control GET after");
  const strip = (m: AnyRec) => { const c = structuredClone(m); for (const k of ["session", "log_plan", "logs"]) delete c[k]; return c; };
  const same = JSON.stringify(strip(snapBefore.model)) === JSON.stringify(strip(snapAfter.model));
  console.log("контрольный проект:", same ? "НЕ ИЗМЕНИЛСЯ" : "ИЗМЕНИЛСЯ (расхождение!)");
  if (!same) throw new Error("контрольный проект изменился");

  console.log("DONE");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
