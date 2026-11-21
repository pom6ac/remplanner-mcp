// 347 (отделка ч.9, живая проверка в dev-объекте, ID только из env):
// 1) подъём пола (f0offset) → save verified → reopen → сверка на сервере;
// 2) точка укладки (anchor_floor, PRO) → save verified → reopen → сверка;
// 3) имя/цвет зоны помещения (room_set_name/room_set_color, спецсимволы в имени) →
//    save verified → reopen → сверка zones[0];
// 4) стена делит комнату — поля переживают деление без ложной ошибки (как в редакторе) →
//    save verified → reopen → сверка частей;
// 5) зачистка: снятие отделки/полей, стены по захваченным site_id, save restore,
//    сверка sig с бэкапом backup-<OBJECT>-347.json (снимается ДО прогона).
// Гарды полные (probe-guard): READONLY обязателен, коллизий env нет, GET-пара,
// план в редакторе == серверу перед каждым reopen/записью, roGuard перед каждой
// записью, closeBrowser в finally. node scripts/probes/347-finish9-live.ts run
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run" && process.argv[2] !== "cleanup") {
  console.error("запуск: run | cleanup");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"] as string;
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"] as string;
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"] as string;
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] as string;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "347-finish9-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => c.text ?? "").join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const tryCall = async (name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; res?: Record<string, unknown>; err?: string }> => {
  try {
    return { ok: true, res: await call(name, args) };
  } catch (e) {
    return { ok: false, err: String((e as Error).message).slice(0, 400) };
  }
};

type Created = { kind: "wall"; siteId: string };
let created: Created[] = [];
let opened = false;
let restoredFlag = false;
let before: LoadedModel | null = null;
let roGuard: ReadonlyGuard | null = null;
const probeRoomSites = new Set<string>();

async function saveTagged(tag: string): Promise<Record<string, unknown>> {
  await roGuard?.assertUnchanged(tag);
  const r = await call("project_save", {});
  console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: ((r["warnings"] ?? []) as unknown[]).length }));
  if (!r["verified"]) throw new Error(`save ${tag} не verified: ${JSON.stringify(r["details"] ?? r).slice(0, 500)}`);
  await new Promise((res) => setTimeout(res, 5500)); // ≤1 сохранение в 5 с
  return r;
}

async function openAndGuard(): Promise<void> {
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  await call("render_plan", {});
  const ed = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = ed ? await ed.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");
}

