// 296: живая проверка зонирования ч.2 в dev-проекте (REMPLANNER_PROBE_* из env,
// схема «бэкап → запись → проверка → восстановление»; объекты создаются и удаляются
// только по захваченным site_id, метки резолвятся из свежего model_get; контрольный
// проект — только GET до/после по РЕАЛЬНОМУ plan_id, пустой ответ — отказ).
// Сценарий: пробная комната + потолочный ригель, zone_ceiling с концом на грани
// ригеля, zone_floor / zone_hydroisolation / zone_floor_cap (включая пересечение
// делителей разных планов), save → reopen → сверка → render PNG.
// node scripts/probes/296-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

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
if (OBJECT_ID === READONLY_ID) {
  console.error("REMPLANNER_PROBE_OBJECT_ID совпадает с REMPLANNER_PROBE_READONLY_ID — стоп");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "296-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<Record<string, unknown>> => {
  await sleep(1500);
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const body = text(res);
  if ((res as { isError?: boolean }).isError) {
    const err = new Error(`${name}: ${body.slice(0, 600)}`);
    (err as Error & { body?: string }).body = body;
    throw err;
  }
  if (!opts.quiet) console.log(`  ${name} →`, body.slice(0, 260));
  return JSON.parse(body) as Record<string, unknown>;
};
const roSnap = async (tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`${OUT}/296-get-readonly-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

const created: Array<{ kind: "wall" | "delimiter" | "rigel"; siteId?: string; meta?: unknown }> = [];
let opened = false;
const freshLabel = async (coll: "walls" | "rigels", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {}, { quiet: true });
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};
// зачистка только по захваченным site_id через свежий model_get (ревью 263 N7).
// После reopen редактор перегенерирует id разделителей (restoreTotal: id=LIB.id()),
// поэтому «захваченный ID» после reopen — это site_id из свежей модели, отобранный
// по геометрии пробной комнаты (в её bbox нет чужих объектов)
const trialBBox = (): { x0: number; y0: number; x1: number; y1: number } => {
  const c = created.find((c) => c.kind === "wall" && c.meta)?.meta as { ox: number; oy: number } | undefined;
  return { x0: (c?.ox ?? 0) - 5, y0: (c?.oy ?? 0) - 5, x1: (c?.ox ?? 0) + 405, y1: (c?.oy ?? 0) + 305 };
};
const delimInTrial = (d: { vertexes?: Array<{ point?: { x: number; y: number } }> }): boolean => {
  const bb = trialBBox();
  const v = d.vertexes ?? [];
  return v.length >= 2 && v.every((q) => q.point && q.point.x >= bb.x0 && q.point.x <= bb.x1 && q.point.y >= bb.y0 && q.point.y <= bb.y1);
};
const removeCapturedDelimiters = async (): Promise<void> => {
  for (let guard = 0; guard < 20; guard++) {
    const mg = await call("model_get", {}, { quiet: true });
    const raw = (mg["zone_delimiters"] ?? []) as Array<{ id: string; site_id: string; from_mm?: number[]; to_mm?: number[] }>;
    // свежая модель: отбор по вхождению обеих точек в bbox пробной комнаты
    const mine = raw.filter((d) => {
      const p = [d.from_mm, d.to_mm].map((q) => (Array.isArray(q) ? { x: (q[0] ?? 0) / 10, y: (q[1] ?? 0) / 10 } : null));
      const bb = trialBBox();
      return p.length === 2 && p.every((q) => q && q.x >= bb.x0 && q.x <= bb.x1 && q.y >= bb.y0 && q.y <= bb.y1);
    });
    if (mine.length === 0) return;
    for (const d of mine) {
      const ref = d.site_id || d.id;
      try { await call("zone_ceiling_remove", { delimiter_id: ref }, { quiet: true }); } catch (e) { console.log(`  zone remove ${ref}:`, String((e as Error).message).slice(0, 120)); }
    }
  }
};
const saveStep = async (tag: string): Promise<{ verified: boolean; warnings: unknown[] }> => {
  const res = await call("project_save", {}, { quiet: true });
  const out = { verified: Boolean(res["verified"]), warnings: (res["warnings"] ?? []) as unknown[] };
  console.log(`SAVE ${tag}: verified=${out.verified} rounds=${res["rounds"]} warnings=${JSON.stringify(out.warnings).slice(0, 400)}`);
  if (!out.verified) throw new Error(`save ${tag} не verified`);
  await sleep(5500);
  return out;
};
const cleanup = async (): Promise<void> => {
  try {
    if (!opened) return;
    await removeCapturedDelimiters();
    const rigelSite = created.find((c) => c.kind === "rigel")?.siteId;
    if (rigelSite) {
      const label = await freshLabel("rigels", rigelSite);
      if (label) { try { await call("rigel_delete", { rigel_id: label }, { quiet: true }); } catch { /* уже нет */ } }
    }
    const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
    let left = [...wallSites];
    for (let guard = 0; guard < 60 && left.length > 0; guard++) {
      const label = await freshLabel("walls", left[0]!);
      if (!label) { left.shift(); continue; }
      try { await call("wall_delete", { wall_id: label }, { quiet: true }); } catch (e) { console.log(`  wall_delete ${label}: ${(e as Error).message.slice(0, 120)}`); }
      left.shift();
    }
    const saveRes = await call("project_save", {}, { quiet: true });
    console.log("cleanup save verified:", saveRes["verified"]);
  } catch (e) {
    console.error("CLEANUP FAIL:", String((e as Error).message ?? e).slice(0, 400));
  }
};

/** Семантическая сигнатура модели (как 262): служебные поля исключены,
 *  комнаты — по каноническим полигонам. */
function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "save_id", "is_forced"]) delete c[k];
  // rooms1 — legacy-контейнер комнат: редактор дописывает его при каждом save
  // (в бэкапе его нет, после первого save появляется); комнаты сверяем по rooms2
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
  // рёбра комнат и грани стен: редактор перегенерирует их id при каждом
  // пересчёте — сверяем состав, а не id (как в 262)
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

try {
  // 0. контрольный проект до (только GET, реальный plan_id, непустой)
  const snapBefore = await roSnap("before");

  // 1. бэкап dev-проекта
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/296-live-before.json`, JSON.stringify(before, null, 1));
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-296.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь (возможны чужие правки)");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  opened = true;

  // 2. пробная комната правее всей геометрии
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 600;
  const oy = 0;
  const mm = (x: number, y: number) => ({ x: Math.round(x * 10), y: Math.round(y * 10) });
  const rect: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [{ x: ox, y: oy }, { x: ox + 400, y: oy }],
    [{ x: ox + 400, y: oy }, { x: ox + 400, y: oy + 300 }],
    [{ x: ox + 400, y: oy + 300 }, { x: ox, y: oy + 300 }],
    [{ x: ox, y: oy + 300 }, { x: ox, y: oy }],
  ];
  for (const [i, [p1, p2]] of rect.entries()) {
    const res = await call("wall_add", { start: mm(p1.x, p1.y), end: mm(p2.x, p2.y), thickness_mm: 100 }, { quiet: true });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add не вернул entity.site_id");
    created.push({ kind: "wall", siteId: sid, ...(i === 0 ? { meta: { ox, oy } } : {}) } as never);
  }
  await saveStep("после стен");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });

  // метка комнаты по bbox
  const afterWalls = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterWalls.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const found = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + 400 + 1 && q.y >= oy - 1 && q.y <= oy + 300 + 1);
  });
  if (!found) throw new Error("пробная комната не появилась в rooms2");
  const roomRef = `R${Object.keys(roomsAfter).indexOf(found[0]) + 1}`;
  console.log("пробная комната:", roomRef);

  // 3. потолочный ригель + разделители всех типов
  const rigel = await call("rigel_add", { start: mm(ox + 180, oy + 60), end: mm(ox + 260, oy + 60), depth_mm: 300 }, { quiet: true });
  const rigelSite = (rigel as { entity?: { site_id?: string } }).entity?.site_id;
  if (!rigelSite) throw new Error("rigel_add не вернул site_id");
  created.push({ kind: "rigel", siteId: rigelSite });

  const zdC = await call("zone_ceiling_add", { room_id: roomRef, from_mm: mm(ox, oy + 160), to_mm: mm(ox + 220, oy + 75) }, { quiet: true });
  created.push({ kind: "delimiter", siteId: String((zdC as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  // пересечение делителей разных планов: линия зон пола поперёк зоны потолка
  const zdF = await call("zone_floor_add", { room_id: roomRef, from_mm: mm(ox + 100, oy), to_mm: mm(ox + 100, oy + 300) }, { quiet: true });
  created.push({ kind: "delimiter", siteId: String((zdF as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  const zdH = await call("zone_hydroisolation_add", { room_id: roomRef, from_mm: mm(ox + 200, oy), to_mm: mm(ox + 200, oy + 300) }, { quiet: true });
  created.push({ kind: "delimiter", siteId: String((zdH as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  const zdCap = await call("zone_floor_cap_add", { room_id: roomRef, from_mm: mm(ox + 300, oy), to_mm: mm(ox + 300, oy + 300) }, { quiet: true });
  created.push({ kind: "delimiter", siteId: String((zdCap as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  console.log("разделители:", JSON.stringify({ zdC, zdF, zdH, zdCap }).slice(0, 400));
  // пересечение одного плана — отказ
  try {
    await call("zone_floor_add", { room_id: roomRef, from_mm: mm(ox, oy + 100), to_mm: mm(ox + 400, oy + 100) }, { quiet: true });
    throw new Error("пересечение делителей одного плана не отвергнуто");
  } catch (e) {
    if (String((e as Error).message).includes("не отвергнуто")) throw e;
    console.log("пересечение зон пола отвергнуто:", String((e as Error).message).slice(0, 160));
  }
  const step = await saveStep("после разделителей");
  writeFileSync(`${OUT}/296-live-save-warnings.json`, JSON.stringify(step.warnings, null, 1));

  // 4. reopen → все 4 разделителя на месте (отбор по геометрии пробной комнаты:
  // редактор перегенерирует id разделителей при restore)
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const m2 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zones = (m2.model["zone_delimiters"] ?? {}) as Record<string, { vertexes?: Array<{ point?: { x: number; y: number } }>; type?: string }>;
  const gotTypes = Object.values(zones).filter((d) => delimInTrial(d as never)).map((d) => String(d["type"]));
  console.log("reopen, типы разделителей в пробной комнате:", JSON.stringify(gotTypes));
  for (const t of ["zone_ceiling", "zone_floor", "zone_hydroisolation", "zone_floor_cap"]) {
    if (!gotTypes.includes(t)) throw new Error(`после reopen нет ${t}`);
  }

  // 5. render PNG
  const rnd = await call("render_plan", {}, { quiet: true });
  const pngPath = (rnd as { path?: string }).path ?? (rnd as { file?: string }).file;
  console.log("render_plan:", JSON.stringify(rnd).slice(0, 200));

  // 6. восстановление: разделители по захваченным site_id, ригель, стены
  await removeCapturedDelimiters();
  const rigelLabel = await freshLabel("rigels", rigelSite);
  if (rigelLabel) await call("rigel_delete", { rigel_id: rigelLabel }, { quiet: true });
  const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
  let left = [...wallSites];
  for (let guard = 0; guard < 60 && left.length > 0; guard++) {
    const label = await freshLabel("walls", left[0]!);
    if (!label) { left.shift(); continue; }
    try { await call("wall_delete", { wall_id: label }, { quiet: true }); } catch { /* уже нет */ }
    left.shift();
  }
  const saveRes2 = await call("project_save", {}, { quiet: true });
  console.log("restore save verified:", saveRes2["verified"]);
  if (!saveRes2["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;

  // 7. сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/296-get-own-after.json`, JSON.stringify(finalModel, null, 1));

  // 8. контрольный проект после
  const roAfter = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  const roSame = sig(roAfter.model) === sig(snapBefore.model);
  console.log("контрольный проект:", roAfter.data_empty ? "ПУСТОЙ — отказ" : roSame ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
  if (!roSame || roAfter.data_empty) throw new Error("контрольный проект изменился или пуст");
  console.log("296-live OK; png:", pngPath ?? "(не извлечён)");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  await cleanup();
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
