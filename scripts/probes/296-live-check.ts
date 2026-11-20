// 296: живая проверка зонирования ч.2 в dev-проекте (REMPLANNER_PROBE_* из env,
// схема «бэкап → запись → проверка → восстановление»; объекты создаются и удаляются
// только по захваченным site_id, метки резолвятся из свежего model_get; контрольный
// проект — только GET до/после по РЕАЛЬНОМУ plan_id, пустой ответ — отказ).
// Сценарий: пробная комната + потолочный ригель, zone_ceiling с концом на грани
// ригеля, zone_floor / zone_hydroisolation / zone_floor_cap (включая пересечение
// делителей разных планов), save → reopen → сверка → render PNG.
// node scripts/probes/296-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Page } from "playwright-core";
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

const created: Array<{ kind: "wall" | "rigel"; siteId?: string; meta?: unknown }> = [];
/** Захваченные при создании разделители (ревью 298 №8): site_id с верхнего
 *  уровня ответа zone_*_add + геометрия записи (type + концы, мм) — при смене
 *  id редактором зачистка идёт по захваченной геометрии конкретной записи
 *  (один-к-одному), НЕ по bbox. */
const capturedDelims: Array<{ siteId: string; type: string; from_mm?: number[]; to_mm?: number[] }> = [];
let opened = false;
const freshLabel = async (coll: "walls" | "rigels", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {}, { quiet: true });
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};
const nearMm = (a?: number[], b?: number[]): boolean =>
  Array.isArray(a) && Array.isArray(b) && Math.abs(a[0]! - b[0]!) <= 1 && Math.abs(a[1]! - b[1]!) <= 1;
