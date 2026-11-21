// 328 (живая проверка, dev-объект, ID только из env):
// 1) MCP ceiling_hole_add в пробной комнате → validate → project_save без
//    NORMALIZATION_DROPPED → reopen → сверка → render PNG;
// 2) деление пробной комнаты стеной — потолочный проём переживает save без
//    ложной блокировки (правило new-entity-section: тест «стена делит комнату»);
// 3) finish_ceiling_complex_set → save → reopen → сверка complex-полей;
// 4) зачистка: ceiling_hole_delete, удаление стен пробной комнаты, save,
//    семантическая сверка с бэкапом.
// Гарды полные (285 №3 + ревью 319 №3/№4): ID из env, OBJECT_ID != READONLY_ID,
// PLAN_ID != READONLY_PLAN_ID, GET-пара (probe-guard), план в редакторе ==
// серверу (compat), бэкап + сверка sig(), контрольный проект (READONLY_ID из env) —
// фиксированный эталон (файл не перезаписывается), проверка перед каждой фазой
// записи и в finally, restore по захваченным site_id, closeBrowser.
// node scripts/probes/328-live.ts run
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"] as string;
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"] as string;
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"] as string;
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] as string;
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) { console.error("нужны env"); process.exit(1); }
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "328-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};

let created: Array<{ kind: string; siteId?: string }> = [];
let opened = false;
let restoredFlag = false;
// комнаты пробы (334: отделка мешает wall_delete — нормализация теряет отделку
// исчезнувшей комнаты → INVALID_GEOMETRY; перед удалением стен снимаем complex
// и покрытие)
const probeRoomSites = new Set<string>();

/** Снять отделку пробных комнат (complex → смена материала, затем ластик). */
async function stripProbeFinishes(): Promise<void> {
  if (probeRoomSites.size === 0) return;
  const rooms = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  for (const site of probeRoomSites) {
    const ref = rooms.find((r) => r.site_id === site)?.id ?? site;
    try {
      const cs = await call("finish_ceiling_set", { room_id: ref, material: "stretch_ceiling" });
      console.log(`finish_ceiling_set ${ref} (зачистка):`, (cs as { isError?: boolean }).isError ? "отказ" : JSON.stringify((cs as { warnings?: string[] }).warnings ?? []));
    } catch (e) { console.log(`finish_ceiling_set ${ref} (зачистка):`, String((e as Error).message).slice(0, 120)); }
    try {
      const rm = await call("finish_ceiling_remove", { room_id: ref });
      console.log(`finish_ceiling_remove ${ref} (зачистка):`, (rm as { isError?: boolean }).isError ? "отказ" : "OK");
    } catch (e) { console.log(`finish_ceiling_remove ${ref} (зачистка):`, String((e as Error).message).slice(0, 120)); }
  }
}
let before: LoadedModel | null = null;
let roGuard: ReadonlyGuard | null = null;

async function saveTagged(tag: string): Promise<Record<string, unknown>> {
  await roGuard?.assertUnchanged(tag);
  const r = await call("project_save", {});
  console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: r["warnings"] }));
  if (!r["verified"]) throw new Error(`save ${tag} не verified`);
  await new Promise((res) => setTimeout(res, 5500)); // ≤1 сохранение в 5 с
  return r;
}

