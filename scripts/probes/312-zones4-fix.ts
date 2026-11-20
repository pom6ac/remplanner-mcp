// 312 (ревью 311): живая перепроверка исправлений зонирования ч.4 в dev-проекте
// (REMPLANNER_PROBE_* из env, схема «бэкап → запись → проверка → восстановление»):
// №1 — finish_get/remove после ceiling_rigel_add (отделка видна в любой зоне, сверка
// ПОЛИГОНА зоны, а не только материала); №3 — zone_ceiling_add (vertexes[].zone
// rigel_ceiling) → ceiling_rigel_update width → save verified БЕЗ NORMALIZATION_DROPPED,
// конец делителя на новой грани; №7 — delete закладной с привязанным делителем →
// save verified, одна зона с отделкой. Контрольный GET до/после (ID из env) — канон +
// save_id, в finally. Восстановление по захваченным site_id в finally.
// node scripts/probes/312-zones4-fix.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN_ID/READONLY_ID/READONLY_PLAN_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("REMPLANNER_PROBE_OBJECT_ID совпадает с READONLY_ID — стоп");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "312-zones4-fix", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 2000)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const snap = async (objectId: string, planId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, planId);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`${OUT}/312-get-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let created: Array<{ kind: "wall" | "rigel" | "delimiter" | "ceiling"; siteId?: string; roomRef?: string }> = [];
let opened = false;
let before: LoadedModel | null = null;
let roBefore: LoadedModel | null = null;

