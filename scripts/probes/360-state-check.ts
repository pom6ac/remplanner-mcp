// 360 (сантехника ч.3) — GET-only проверка состояния dev-объекта перед живой фазой
// (продолжение этапа после остановки исполнителя; ID только из env):
//   1) гарды probe-guard: коллизии env, GET-пара, план в составе объекта;
//   2) контрольный проект (READONLY_ID из env): сверка с корневым эталоном
//      (без REF_INIT) — любое расхождение = СТОП (exit 1);
//   3) dev-объект: сверка sig с бэкапом этапа 360 .orca-reports/backup-<OBJECT>-360.json;
//      при расхождении — семантическая разница множеств стен/предметов/труб и
//      проверка лишних site_id против журнала захваченных ID (.orca-reports/tmp/360-captured-<OBJECT>.json);
//      лишнего, чего нет в журнале, проба НЕ удаляет (только отчёт в stdout);
//   4) свежий бэкап .orca-reports/backup-<OBJECT>-360b.json — снимок непосредственно
//      перед живым прогоном (пишется только когда sig с бэкапом 360 совпал).
// Записей на сервер нет: только GET (loadModel). Браузер не открывается.
// node scripts/probes/360-state-check.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadModel } from "../../src/api.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

const { objectId: OBJECT_ID, planId: PLAN_ID, readonlyId: READONLY_ID, readonlyPlanId: READONLY_PLAN_ID } = probeWriteEnv();
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 5 * 60_000).unref();

const ctx = new ServerContext();

try {
  // контрольный проект: эталон корневой, REF_INIT не ставится (fail-closed)
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  const roChanged = await roGuard.checkFinal("state-check");
  console.log("контрольный проект:", roChanged ? "ИЗМЕНИЛСЯ — СТОП" : "не изменился");
  if (roChanged) process.exit(1);

  const got = await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);

  const backupPath = `.orca-reports/backup-${OBJECT_ID}-360.json`;
  if (!existsSync(backupPath)) {
    console.error(`бэкап этапа 360 не найден: ${backupPath} — СТОП (без создания)`);
    process.exit(1);
  }
  const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
  const sigOk = sig(got.model) === sig(stored.model as Record<string, unknown>);
  console.log("sig(dev) == бэкап 360:", sigOk ? "OK" : "РАСХОЖДЕНИЕ");
  if (!sigOk) {
    const bm = (stored.model ?? {}) as Record<string, Record<string, unknown>>;
    const am = (got.model ?? {}) as Record<string, Record<string, unknown>>;
    const extra: Record<string, string[]> = {};
    const missing: Record<string, string[]> = {};
    for (const key of ["walls", "items", "pipes", "pipes_gas", "pipes_heat", "pipes_ventilation", "pipes_warm_floor", "pipes_conditioner"]) {
      const bk = new Set(Object.keys(bm[key] ?? {}));
      const ak = new Set(Object.keys(am[key] ?? {}));
      const e = [...ak].filter((x) => !bk.has(x));
      const m = [...bk].filter((x) => !ak.has(x));
      if (e.length) extra[key] = e;
      if (m.length) missing[key] = m;
    }
    console.log("лишнее на сервере (нет в бэкапе):", JSON.stringify(extra));
    console.log("пропало с сервера (есть в бэкапе):", JSON.stringify(missing));
    const items = am["items"] ?? {};
    const extraItems = (extra["items"] ?? []).map((id) => `${id}:${(items[id] as { name?: string } | undefined)?.name ?? "?"}`);
    console.log("лишние предметы по именам:", JSON.stringify(extraItems));
    // сверка с журналом захваченных ID: зачистка возможна ТОЛЬКО по журналу
    const journalPath = `.orca-reports/tmp/360-captured-${OBJECT_ID}.json`;
    const j = existsSync(journalPath)
      ? JSON.parse(readFileSync(journalPath, "utf8")) as { walls?: string[]; items?: string[]; pipes?: string[]; rooms?: string[] }
      : {};
    const jAll = new Set([...(j.walls ?? []), ...(j.items ?? []), ...(j.pipes ?? [])]);
    const extraSites = Object.values(extra).flat();
    const unknown = extraSites.filter((id) => !jAll.has(id));
    console.log("журнал захваченных ID:", JSON.stringify(j));
    console.log("лишних вне журнала:", unknown.length ? JSON.stringify(unknown) : "нет");
    if (unknown.length > 0) {
      console.error("есть сущности вне журнала — ручная зачистка запрещена, СТОП");
      process.exit(1);
    }
    process.exitCode = extraSites.length ? 2 : 1; // 2 — остатки пробы, чистить по журналу cleanup-фазой
  } else {
    // свежий бэкап непосредственно перед живым прогоном (только при точном совпадении)
    const freshPath = `.orca-reports/backup-${OBJECT_ID}-360b.json`;
    writeFileSync(freshPath, JSON.stringify(got, null, 1) + "\n");
    console.log("свежий бэкап записан:", freshPath);
  }
  console.log("360-state-check: DONE");
  process.exit(process.exitCode ?? 0);
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 600));
  process.exit(1);
}