// зачистка только по захваченным ID (ревью 298 №8): site_id из ответа
// zone_*_add; при смене id редактором (restore) — по захваченной геометрии
// конкретной записи (type + концы, один-к-одному), не по bbox
const removeCapturedDelimiters = async (): Promise<void> => {
  for (let guard = 0; guard < 20; guard++) {
    const mg = await call("model_get", {}, { quiet: true });
    const raw = (mg["zone_delimiters"] ?? []) as Array<{ id: string; site_id: string; type?: string; from?: number[]; to?: number[] }>;
    const pending = [...capturedDelims];
    const mine = raw.filter((d) => {
      const idx = pending.findIndex((c) =>
        d.site_id === c.siteId ||
        ((d.type ?? "") === c.type && ((nearMm(d.from, c.from_mm) && nearMm(d.to, c.to_mm)) || (nearMm(d.from, c.to_mm) && nearMm(d.to, c.from_mm)))),
      );
      if (idx === -1) return false;
      pending.splice(idx, 1);
      return true;
    });
    if (mine.length === 0) return;
    for (const d of mine) {
      const ref = d.site_id || d.id;
      // инструмент по типу записи (ревью 298 №2: zone_*_remove проверяет тип)
      const tool = /^zone_(ceiling|floor|hydroisolation|floor_cap)$/.test(d.type ?? "") ? `${d.type}_remove` : "zone_ceiling_remove";
      try { await call(tool, { delimiter_id: ref }, { quiet: true }); } catch (e) { console.log(`  zone remove ${ref}:`, String((e as Error).message).slice(0, 120)); }
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

  // гард «план в редакторе == сервер» (ревью 298 №9в): project.copy("server").plan_id
  const edPage = ((await ctx.workspace().ensureEditor()) as unknown as { page: Page }).page;
  const planInEditor = await edPage.evaluate(() => {
    const w = window as unknown as { project?: { copy?: (s: string) => { plan_id?: string | number } | null } | null };
    return String(w.project?.copy?.("server")?.plan_id ?? "");
  });
  console.log("гард плана: в редакторе", planInEditor, "| сервер", String(before.plan_id));
  if (planInEditor !== String(before.plan_id)) throw new Error(`план в редакторе ${planInEditor} != серверу ${before.plan_id}`);

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

  // ревью 298 №8: zone_*_add возвращают site_id на ВЕРХНЕМ уровне ответа
  const captureDelim = (res: Record<string, unknown>, type: string, from: number[], to: number[]): string => {
    const sid = String(res["site_id"] ?? "");
    if (!sid) throw new Error(`${type}_add не вернул site_id: ${JSON.stringify(res).slice(0, 200)}`);
    capturedDelims.push({ siteId: sid, type, from_mm: from, to_mm: to });
    return sid;
  };
  const zdC = await call("zone_ceiling_add", { room_id: roomRef, from_mm: mm(ox, oy + 160), to_mm: mm(ox + 220, oy + 75) }, { quiet: true });
  const zdCSite = captureDelim(zdC, "zone_ceiling", [mm(ox, oy + 160).x, mm(ox, oy + 160).y], [mm(ox + 220, oy + 75).x, mm(ox + 220, oy + 75).y]);
  // пересечение делителей разных планов: линия зон пола поперёк зоны потолка
  const zdF = await call("zone_floor_add", { room_id: roomRef, from_mm: mm(ox + 100, oy), to_mm: mm(ox + 100, oy + 300) }, { quiet: true });
  const zdFSite = captureDelim(zdF, "zone_floor", [mm(ox + 100, oy).x, mm(ox + 100, oy).y], [mm(ox + 100, oy + 300).x, mm(ox + 100, oy + 300).y]);
  const zdH = await call("zone_hydroisolation_add", { room_id: roomRef, from_mm: mm(ox + 200, oy), to_mm: mm(ox + 200, oy + 300) }, { quiet: true });
  const zdHSite = captureDelim(zdH, "zone_hydroisolation", [mm(ox + 200, oy).x, mm(ox + 200, oy).y], [mm(ox + 200, oy + 300).x, mm(ox + 200, oy + 300).y]);
  const zdCap = await call("zone_floor_cap_add", { room_id: roomRef, from_mm: mm(ox + 300, oy), to_mm: mm(ox + 300, oy + 300) }, { quiet: true });
  const zdCapSite = captureDelim(zdCap, "zone_floor_cap", [mm(ox + 300, oy).x, mm(ox + 300, oy).y], [mm(ox + 300, oy + 300).x, mm(ox + 300, oy + 300).y]);
  console.log("разделители:", JSON.stringify({ zdCSite, zdFSite, zdHSite, zdCapSite }));
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

  // 4. reopen → все 4 разделителя на месте: сопоставление по захваченному
  // site_id, при смене id — по захваченной геометрии конкретной записи
  // (type + концы), не по bbox. В сырой модели zone_delimiters — словарь
  // записей {id, type, plan, vertexes[{point (см)}]}.
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const m2 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zones = (m2.model["zone_delimiters"] ?? {}) as Record<string, { id?: string; type?: string; vertexes?: Array<{ point?: { x: number; y: number } }> }>;
  const cmToMmPt = (p?: { x: number; y: number }): number[] | undefined => (p ? [Math.round(p.x * 10), Math.round(p.y * 10)] : undefined);
  const pendingCheck = [...capturedDelims];
  const gotTypes: string[] = [];
  for (const [key, z] of Object.entries(zones)) {
    const hit = pendingCheck.findIndex((c) => {
      if (key === c.siteId || (z.id ?? "") === c.siteId) return true;
      if ((z.type ?? "") !== c.type) return false;
      const v = z.vertexes ?? [];
      if (v.length < 2) return false;
      const q1 = cmToMmPt(v[0]?.point), q2 = cmToMmPt(v[v.length - 1]?.point);
      return (nearMm(q1, c.from_mm) && nearMm(q2, c.to_mm)) || (nearMm(q1, c.to_mm) && nearMm(q2, c.from_mm));
    });
    if (hit !== -1) {
      pendingCheck.splice(hit, 1);
      gotTypes.push(String(z.type ?? ""));
    }
  }
  console.log("reopen, типы разделителей (по захваченным записям):", JSON.stringify(gotTypes));
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

  // 8. контрольный проект после: канон + save_id (ревью 298 №9г: strip его
  // удалял — сравниваем явно)
  const roAfter = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
  const roSame = sig(roAfter.model) === sig(snapBefore.model) && roAfter.save_id === snapBefore.save_id;
  console.log("контрольный проект:", roAfter.data_empty ? "ПУСТОЙ — отказ" : roSame ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
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
