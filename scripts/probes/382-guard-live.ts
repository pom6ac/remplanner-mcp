// 382: живая проверка ИБ-фикса ревью 380 в dev-объекте (ID — ТОЛЬКО из env
// командной строки, в файлы и коммиты не писать). По заданию 382, п. 4:
// только БЕЗОПАСНЫЕ данные — открытие, render_plan, wall-мутация (wall_move
// туда и обратно), save verified, reopen — регрессий от перехвата ответа
// модели (page.route, major 380 №21) и детектора по типу (№22) нет.
// ОПАСНЫЕ строки на сайт НЕ отправляются ни в каком виде (их отказ закреплён
// офлайн-тестами tests/unit/382-editor-guard.test.ts).
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону
// БЕЗ REF_INIT — эталон уже существует), checkEditorPlanMatch fail-closed
// перед каждым project_open, assertUnchanged перед каждой записью, бэкап
// backup-<OBJECT_ID>-382.json непосредственно перед ПЕРВЫМ прогоном (не
// перезаписывается), sig модели в конце и в catch, restore в finally (384,
// ревью 383 №29: если после save стена осталась сдвинутой — wall_move назад +
// save verified), ≤30 запросов/мин (лимитер MCP), save не чаще раза в 5 с. Лог КАЖДОГО прогона — .orca-reports/tmp/382-<n>.log.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/382-guard-live.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { signedWallShiftMm, restoreDecision } from "./probe-wall-restore.ts";
import { assertEditorPlanMatch } from "./probe-guard.ts";

mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "382-guard-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/382-last-error.json", text(res));
    throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  }
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
const fails: string[] = [];
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) { fails.push(msg); exitCode = 1; }
};
const editorOf = (): Parameters<typeof assertEditorPlanMatch>[0] | null =>
  (ctx as unknown as { workspaceOrNull: { editorOrNull: () => Parameters<typeof assertEditorPlanMatch>[0] | null } | null }).workspaceOrNull?.editorOrNull?.() ?? null;

type CompactWall = { site_id: string; id?: string; from: [number, number]; to: [number, number]; len_mm: number; openings: unknown[] };
const wallsOf = (mg: Record<string, unknown>): CompactWall[] =>
  (Array.isArray(mg["walls"]) ? mg["walls"] : Object.values((mg["walls"] ?? {}) as Record<string, CompactWall>)) as CompactWall[];

/** Расстояние между осями (первая точка исходной и текущей стены), мм. */
const shiftMm = (w0: CompactWall, w1: CompactWall): number =>
  Math.hypot(w1.from[0] - w0.from[0], w1.from[1] - w0.from[1]);

// область видимости для finally (384, ревью 383 №29 — restore по журналу в finally)
let wall0: CompactWall | null = null;
let roGuard: Awaited<ReturnType<typeof import("./probe-guard.ts")["readonlyGuard"]>> | null = null;
let gsave: (tag: string) => Promise<Record<string, unknown>> = async () => {
  throw new Error("gsave не инициализирован (падение до первого save)");
};

