// 298: живая проверка — перегенерирует ли редактор id top-level zone_delimiters
// при обычном открытии/сохранении проекта (ревью 297 №8). Схема «бэкап → запись →
// проверка → восстановление»: один пробный zone_floor в dev-проекте, save,
// reopen (свежий браузер, второй экземпляр сервера), сверка id и геометрии,
// зачистка только по захваченным id (при смене id — по захваченной геометрии
// конкретной записи: type + концы, один-к-одному), не по bbox; контрольный
// проект — только GET по реальному plan_id.
// Гарды (ревью 285 №3, 298 №9): ID только из env, OBJECT_ID != READONLY_ID до
// записи, план в редакторе == серверу (project.copy("server").plan_id), finally
// с closeBrowser, save_id и канон модели контрольного GET до/после совпадают.
// node scripts/probes/298-zone-ids.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, assertUnchangedRef, newGuardRef, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … run (REMPLANNER_PROBE_* из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN_ID");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Отдельный экземпляр MCP-сервера (своя сессия, workspace, редактор). */
async function startSession(name: string) {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name, version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  type TextContent = { content: { type: string; text?: string }[] };
  const text = (r: unknown): string => {
    const contents = (r as TextContent).content ?? [];
    return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  const call = async (tool: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<Record<string, unknown>> => {
    await sleep(1500);
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
    const body = text(res);
    if ((res as { isError?: boolean }).isError) throw new Error(`${tool}: ${body.slice(0, 600)}`);
    if (!opts.quiet) console.log(`  ${tool} →`, body.slice(0, 260));
    return JSON.parse(body) as Record<string, unknown>;
  };
  /** Страница редактора того же workspace (одна сессия). */
  const editorPage = async (): Promise<Page> => {
    const ed = (await ctx.workspace().ensureEditor()) as unknown as { page: Page };
    return ed.page;
  };
  return { ctx, call, editorPage };
}

type DelimRec = { id: string; site_id: string; type: string; vertexes?: Array<{ point?: { x: number; y: number } }> };
const delimMap = (m: LoadedModel): Record<string, DelimRec> =>
  (m.model["zone_delimiters"] ?? {}) as Record<string, DelimRec>;
const delimKeys = (m: LoadedModel): string[] => Object.keys(delimMap(m));

/** Семантическая сигнатура модели (как в 296-live-check): служебные поля
 *  исключены, комнаты — по каноническим полигонам. */
function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "save_id", "is_forced"]) delete c[k];
  delete c["rooms1"];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  const rooms = (c["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  const canonPoly = (poly: unknown): string => {
    if (!Array.isArray(poly)) return "";
    return (poly as Array<{ x: number; y: number }>).map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(";") + "#";
  };
  const polyIndex = new Map<string, number>();
  const roomAlias = new Map<string, string>();
  for (const [rid, r] of Object.entries(rooms)) {
    const k = canonPoly(r["polygon"]);
    if (!polyIndex.has(k)) polyIndex.set(k, polyIndex.size);
    roomAlias.set(rid, `RR${polyIndex.get(k)}`);
  }
  for (const rk of ["rooms1", "rooms2"] as const) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      for (const rec of Object.values(map)) {
        if (Array.isArray(rec["edges"])) rec["edges"] = (rec["edges"] as Array<Record<string, unknown>>).map((e, i) => ({ ...e, id: `ed${i}` }));
        if (Array.isArray(rec["id_of_edges"])) rec["id_of_edges"] = (rec["id_of_edges"] as unknown[]).map((_, i) => `ed${i}`);
      }
      const renamed: Record<string, Record<string, unknown>> = {};
      for (const [rid, rec] of Object.entries(map)) renamed[roomAlias.get(rid) ?? rid] = rec;
      c[rk] = renamed;
    }
  }
  const aliasAll = (v: unknown, parentKey?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => aliasAll(x));
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const kk of Object.keys(v as Record<string, unknown>).sort()) o[kk] = aliasAll((v as Record<string, unknown>)[kk], kk);
      return o;
    }
    if (typeof v === "string" && (parentKey === "id_room" || parentKey === "id")) {
      return roomAlias.get(v) ?? (parentKey === "id_room" ? "DANGLING" : v);
    }
    return v;
  };
  for (const rec of Object.values((c["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)) {
    if (Array.isArray(rec["edges"])) rec["edges"] = (rec["edges"] as Array<Record<string, unknown>>).map((e, i) => ({ ...e, id: `ed${i}` }));
    if (Array.isArray(rec["id_of_edges"])) rec["id_of_edges"] = (rec["id_of_edges"] as unknown[]).map((_, i) => `ed${i}`);
  }
  for (const w of Object.values((c["walls"] ?? {}) as Record<string, Record<string, unknown>>)) {
    const eds2 = w["eds2"] as Record<string, unknown> | undefined;
    if (eds2) {
      for (const side of Object.keys(eds2)) {
        if (Array.isArray(eds2[side])) {
          eds2[side] = (eds2[side] as Array<Record<string, unknown>>).map((e) => JSON.stringify({ ...e, id: null, pc: null })).sort();
        }
      }
    }
  }
  return JSON.stringify(aliasAll(c));
}

let createdSiteId: string | null = null;
let cleanupSession: Awaited<ReturnType<typeof startSession>> | null = null;

const roRef = newGuardRef();
try {
  // 0. контрольный проект до (только GET, реальный plan_id, непустой, save_id запомнен)
  const s1 = await startSession("298-zone-ids-1");
  cleanupSession = s1;
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(s1.ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(s1.ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(OBJECT_ID, READONLY_ID, READONLY_PLAN_ID));
  roRef.current = roGuard;
  await roGuard.assertUnchanged("перед записями");
  const roBefore = await loadModel(s1.ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  if (roBefore.data_empty) throw new Error("контрольный GET before пустой (data_empty) — отказ");
  writeFileSync(`${OUT}/298-get-readonly-before.json`, JSON.stringify(roBefore, null, 1));
  const roSaveIdBefore = roBefore.save_id;

  // 1. бэкап dev-проекта
  const before = await loadModel(s1.ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-298.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь (возможны чужие правки)");
  }
  if (Object.keys(delimMap(before)).length > 0) {
    throw new Error("в dev-проекте уже есть zone_delimiters — проба рассчитана на чистый проект");
  }

  // 2. project_open + гард «план в редакторе == сервер»
  await s1.call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const page = await s1.editorPage();
  const planInEditor = await page.evaluate(() => {
    const w = window as unknown as { project?: { copy?: (s: string) => { plan_id?: string | number } | null } | null };
    return String(w.project?.copy?.("server")?.plan_id ?? "");
  });
  console.log("гард плана: в редакторе", planInEditor, "| сервер", String(before.plan_id));
  if (planInEditor !== String(before.plan_id)) throw new Error(`план в редакторе ${planInEditor} != серверу ${before.plan_id}`);

  // 3. одна пробная линия зон пола в первой комнате с контуром
  const rooms = (before.model["rooms2"] ?? {}) as Record<string, {
    polygon?: Array<{ x: number; y: number }>;
    edges?: Array<{ p1?: { x: number; y: number }; p2?: { x: number; y: number }; length?: number }>;
  }>;
  const entry = Object.entries(rooms).find(([, r]) => {
    const long = (r.edges ?? []).filter((q) => q.p1 && q.p2 && (q.length ?? 0) >= 200);
    return (r.polygon ?? []).length >= 3 && long.length >= 2;
  });
  if (!entry) throw new Error("нет подходящей комнаты с двумя рёбрами ≥ 200 см");
  const [roomId, room] = entry;
  const poly = room.polygon!;
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  const edges = (room.edges ?? []).filter((q) => q.p1 && q.p2 && (q.length ?? 0) >= 200).slice(0, 2);
  const midOf = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
  const towardCenter = (p: { x: number; y: number }) => {
    const l = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / l) * 3, y: p.y + ((cy - p.y) / l) * 3 };
  };
  const mm = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
  const roomRef = `R${Object.keys(rooms).indexOf(roomId) + 1}`;
  const fromMm = mm(towardCenter(midOf(edges[0]!.p1!, edges[0]!.p2!)));
  const toMm = mm(towardCenter(midOf(edges[1]!.p1!, edges[1]!.p2!)));
  console.log("пробная комната:", roomId, "→", roomRef);

  const added = await s1.call("zone_floor_add", { room_id: roomRef, from_mm: fromMm, to_mm: toMm }, { quiet: true });
  createdSiteId = String(added["site_id"] ?? "");
  if (!createdSiteId) throw new Error(`zone_floor_add не вернул site_id: ${JSON.stringify(added).slice(0, 200)}`);
  console.log("создан разделитель, site_id:", createdSiteId);

  // 4. save → GET: сохраняет ли save id записи
  await assertUnchangedRef(roRef, "{tag}");
  const save1 = await s1.call("project_save", {}, { quiet: true });
  if (!save1["verified"]) throw new Error("save1 не verified");
  await sleep(5500);
  const afterSave = await loadModel(s1.ctx.session(), OBJECT_ID, PLAN_ID);
  const afterSaveKeys = delimKeys(afterSave);
  const saveKeptId = afterSaveKeys.includes(createdSiteId) || Object.values(delimMap(afterSave)).some((z) => z.id === createdSiteId);
  console.log("id после save (GET):", JSON.stringify(Object.entries(delimMap(afterSave)).map(([k, z]) => ({ key: k, id: z.id }))), "— id сохранён:", saveKeptId);

  // 5. reopen: свежий браузер (restore с сервера) → id в GET и в редакторе.
  // Старый workspace закрывается вместе с браузером; второй экземпляр — своя
  // сессия (первая уже закрыта, параллельных нет).
  await closeBrowser();
  await sleep(3000);
  const s2 = await startSession("298-zone-ids-2");
  cleanupSession = s2;
  await s2.call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const page2 = await s2.editorPage();
  const runtime = await page2.evaluate(() => {
    const w = window as unknown as {
      project?: { copy?: (s: string) => { zone_delimiters?: Record<string, { id?: string; type?: string; plan?: string }> } | null };
      ZONE_DELIMITERS?: Record<string, unknown>;
    };
    const top = w.project?.copy?.("server")?.zone_delimiters ?? {};
    const rt: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.ZONE_DELIMITERS ?? {})) {
      const s = (v as { serialize?: () => { id?: string } }).serialize?.() ?? v;
      rt[k] = String((s as { id?: string }).id ?? "");
    }
    return {
      top: Object.fromEntries(Object.entries(top).map(([k, z]) => [k, { id: String(z.id ?? ""), type: String(z.type ?? ""), plan: String(z.plan ?? "") }])),
      runtime: rt,
    };
  });
  const afterReopen = await loadModel(s2.ctx.session(), OBJECT_ID, PLAN_ID);
  const afterReopenKeys = delimKeys(afterReopen);
  const reopenKeptId = afterReopenKeys.includes(createdSiteId) || Object.values(delimMap(afterReopen)).some((z) => z.id === createdSiteId);
  console.log("id после reopen (GET):", JSON.stringify(Object.entries(delimMap(afterReopen)).map(([k, z]) => ({ key: k, id: z.id }))), "— id сохранён:", reopenKeptId);
  console.log("runtime ZONE_DELIMITERS после reopen:", JSON.stringify(runtime.runtime));
  console.log("top-level copy('server') после reopen:", JSON.stringify(runtime.top));

  // 6. зачистка по захваченному id (при смене id — по захваченной геометрии
  // конкретной записи: type + концы, один-к-одному), не по bbox
  const mine = afterReopenKeys
    .map((key) => ({ key, rec: delimMap(afterReopen)[key]! }))
    .filter(({ key, rec }) => {
      if (key === createdSiteId || rec.id === createdSiteId) return true;
      const v = rec.vertexes ?? [];
      if (rec.type !== "zone_floor" || v.length < 2) return false;
      const p1 = v[0]?.point, p2 = v[v.length - 1]?.point;
      if (!p1 || !p2) return false;
      const near = (a: { x: number; y: number }, b2: { x: number; y: number }) =>
        Math.abs(a.x - b2.x / 10) <= 0.1 && Math.abs(a.y - b2.y / 10) <= 0.1;
      return (near(p1, fromMm) && near(p2, toMm)) || (near(p1, toMm) && near(p2, fromMm));
    });
  if (mine.length !== 1) throw new Error(`ожидалась ровно одна своя запись, найдено ${mine.length}`);
  await s2.call("zone_floor_remove", { delimiter_id: mine[0]!.key }, { quiet: true });
  createdSiteId = null;
  await assertUnchangedRef(roRef, "{tag}");
  const save2 = await s2.call("project_save", {}, { quiet: true });
  console.log("restore save verified:", save2["verified"]);
  if (!save2["verified"]) throw new Error("restore save не verified");
  await sleep(5500);

  // 7. сверка data с бэкапом (канон модели; коллекция zone_delimiters снова пуста)
  const finalModel = await loadModel(s2.ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/298-get-own-after.json`, JSON.stringify(finalModel, null, 1));
  // m2 ревью 299: расхождение data с бэкапом после restore — стоп (не только печать)
  if (!same) throw new Error("data после restore != бэкапу (см. 298-get-own-after.json)");
  const zonesLeft = Object.keys(delimMap(finalModel)).length;
  if (zonesLeft !== 0) throw new Error(`после restore в zone_delimiters ${zonesLeft} записей — не совпало с бэкапом`);

  // 8. контрольный проект после — ревью 319 №4: с фиксированным эталоном (канон + save_id)
  const roChanged = await roGuard.checkFinal("в конце");
  console.log("контрольный проект:", roChanged ? "ИЗМЕНИЛСЯ — СТОП" : "не изменился (канон + save_id)");
  if (roChanged) {
    process.exitCode = 1;
    throw new Error("контрольный проект изменился или пуст");
  }

  const verdict = {
    createdSiteId,
    saveKeptId,
    reopenKeptId,
    runtimeIdsAfterReopen: Object.values(runtime.runtime),
    topIdsAfterReopen: runtime.top,
  };
  writeFileSync(`${OUT}/298-zone-ids.json`, JSON.stringify(verdict, null, 1));
  console.log("ВЕРДИКТ:", saveKeptId && reopenKeptId
    ? "редактор СОХРАНЯЕТ id top-level zone_delimiters при обычном открытии/сохранении"
    : "редактор ПЕРЕГЕНЕРИРУЕТ id top-level zone_delimiters при обычном открытии/сохранении");
  console.log("298-zone-ids OK");
  cleanupSession = null;
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  process.exitCode = 1;
  // аварийная зачистка: только по захваченному id
  try {
    const s = cleanupSession;
    if (s && createdSiteId) {
      await s.call("zone_floor_remove", { delimiter_id: createdSiteId }, { quiet: true });
      await assertUnchangedRef(roRef, "{tag}");
      await s.call("project_save", {}, { quiet: true });
      console.log("аварийная зачистка выполнена по захваченному id");
      createdSiteId = null;
    }
  } catch (e2) {
    console.error("аварийная зачистка не удалась:", String((e2 as Error).message).slice(0, 200));
  }
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