async function deleteWallsBySiteIds(ids: Set<string>): Promise<void> {
  for (let guard = 0; guard < 40 && ids.size > 0; guard++) {
    const mg = await call("model_get", {});
    const walls = (mg["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const hit = walls.find((w) => ids.has(w.site_id));
    if (!hit) break;
    ids.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); created = created.filter((c) => !(c.kind === "wall" && c.siteId === hit.site_id)); }
    catch (e) { console.log(`wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); break; }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function restoreByCaptured(): Promise<void> {
  if (restoredFlag || !opened) return;
  restoredFlag = true;
  await stripProbeFinishes();
  const mg = await call("model_get", {});
  const holes = (mg["level_holes"] ?? []) as Array<{ id: string; site_id: string }>;
  for (const h of holes) {
    if (!created.some((c) => c.kind === "hole" && c.siteId === h.site_id)) continue;
    try { await call("ceiling_hole_delete", { ceiling_hole_id: h.site_id }); created = created.filter((c) => c.siteId !== h.site_id); }
    catch (e) { console.log("ceiling_hole_delete:", String((e as Error).message).slice(0, 150)); }
  }
  const wallIds = new Set(created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!));
  await deleteWallsBySiteIds(wallIds);
  try {
    await saveTagged("restore");
  } catch (e) { console.log("restore save:", String((e as Error).message).slice(0, 250)); }
  created = [];
  opened = false;
}

/** Пробная комната w×h (см), правее всей геометрии; возвращает roomId и полигон. */
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
  await openAndGuard(); // ревью 329 №13: гард «план в редакторе == серверу» перед каждым reopen
  const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const rooms = (after.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const entry = Object.entries(rooms).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1 && q.y >= oy - 1 && q.y <= oy + h + 1);
  });
  if (!entry) throw new Error("пробная комната не появилась");
  return { roomId: entry[0], poly: entry[1].polygon! };
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

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = ".orca-reports/backup-".concat(OBJECT_ID, "-328.json");
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом — стоп");
    }
  }

  // ---- часть 1: проём в потолке в пробной комнате ----
  await roGuard.assertUnchanged("перед частью 1");
  await openAndGuard();
  const trial = await makeTrialRoom(300, 260); // 7.8 м² — хватает и для complex
  console.log("пробная комната:", trial.roomId);
  // ревью 335 n2: сайт зачистки регистрируется СРАЗУ — если проба упадёт до
  // шага зачистки, restoreByCaptured в finally всё равно снимет отделку
  probeRoomSites.add(trial.roomId);
  const mgRooms = await call("model_get", {});
  const roomRef = ((mgRooms["rooms"] ?? []) as Array<{ id: string; site_id?: string }>).find((r) => (r as { site_id?: string }).site_id === trial.roomId)?.id ?? trial.roomId;
  const px = trial.poly.map((p) => p.x), py = trial.poly.map((p) => p.y);
  const cx = (Math.min(...px) + Math.max(...px)) / 2, cy = (Math.min(...py) + Math.max(...py)) / 2;
  const hole = await call("ceiling_hole_add", {
    corner1: { x: Math.round((cx - 40) * 10), y: Math.round((cy - 40) * 10) },
    corner2: { x: Math.round((cx + 40) * 10), y: Math.round((cy + 40) * 10) },
  });
  console.log("ceiling_hole_add:", JSON.stringify(hole).slice(0, 220));
  const holeSite = (hole as { entity?: { site_id?: string } }).entity?.site_id ?? "";
  if (!holeSite) throw new Error("ceiling_hole_add без site_id");
  created.push({ kind: "hole", siteId: holeSite });
  const v = await call("model_validate", {});
  console.log("validate:", JSON.stringify({ ok: v["ok"] }));
  await saveTagged("hole");
  await openAndGuard();
  const after1 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const holes1 = Object.values((after1.model["level_holes"] ?? {}) as Record<string, Record<string, unknown>>).filter((h) => h["type"] === "ceiling_hole");
  console.log("reopen: ceiling_holes:", holes1.length, JSON.stringify(holes1.map((h) => ({ plan: h["plan"], area: h["area"], id_room: String(h["id_room"] ?? "").slice(0, 8) }))));
  if (holes1.length !== 1 || holes1[0]!["plan"] !== "ceiling") throw new Error("проём в потолке не дошёл до сервера");
  const render1 = await call("render_plan", {});
  console.log("render_plan:", JSON.stringify({ ok: render1["ok"] ?? true }));

  // ---- часть 2: стена делит комнату — проём переживает save без ложной блокировки ----
  await roGuard.assertUnchanged("перед частью 2");
  // стена НЕ через проём: в верхней трети комнаты (проём в центре)
  const splitY = Math.min(...py) + 40;
  const split = await call("wall_add", {
    start: { x: Math.round(Math.min(...px) * 10) + 10, y: Math.round(splitY * 10) },
    end: { x: Math.round(Math.max(...px) * 10) - 10, y: Math.round(splitY * 10) },
    thickness_mm: 100,
  });
  const splitSite = (split as { entity?: { site_id?: string } }).entity?.site_id;
  if (splitSite) created.push({ kind: "wall", siteId: splitSite });
  await saveTagged("split-wall");
  await openAndGuard();
  const after2 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const holes2 = Object.values((after2.model["level_holes"] ?? {}) as Record<string, Record<string, unknown>>).filter((h) => h["type"] === "ceiling_hole");
  console.log("после деления стеной: ceiling_holes:", holes2.length, JSON.stringify(holes2.map((h) => ({ area: h["area"], id_room: String(h["id_room"] ?? "").slice(0, 8) }))));
  if (holes2.length < 1) throw new Error("проём исчез при делении комнаты — требуется разбор");

  // ---- часть 3: двухуровневый потолок в одной из половин ----
  await roGuard.assertUnchanged("перед частью 3");
  // комната, содержащая центр верхней половины
  const upPoint = { x: cx, y: cy - 60 };
  const roomsForComplex = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)).model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const targetRoom = Object.entries(roomsForComplex).find(([, r]) => {
      const p = r.polygon ?? [];
      if (p.length < 3) return false;
      let inside = false;
      for (let i = 0, n = p.length; i < n; i++) {
        const a2 = p[i]!, b2 = p[(i + 1) % n]!;
        if ((a2.y > upPoint.y) !== (b2.y > upPoint.y) && upPoint.x < ((b2.x - a2.x) * (upPoint.y - a2.y)) / (b2.y - a2.y) + a2.x) inside = !inside;
      }
      return inside;
    });
  if (!targetRoom) throw new Error("комната верхней половины не найдена");
  console.log("комната для complex:", targetRoom[0]);
  // ревью 335 n2: комната complex — в сайты зачистки ДО установки complex,
  // иначе падение между set и зачисткой оставит отделку и wall_delete упрётся
  probeRoomSites.add(targetRoom[0]);
  const roomsList = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
  const roomRef2 = roomsList.find((r) => r.site_id === targetRoom[0])?.id ?? targetRoom[0];
  const cxU = (Math.min(...targetRoom[1].polygon!.map((p) => p.x)) + Math.max(...targetRoom[1].polygon!.map((p) => p.x))) / 2;
  const cyU = (Math.min(...targetRoom[1].polygon!.map((p) => p.y)) + Math.max(...targetRoom[1].polygon!.map((p) => p.y))) / 2;
  const complex = await call("finish_ceiling_complex_set", { room_id: roomRef2, at_mm: { x: Math.round(cxU * 10), y: Math.round(cyU * 10) } });
  console.log("finish_ceiling_complex_set:", JSON.stringify(complex).slice(0, 200));
  const v3 = await call("model_validate", {});
  console.log("validate 3:", JSON.stringify({ ok: v3["ok"] }));
  await saveTagged("complex");
  await openAndGuard();
  const after3 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const room3 = ((after3.model["rooms2"] ?? {}) as Record<string, { ceilings?: Array<Record<string, unknown>> }>)[targetRoom[0]]!;
  const complexRec = (room3["ceilings"] ?? []).find((c) => c["complex"] === true);
  console.log("reopen complex:", JSON.stringify(complexRec ? { material: complexRec["material"], material2: complexRec["material2"], level: complexRec["level"], level2: complexRec["level2"], offset: complexRec["offset"], radius: complexRec["radius"], type: complexRec["type"], poly: (complexRec["polygon2"] as unknown[] | undefined)?.length ?? null } : null));
  if (!complexRec || complexRec["material2"] !== "stretch_ceiling") throw new Error("двухуровневый потолок не пережил save/reopen");

  // ---- зачистка ----
  await roGuard.assertUnchanged("перед зачисткой");
  await stripProbeFinishes();
  await call("ceiling_hole_delete", { ceiling_hole_id: holeSite });
  created = created.filter((c) => !(c.kind === "hole"));
  const wallIds = new Set(created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!));
  await saveTagged("cleanup-hole");
  await openAndGuard();
  await deleteWallsBySiteIds(wallIds);
  await saveTagged("cleanup-walls");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 1500));
  process.exitCode = 1;
} finally {
  try { await restoreByCaptured(); } catch (ce) { console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400)); process.exitCode = 1; }
  try {
    if (before) {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model);
      console.log("семантическая сверка с бэкапом:", same ? "OK" : "РАСХОЖДЕНИЕ");
      if (!same) process.exitCode = 1;
    }
  } catch (ce) { console.error("final:", String((ce as Error).message ?? ce).slice(0, 250)); }
  try { await roGuard?.checkFinal("finally"); } catch (ce) { console.error("ro:", String((ce as Error).message ?? ce).slice(0, 200)); }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