try {
  const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } = await import("./probe-guard.ts");
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  gsave = async (tag: string): Promise<Record<string, unknown>> => {
    await roGuard!.assertUnchanged(tag);
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[]; details?: unknown };
    console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: (r["warnings"] ?? []).length }));
    if (!r["verified"]) throw new Error(`save ${tag} не verified: ${JSON.stringify(r["details"] ?? r).slice(0, 500)}`);
    await delay(5500);
    return r;
  };
  // бэкап НЕ перезаписывается между прогонами: базис до ПЕРВОГО прогона 382;
  // копия на прогон — в tmp со штампом времени
  const backupPath = `.orca-reports/backup-${ids.objectId}-382.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/382-backup-${stamp}.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) {
    console.log("backup exists — НЕ перезаписывается:", backupPath);
  } else {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written (первый прогон):", backupPath, "sig:", sig(before.model).slice(0, 40));
  }
  writeFileSync(stampPath, JSON.stringify(before, null, 1) + "\n");
  await roGuard.assertUnchanged("before");

  // ==== открытие (путь major 380 №21: страницу грузит серверная модель) ====
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  const ed = editorOf();
  console.log("editor:", ed ? "создан" : "НЕТ");
  await assertEditorPlanMatch(ed, ids.planId);
  console.log("гард «план в редакторе == серверу» (fail-closed): OK");
  check(ed !== null, "открытие + render_plan: редактор создан, перехват ответа модели пропустил безопасную модель");

  // ==== wall-мутация туда: +20 мм, save verified ====
  const mg0 = await call("model_get", {}) as Record<string, unknown>;
  // стена без проёмов — возврат смещением назад точно восстановит ось
  const candidates = wallsOf(mg0).filter((w) => Array.isArray(w.openings) && w.openings.length === 0);
  wall0 = candidates[0] ?? null;
  check(wall0 !== null, `выбрана стена без проёмов для мутации (всего стен: ${wallsOf(mg0).length}, без проёмов: ${candidates.length})`);
  if (wall0 === null) throw new Error("нет стены без проёмов — сцена прервана");
  const wall = wall0;
  console.log("wall:", wall.site_id, "from", wall.from, "to", wall.to, "len", wall.len_mm);

  await call("wall_move", { wall_id: wall.site_id, offset_mm: 20 });
  const mg1 = await call("model_get", {}) as Record<string, unknown>;
  const wall1 = wallsOf(mg1).find((w) => w.site_id === wall.site_id);
  check(wall1 !== undefined && shiftMm(wall, wall1!) > 15, `wall_move +20: ось сдвинулась (${wall1 ? shiftMm(wall, wall1).toFixed(1) : "?"} мм)`);
  const save1 = await gsave("wall_move +20");
  check(save1["verified"] === true, "save verified (wall_move +20)");
  const mg2 = await call("model_get", {}) as Record<string, unknown>;
  const wall2 = wallsOf(mg2).find((w) => w.site_id === wall.site_id);
  check(wall2 !== undefined && shiftMm(wall, wall2!) > 15, "после save и GET стена осталась сдвинутой");

  // ==== reopen при запущенном редакторе (повторный project_open) ====
  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await assertEditorPlanMatch(editorOf(), ids.planId);
  await call("render_plan", {});
  const mg3 = await call("model_get", {}) as Record<string, unknown>;
  const wall3 = wallsOf(mg3).find((w) => w.site_id === wall.site_id);
  check(wall3 !== undefined && shiftMm(wall, wall3!) > 15, "reopen: сдвиг сохранился, редактор открылся с проверенной серверной моделью");

  // ==== wall-мутация обратно: −20 мм, save verified ====
  await call("wall_move", { wall_id: wall.site_id, offset_mm: -20 });
  const save2 = await gsave("wall_move −20 (возврат)");
  check(save2["verified"] === true, "save verified (возврат стены)");
  const mg4 = await call("model_get", {}) as Record<string, unknown>;
  const wall4 = wallsOf(mg4).find((w) => w.site_id === wall.site_id);
  const back = wall4 !== undefined ? shiftMm(wall, wall4!) : NaN;
  check(back < 2, `стена возвращена на место (сдвиг ${back.toFixed(2)} мм ≤ 2)`);

  // ==== sig: модель dev-объекта == бэкап до первого прогона ====
  const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
  const same = sig(after.model) === sig(ref.model);
  check(same, "sig после мутации и возврата == backup (до ПЕРВОГО прогона)");
  if (!same) console.error("sig РАСХОЖДЕНИЕ — восстановите по журналу/бэкапу");
  await roGuard.checkFinal("end");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 600));
  exitCode = 1;
  try {
    const { probeWriteEnv } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    const afterFail = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-382.json`;
    if (existsSync(backupPath)) {
      const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
      console.error("FAIL-restore: сверка sig с бэкапом (до первого прогона):", sig(afterFail.model) === sig(ref.model) ? "OK" : "РАСХОЖДЕНИЕ");
    } else {
      console.error("FAIL-restore: бэкапа ещё нет (падение до первой записи) — сверка невозможна, записей не было");
    }
  } catch (fe) { console.error("FAIL-restore check:", String((fe as Error).message).slice(0, 300)); }
} finally {
  // 384 (ревью 383 №29): restore по журналу в finally. 386 (ревью 385 №36):
  // смещение ЗНАКОВОЕ (проекция на левую нормаль оси — та же формула, что в
  // moveWall; беззнаковый hypot при сбое save уводил стену в обратную
  // сторону); рабочая копия пересинхронизируется с сервером project_open ДО
  // wall_move (при сбое save копия могла не дойти до сервера); отказ при
  // сдвиге > 25 мм; после restore save модель сверяется sig с бэкапом
  try {
    if (wall0 !== null) {
      const ids = (await import("./probe-guard.ts")).probeWriteEnv();
      const backupPath = `.orca-reports/backup-${ids.objectId}-382.json`;
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      // №42 (ревью 387): редактор мог открыть чужой план — после project_open в
      // finally сверяем открытый в редакторе план с серверным до любой записи
      await assertEditorPlanMatch(editorOf(), ids.planId);
      const cur = await loadModel(ctx.session(), ids.objectId, ids.planId);
      // в RAW серверной модели стена — поле id (site_id — форма model_get),
      // ось — p1/p2 в см (from/to — форма model_get в мм)
      const w = wallsOf(cur.model).find((x) => (x.site_id ?? x.id) === wall0!.site_id);
      const off = w ? signedWallShiftMm(wall0, w) : NaN;
      const d = restoreDecision(off);
      if (d.action === "move") {
        console.error(`finally-restore: стена ${wall0.site_id} смещена на ${off.toFixed(1)} мм (знаковое) — wall_move(${d.offsetMm.toFixed(1)}) + save`);
        await call("wall_move", { wall_id: wall0.site_id, offset_mm: d.offsetMm });
        const r = await gsave("finally-restore (возврат стены)");
        if (r["verified"] !== true) throw new Error("save finally-restore не verified");
        // 386 №36: после restore save — сверка sig с бэкапом (до первого прогона)
        const afterRestore = await loadModel(ctx.session(), ids.objectId, ids.planId);
        if (existsSync(backupPath)) {
          const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
          const same = sig(afterRestore.model) === sig(ref.model);
          if (!same) {
            console.error("finally-restore: sig РАСХОЖДЕНИЕ с бэкапом после восстановления — восстановите по журналу/бэкапу");
            exitCode = 1;
          } else {
            console.error("finally-restore: стена возвращена, save verified, sig совпадает с бэкапом");
          }
        }
      } else if (d.action === "none") {
        console.log(`finally-restore: стена на месте (знаковый сдвиг ${off.toFixed(2)} мм ≤ 2) — restore не нужен`);
      } else {
        // сдвиг > 25 мм или состояние неизвестно — wall_move не применяем (fail-closed)
        if (Number.isFinite(off)) {
          console.error(`finally-restore: знаковый сдвиг ${off.toFixed(1)} мм > 25 — wall_move НЕ применяется`);
        } else {
          console.error("finally-restore: стена не найдена/ось нечитаема в RAW модели — состояние неизвестно");
        }
        if (existsSync(backupPath)) {
          const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
          const same = sig(cur.model) === sig(ref.model);
          if (!same) {
            console.error("finally-restore: sig РАСХОЖДЕНИЕ с бэкапом — восстановите по журналу/бэкапу");
            exitCode = 1;
          } else {
            console.log("finally-restore: sig совпадает с бэкапом — модель не изменена");
          }
        } else {
          console.error("finally-restore: бэкапа нет — состояние неизвестно, проверьте журнал");
          exitCode = 1;
        }
      }
    } else {
      console.log("finally-restore: записей не было (стена не выбиралась) — restore не нужен");
    }
  } catch (fe) {
    console.error("finally-restore НЕ УДАЛСЯ — восстановите по журналу/бэкапу:", String((fe as Error).message ?? fe).slice(0, 300));
    exitCode = 1;
  }
}
await client.close();
try { await closeBrowser(); } catch { /* */ }
if (fails.length > 0) console.log("FAILS:", fails.join(" | "));
process.exit(exitCode);