let restored = false;
async function restoreByCaptured(): Promise<void> {
  if (restored || !opened) return;
  restored = true;
  // отделка блокирует wall_delete — снимаем перед удалением стен
  const roomRefCap = created.find((c) => c.kind === "ceiling")?.roomRef;
  if (roomRefCap) {
    try { await call("finish_ceiling_remove", { room_id: roomRefCap }); } catch { /* уже снята */ }
    try { await call("project_save", {}); } catch { /* продолжаем зачистку */ }
  }
  const mg = await call("model_get", {});
  const crs = (mg["ceiling_rigels"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "rigel" && x.siteId)) {
    if (!crs.some((r) => r.site_id === c.siteId)) { console.log(`restore: пропуск закладной ${c.siteId} — на сервере нет`); continue; }
    try { await call("ceiling_rigel_delete", { rigel_id: c.siteId! }); } catch { /* уже нет */ }
  }
  const zds = (mg["zone_delimiters"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "delimiter" && x.siteId)) {
    if (!zds.some((z) => z.site_id === c.siteId)) { console.log(`restore: пропуск разделителя ${c.siteId} — на сервере нет`); continue; }
    try { await call("zone_ceiling_remove", { delimiter_id: c.siteId! }); } catch { /* уже нет */ }
  }
  const mg2 = await call("model_get", {});
  const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
  const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"] }));
  if (!saveRes["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;
}

/** Записи потолков комнаты: [индекс, exist, материал, xMin..xMax полигона]. */
const ceilBrief = (model: Record<string, unknown>, trialId: string): string => {
  const rooms = (model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  const r = rooms[trialId];
  if (!r) return "комната не найдена";
  const ceils = (Array.isArray(r["ceilings"]) ? r["ceilings"] : []) as Array<Record<string, unknown>>;
  return ceils.map((c, i) => {
    const poly = (c["polygon"] ?? []) as Array<{ x: number; y: number }>;
    const xs = poly.map((p) => Math.round(p.x));
    return `#${i} ${c["exist"] === true ? String(c["material"]) : "-"} [${xs.length ? `${Math.min(...xs)}..${Math.max(...xs)}` : "нет полигона"}]`;
  }).join(" | ");
};

let trialId = "";
let trialRef = "";

try {
  // 0. контрольный проект до (только GET)
  roBefore = await snap(READONLY_ID, READONLY_PLAN_ID, "readonly-before");

  // 1. бэкап dev-проекта (бэкап → запись → проверка → восстановление)
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-312.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  // гард «план в редакторе == серверу»
  await call("render_plan", {});
  const editor = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editor ? await editor.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");

  // 2. пробная комната: правее всей геометрии, 4 стены 220×160 см, толщина 100 мм
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 300;
  const oy = 0;
  const w = 220, h = 160;
  type Pt = { x: number; y: number };
  const rect: [Pt, Pt][] = [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ];
  for (const [p1, p2] of rect) {
    const res = await call("wall_add", {
      start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) },
      end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) },
      thickness_mm: 100,
    });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add не вернул entity.site_id");
    created.push({ kind: "wall", siteId: sid });
  }
  const saveRoom = await call("project_save", {});
  console.log("save пробной комнаты:", JSON.stringify({ verified: saveRoom["verified"] }));
  if (!saveRoom["verified"]) throw new Error("save пробной комнаты не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const trial = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1);
  });
  if (!trial) throw new Error("пробная комната не появилась в rooms2");
  trialId = trial[0]!;
  trialRef = `R${Object.keys(roomsAfter).indexOf(trialId) + 1}`;
  console.log("пробная комната:", trialId, "метка:", trialRef);
  created.push({ kind: "ceiling", roomRef: trialRef });

  // ---------- №1: finish_get/remove после rigel_add ----------
  await call("finish_ceiling_set", { room_id: trialRef, material: "gypsum_ceiling", profile: "standard" });
  const saveFin = await call("project_save", {});
  console.log("save отделки:", JSON.stringify({ verified: saveFin["verified"] }));
  if (!saveFin["verified"]) throw new Error("save отделки не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

  // закладная у правой стены: ось x = ox+w-30
  const rigelX = ox + w - 30;
  const rg1 = await call("ceiling_rigel_add", {
    room_id: trialRef,
    start: { x: Math.round(rigelX * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round(rigelX * 10), y: Math.round((oy + h - 6) * 10) },
  });
  const rg1Site = String(rg1["site_id"] ?? "");
  if (!rg1Site) throw new Error("ceiling_rigel_add не вернул site_id");
  created.push({ kind: "rigel", siteId: rg1Site });
  const saveRg1 = await call("project_save", {});
  console.log("save закладной №1:", JSON.stringify({ verified: saveRg1["verified"], warnings: saveRg1["warnings"] }));
  if (!saveRg1["verified"]) throw new Error("save закладной не verified (NORMALIZATION_DROPPED?)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const st1 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  console.log("№1 ceilings после rigel_add:", ceilBrief(st1.model as Record<string, unknown>, trialId));
  const fl1 = await call("finish_get", { room_id: trialRef });
  const fl1rooms = (fl1["rooms"] ?? fl1["list"] ?? fl1) as Array<Record<string, unknown>>;
  const room1 = (Array.isArray(fl1rooms) ? fl1rooms : []).find((r) => r["site_id"] === trialId || r["id"] === trialRef) ?? (Array.isArray(fl1rooms) ? fl1rooms[0] : undefined);
  console.log("№1 finish_get.ceiling:", JSON.stringify(room1?.["ceiling"] ?? null));
  if (!room1 || !room1["ceiling"]) throw new Error("№1: finish_get не показывает отделку зоны (регрессия 311 №1)");
  // КАКАЯ зона получила отделку: полигон записи с материалом — не вся комната
  const rooms1 = (st1.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  const ceils1 = (rooms1[trialId]!["ceilings"] ?? []) as Array<Record<string, unknown>>;
  const withMat = ceils1.filter((c) => c["exist"] === true && typeof c["material"] === "string");
  if (withMat.length !== 1) throw new Error(`№1: ожидалась 1 запись с отделкой, получено ${withMat.length}`);
  const poly1 = (withMat[0]!["polygon"] ?? []) as Array<{ x: number }>;
  const xs1 = poly1.map((p) => p.x);
  const [minX1, maxX1] = [Math.min(...xs1), Math.max(...xs1)];
  console.log(`№1 отделка в зоне с полигоном x ${minX1}..${maxX1} (комната ${ox}..${ox + w}, грань закладной ${rigelX - 5}/${rigelX + 5})`);
  if (!(maxX1 <= rigelX + 5 + 1)) throw new Error(`№1: отделка переписана полигоном всей комнаты (x до ${maxX1})`);
  // remove снимает
  await call("finish_ceiling_remove", { room_id: trialRef });
  const saveRem = await call("project_save", {});
  console.log("save remove:", JSON.stringify({ verified: saveRem["verified"] }));
  if (!saveRem["verified"]) throw new Error("save remove не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const st1r = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const ceils1r = (((st1r.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)[trialId]!["ceilings"] ?? []) as Array<Record<string, unknown>>;
  const leftMat = ceils1r.filter((c) => c["exist"] === true && typeof c["material"] === "string");
  console.log("№1 после remove:", ceilBrief(st1r.model as Record<string, unknown>, trialId));
  if (leftMat.length !== 0) throw new Error(`№1: remove не снял отделку зон: ${JSON.stringify(leftMat.map((c) => c["material"]))}`);

  // ---------- №3: zone_ceiling_add → rigel_update width → save без NORMALIZATION_DROPPED ----------
  await call("finish_ceiling_set", { room_id: trialRef, material: "gypsum_ceiling", profile: "standard" });
  const saveFin2 = await call("project_save", {});
  if (!saveFin2["verified"]) throw new Error("save отделки №3 не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const rigelX2 = ox + 110;
  const rg2 = await call("ceiling_rigel_add", {
    room_id: trialRef,
    start: { x: Math.round(rigelX2 * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round(rigelX2 * 10), y: Math.round((oy + h - 6) * 10) },
  });
  const rg2Site = String(rg2["site_id"] ?? "");
  if (!rg2Site) throw new Error("ceiling_rigel_add №3 не вернул site_id");
  created.push({ kind: "rigel", siteId: rg2Site });
  const saveRg2 = await call("project_save", {});
  if (!saveRg2["verified"]) throw new Error("save закладной №3 не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  // делитель от левой стены к грани закладной (грань l на rigelX2+5)
  const zd = await call("zone_ceiling_add", {
    room_id: trialRef,
    from_mm: { x: Math.round((ox + 6) * 10), y: Math.round((oy + h / 2) * 10) },
    to_mm: { x: Math.round((rigelX2 + 5) * 10), y: Math.round((oy + h / 2) * 10) },
  });
  const zdSite = String(zd["site_id"] ?? "");
  if (!zdSite) throw new Error("zone_ceiling_add не вернул site_id");
  created.push({ kind: "delimiter", siteId: zdSite });
  const saveZd = await call("project_save", {});
  console.log("save делителя:", JSON.stringify({ verified: saveZd["verified"] }));
  if (!saveZd["verified"]) throw new Error("save делителя не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const st3 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zds3 = (st3.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>;
  const zdRec = Object.values(zds3).find((d) => String(d["id"] ?? "") === zdSite) ?? zds3[zdSite];
  const vtx = (zdRec?.["vertexes"] ?? []) as Array<{ point?: { x: number; y: number }; zone?: Record<string, unknown> }>;
  const endZone = vtx[1]?.zone ?? null;
  console.log("№3 vertexes[1].zone:", JSON.stringify(endZone));
  console.log("№3 ceilings:", ceilBrief(st3.model as Record<string, unknown>, trialId));
  if (!endZone || endZone["type"] !== "rigel_ceiling" || String(endZone["rigel_id"] ?? "") !== rg2Site) {
    throw new Error(`№3: zone-привязка конца на грани закладной не записана: ${JSON.stringify(endZone)}`);
  }
  if (endZone["edge_side"] !== "l") throw new Error(`№3: edge_side ${String(endZone["edge_side"])} — ожидалось l`);
  // update ширины: прежний консервативный отказ убран, save обязан пройти
  const upd = await call("ceiling_rigel_update", { rigel_id: rg2Site, width_mm: 300 });
  console.log("№3 ceiling_rigel_update:", JSON.stringify({ width_mm: upd["width_mm"] }));
  const saveUpd = await call("project_save", {});
  console.log("save update №3:", JSON.stringify({ verified: saveUpd["verified"], warnings: saveUpd["warnings"] }));
  if (!saveUpd["verified"]) throw new Error("№3: save update не verified (NORMALIZATION_DROPPED?)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const st3u = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zds3u = (st3u.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>;
  const zdRecU = Object.values(zds3u).find((d) => String(d["id"] ?? "") === zdSite) ?? zds3u[zdSite];
  const vtxU = (zdRecU?.["vertexes"] ?? []) as Array<{ point?: { x: number; y: number } }>;
  const endX = Math.round(vtxU[1]?.point?.x ?? -1);
  const newFaceX = rigelX2 + 15;
  console.log(`№3 конец делителя после update: x=${endX} (новая грань l ${newFaceX})`);
  if (Math.abs(endX - newFaceX) > 1) throw new Error(`№3: конец делителя x=${endX}, ожидалась новая грань ${newFaceX} (restoreDelimiters)`);
  console.log("№3 ceilings после update:", ceilBrief(st3u.model as Record<string, unknown>, trialId));

  // ---------- №7: delete закладной с привязанным делителем ----------
  const delRes = await call("ceiling_rigel_delete", { rigel_id: rg2Site });
  console.log("№7 ceiling_rigel_delete:", JSON.stringify(delRes).slice(0, 160));
  const saveDel = await call("project_save", {});
  console.log("save delete №7:", JSON.stringify({ verified: saveDel["verified"] }));
  if (!saveDel["verified"]) throw new Error("№7: save delete не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const st7 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const ceils7 = (((st7.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>)[trialId]!["ceilings"] ?? []) as Array<Record<string, unknown>>;
  const mats7 = ceils7.filter((c) => c["exist"] === true && typeof c["material"] === "string");
  console.log("№7 ceilings после delete:", ceilBrief(st7.model as Record<string, unknown>, trialId));
  if (mats7.length !== 1) throw new Error(`№7: ожидалась 1 зона с отделкой, получено ${mats7.length}`);

  // 10. восстановление по захваченным site_id
  await restoreByCaptured();

  // 11. полная семантическая сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/312-get-own-after.json`, JSON.stringify(finalModel, null, 1));
  if (!same) throw new Error("dev-проект не совпал с бэкапом");
  console.log("312-zones4-fix OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 4000));
  process.exitCode = 1;
} finally {
  try {
    await restoreByCaptured();
  } catch (ce) {
    console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400));
    process.exitCode = 1;
  }
  if (before) {
    try {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model);
      if (same) console.log("finally: семантическая сверка с бэкапом — OK");
      else {
        writeFileSync(`${OUT}/312-get-own-after.json`, JSON.stringify(final, null, 1));
        console.error("РАСХОЖДЕНИЕ после restore: модель не совпала с бэкапом (дамп в 312-get-own-after.json)");
        process.exitCode = 1;
      }
    } catch (ve) {
      console.error("VERIFY FAIL:", String((ve as Error).message ?? ve).slice(0, 400));
      process.exitCode = 1;
    }
  }
  // контрольный GET «после» — в finally
  if (roBefore) {
    try {
      const roAfter = await loadModel(ctx.session(), READONLY_ID, READONLY_PLAN_ID);
      if (roAfter.data_empty) { console.error("finally: контрольный GET пустой"); process.exitCode = 1; }
      else {
        const roOk = sig(roAfter.model) === sig(roBefore.model) && roAfter.save_id === roBefore.save_id;
        console.log("finally: контрольный проект:", roOk ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
        if (!roOk) process.exitCode = 1;
      }
    } catch (re) {
      console.error("finally: контрольный GET не удался:", String((re as Error).message ?? re).slice(0, 300));
      process.exitCode = 1;
    }
  }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