async function deleteWallsBySiteIds(ids: Set<string>): Promise<void> {
  for (let guard = 0; guard < 40 && ids.size > 0; guard++) {
    const mg = await call("model_get", {});
    const walls = (mg["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const hit = walls.find((w) => ids.has(w.site_id));
    if (!hit) break;
    ids.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); created = created.filter((c) => c.siteId !== hit.site_id); }
    catch (e) { console.log(`wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); break; }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function stripProbeFields(): Promise<void> {
  if (probeRoomSites.size === 0) return;
  const rooms = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  for (const site of probeRoomSites) {
    const ref = roomsRef(site, rooms);
    for (const [name, args] of [
      ["finish_floor_anchor_set", { room_id: ref, at_mm: null }],
      ["finish_floor_offset_set", { room_id: ref, offset_mm: 0 }],
      ["finish_floor_remove", { room_id: ref }],
      ["room_set_name", { room_id: ref, name: null }],
      ["room_set_color", { room_id: ref, color: null }],
    ] as [string, Record<string, unknown>][]) {
      const r = await tryCall(name, args);
      if (!r.ok) console.log(`${name} ${ref} (зачистка):`, r.err?.slice(0, 150));
    }
  }
  console.log("зачистка полей/отделки: OK (комнат:", probeRoomSites.size, ")");
}

async function restoreByCaptured(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  await stripProbeFields();
  const wallIds = new Set(created.map((c) => c.siteId));
  await deleteWallsBySiteIds(wallIds);
  try { await saveTagged("restore"); }
  catch (e) { console.log("restore save:", String((e as Error).message).slice(0, 250)); }
  created = [];
  opened = false;
}

/** Пробная комната w×h (см), правее всей геометрии; возвращает roomId и полигон (см). */
async function makeTrialRoom(w: number, h: number): Promise<{ roomId: string; poly: Array<{ x: number; y: number }> }> {
  const beforeModel = await loadModel(ctx.session(), OBJECT_ID!, PLAN_ID!);
  const rawWalls = (beforeModel.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.x, wl.p2.x]));
  const maxY = Math.max(0, ...Object.values(rawWalls).flatMap((wl) => [wl.p1.y, wl.p2.y]));
  const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300;
  type Pt = { x: number; y: number };
  for (const [p1, p2] of [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ] as [Pt, Pt][]) {
    const res = await call("wall_add", { start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) }, end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) }, thickness_mm: 100 });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add без site_id");
    created.push({ kind: "wall", siteId: sid });
  }
  await saveTagged("trial-room");
  await openAndGuard();
  const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rooms = (after.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const entry = Object.entries(rooms).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1 && q.y >= oy - 1 && q.y <= oy + h + 1);
  });
  if (!entry) throw new Error("пробная комната не появилась");
  return { roomId: entry[0], poly: entry[1].polygon! };
}

function roomsRef(siteId: string, roomsList: Array<{ id: string; site_id?: string }>): string {
  return roomsList.find((r) => r.site_id === siteId)?.id ?? siteId;
}

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-347.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else if (process.argv[2] === "run") {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }
  if (process.argv[2] === "cleanup") {
    // откат пробы по бэкапу: трогаются ТОЛЬКО стены/комнаты, которых нет в бэкапе.
    // Отделка/поля снимаются инструментами, стены — wall_delete, затем save и sig-сверка.
    const backupWalls = new Set(Object.keys(((before.model["walls"] ?? {}) as Record<string, unknown>)));
    const backupRooms = new Set(Object.keys(((before.model["rooms2"] ?? before.model["rooms1"] ?? {}) as Record<string, unknown>)));
    const wallsNow = (before.model["walls"] ?? {}) as Record<string, { p1?: { x?: number; y?: number }; p2?: { x?: number; y?: number } }>;
    const newWalls = Object.keys(wallsNow).filter((id) => !backupWalls.has(id));
    const roomsNow = (before.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
    // комнаты-остатки: id нет в бэкапе ИЛИ полигон в bbox новых стен (+1 см)
    const xs: number[] = [], ys: number[] = [];
    for (const id of newWalls) {
      for (const p of [wallsNow[id]?.p1, wallsNow[id]?.p2]) {
        if (p && typeof p.x === "number" && typeof p.y === "number") { xs.push(p.x); ys.push(p.y); }
      }
    }
    const newRooms = Object.keys(roomsNow).filter((rid) => {
      if (backupRooms.has(rid)) return false;
      const poly = roomsNow[rid]!["polygon"] as Array<{ x: number; y: number }> | undefined;
      if (!poly || poly.length < 3 || xs.length === 0) return false;
      return poly.every((q) => q.x >= Math.min(...xs) - 1 && q.x <= Math.max(...xs) + 1 && q.y >= Math.min(...ys) - 1 && q.y <= Math.max(...ys) + 1);
    });
    console.log("cleanup: новых стен:", newWalls.length, "комнат-остатков:", JSON.stringify(newRooms));
    if (newWalls.length === 0 && newRooms.length === 0) {
      console.log("cleanup: остатков нет");
    } else {
      await openAndGuard();
      for (const rid of newRooms) probeRoomSites.add(rid);
      await stripProbeFields();
      await deleteWallsBySiteIds(new Set(newWalls));
      await saveTagged("cleanup");
      await openAndGuard();
      const afterClean = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const sigOkClean = sig(afterClean.model as Record<string, unknown>) === sig(before.model as Record<string, unknown>);
      console.log("cleanup: сверка с бэкапом (sig):", sigOkClean ? "OK" : "РАСХОЖДЕНИЕ");
      if (!sigOkClean) throw new Error("cleanup не восстановил бэкап");
    }
    roGuard.checkFinal("cleanup-финал").then((changed) => {
      console.log("контрольный проект:", changed ? "ИЗМЕНИЛСЯ" : "не изменился");
      if (changed) process.exitCode = 1;
    });
    console.log("347-finish9-live cleanup: PASS");
  } else {
  await openAndGuard();

  // ---- часть 1: подъём пола и точка укладки ----
  await roGuard.assertUnchanged("перед частью 1");
  const trial = await makeTrialRoom(400, 300);
  console.log("пробная комната:", trial.roomId);
  probeRoomSites.add(trial.roomId);
  const roomsList0 = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  const roomRef = roomsRef(trial.roomId, roomsList0);
  const floorSet = await call("finish_floor_set", { room_id: roomRef, cover: "laminate", plank_length_mm: 1200, plank_width_mm: 180 });
  console.log("finish_floor_set:", JSON.stringify(floorSet).slice(0, 150));
  await saveTagged("floor");
  const px = trial.poly.map((p) => p.x), py = trial.poly.map((p) => p.y);
  const off = await call("finish_floor_offset_set", { room_id: roomRef, offset_mm: 300 });
  console.log("finish_floor_offset_set:", JSON.stringify(off).slice(0, 150));
  const v1 = await call("model_validate", {});
  console.log("validate 1:", JSON.stringify({ ok: v1["ok"] }));
  await saveTagged("offset");
  await openAndGuard();
  const afterOff = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const floorRec = ((afterOff.model["rooms2"] ?? {}) as Record<string, { floors?: Array<Record<string, unknown>> }>)[trial.roomId]?.floors?.[0];
  console.log("reopen offset: f0offset =", floorRec?.["f0offset"], "cover =", floorRec?.["cover"]);
  if (!floorRec || floorRec["f0offset"] !== 30) throw new Error("подъём пола не дошёл до сервера (ожидался f0offset=30 см)");
  // точка укладки: 60% ширины/высоты полигона (внутри пола)
  const ax = Math.min(...px) + (Math.max(...px) - Math.min(...px)) * 0.6;
  const ay = Math.min(...py) + (Math.max(...py) - Math.min(...py)) * 0.6;
  const anchor = await call("finish_floor_anchor_set", { room_id: roomRef, at_mm: { x: Math.round(ax * 10), y: Math.round(ay * 10) } });
  console.log("finish_floor_anchor_set:", JSON.stringify(anchor).slice(0, 180));
  await saveTagged("anchor");
  await openAndGuard();
  const afterAnchor = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const floorRec2 = ((afterAnchor.model["rooms2"] ?? {}) as Record<string, { floors?: Array<Record<string, unknown>> }>)[trial.roomId]?.floors?.[0];
  const anchorRec = floorRec2?.["anchor"] as { p?: { x?: number; y?: number } } | undefined;
  console.log("reopen anchor:", JSON.stringify(anchorRec), "angle:", floorRec2?.["angle"]);
  if (!anchorRec?.p || Math.abs((anchorRec.p.x ?? 0) - ax) > 1 || Math.abs((anchorRec.p.y ?? 0) - ay) > 1) {
    throw new Error("точка укладки не совпала на сервере");
  }
  const render1 = await call("render_plan", {});
  console.log("render_plan:", JSON.stringify({ ok: render1["ok"] ?? true }));

  // ---- часть 2: имя/цвет зоны помещения (спецсимволы в имени) ----
  await roGuard.assertUnchanged("перед частью 2");
  const specialName = 'Комната "9" <тест> \\';
  const nameRes = await tryCall("room_set_name", { room_id: roomRef, name: specialName });
  if (nameRes.ok) {
    try { await saveTagged("name-special"); console.log("имя со спецсимволами: save verified"); }
    catch (e) {
      console.log("имя со спецсимволами: save отказал —", String((e as Error).message).slice(0, 250));
      await tryCall("room_set_name", { room_id: roomRef, name: "Зал 9" });
      await saveTagged("name-simple");
    }
  } else {
    console.log("room_set_name спецсимволы — отказ инструмента:", nameRes.err);
    await tryCall("room_set_name", { room_id: roomRef, name: "Зал 9" });
  }
  const colorRes = await tryCall("room_set_color", { room_id: roomRef, color: "#f5e9d0" });
  console.log("room_set_color:", colorRes.ok ? JSON.stringify(colorRes.res).slice(0, 120) : colorRes.err);
  const v2 = await call("model_validate", {});
  console.log("validate 2:", JSON.stringify({ ok: v2["ok"] }));
  await saveTagged("room-fields");
  await openAndGuard();
  const afterFields = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zonesAfter = ((afterFields.model["rooms2"] ?? {}) as Record<string, { zones?: Array<Record<string, unknown>> }>)[trial.roomId]?.zones ?? [];
  const gotName = typeof zonesAfter[0]?.["name"] === "string" ? zonesAfter[0]!["name"] : null;
  const gotColor = typeof zonesAfter[0]?.["color"] === "string" ? zonesAfter[0]!["color"] : null;
  console.log("reopen room-fields: name =", JSON.stringify(gotName), "color =", gotColor, "number_by_area =", zonesAfter[0]?.["number_by_area"]);
  if (gotName !== specialName && gotName !== "Зал 9") throw new Error(`имя комнаты не дошло до сервера: ${JSON.stringify(gotName)}`);
  if (gotColor !== "#f5e9d0") throw new Error(`цвет зоны не дошёл до сервера: ${JSON.stringify(gotColor)}`);

  // ---- часть 3: стена делит комнату — поля переживают деление (как в редакторе) ----
  await roGuard.assertUnchanged("перед частью 3");
  const splitX = Math.min(...px) + (Math.max(...px) - Math.min(...px)) / 2;
  // одна поперечная стена: от верхней грани до нижней (концы на осях стен — Т-стыки)
  const split = await call("wall_add", {
    start: { x: Math.round(splitX * 10), y: Math.round(Math.min(...py) * 10) },
    end: { x: Math.round(splitX * 10), y: Math.round(Math.max(...py) * 10) },
    thickness_mm: 100,
  });
  const sid = (split as { entity?: { site_id?: string } }).entity?.site_id;
  if (sid) created.push({ kind: "wall", siteId: sid });
  await saveTagged("split");
  await openAndGuard();
  const afterSplit = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rooms2 = (afterSplit.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; zones?: Array<Record<string, unknown>>; floors?: Array<Record<string, unknown>> }>;
  const parts = Object.entries(rooms2).filter(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= Math.min(...px) - 1 && q.x <= Math.max(...px) + 1 && q.y >= Math.min(...py) - 1 && q.y <= Math.max(...py) + 1);
  });
  console.log("после деления: частей:", parts.length);
  if (parts.length !== 2) throw new Error(`ожидались 2 части, найдено ${parts.length}`);
  // зачистка должна снять поля/отделку со ВСЕХ частей: id старой комнаты редактор
  // заменил на два новых
  for (const [rid] of parts) probeRoomSites.add(rid);
  const info = parts.map(([rid, r]) => ({
    rid,
    f0offset: r.floors?.[0]?.["f0offset"] ?? null,
    cover: r.floors?.[0]?.["cover"] ?? null,
    name: r.zones?.[0]?.["name"] ?? null,
    color: r.zones?.[0]?.["color"] ?? null,
  }));
  console.log("части:", JSON.stringify(info, null, 1));
  for (const p of info) {
    if (p.cover !== "laminate" || p.f0offset !== 30) throw new Error(`часть ${p.rid}: пол/подъём не пережили деление: ${JSON.stringify(p)}`);
  }
  if (!info.some((p) => p.name === gotName)) throw new Error("имя комнаты не пережило деление");
  if (!info.some((p) => p.color === "#f5e9d0")) throw new Error("цвет зоны не пережил деление");
  console.log("части 1–3: PASS");

  // ---- зачистка ----
  await roGuard.assertUnchanged("перед зачисткой");
  await restoreByCaptured();
  await openAndGuard();
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sigOk = sig(final.model as Record<string, unknown>) === sig(before!.model as Record<string, unknown>);
  console.log("сверка с бэкапом (sig):", sigOk ? "OK" : "РАСХОЖДЕНИЕ");
  if (!sigOk) throw new Error("финальная модель не совпала с бэкапом");
  const probeRoomLeft = trial.roomId in ((final.model["rooms2"] ?? {}) as Record<string, unknown>);
  console.log("пробная комната удалена:", !probeRoomLeft);
  roGuard.checkFinal("финал").then((changed) => {
    console.log("контрольный проект:", changed ? "ИЗМЕНИЛСЯ" : "не изменился");
    if (changed) process.exitCode = 1;
  });
  console.log("347-finish9-live: PASS");
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message).slice(0, 600));
  try { await restoreByCaptured(); } catch (e2) { console.error("restore:", String((e2 as Error).message).slice(0, 200)); }
  process.exitCode = 1;
} finally {
  await closeBrowser();
  process.exit(process.exitCode ?? 0);
}
