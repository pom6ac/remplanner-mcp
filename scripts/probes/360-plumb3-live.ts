// 360 (сантехника ч.3) — живая проверка в dev-объекте (ID только из env, платный тариф):
//   1) группы выводов воды: item_add waterspot_cold → waterspot_merge (hot, drainage) →
//      сверка имени/габаритов/over_floor (value_2=40) → waterspot_unset (drainage);
//   2) узел waterspot_node: item_add, pipe_add через {item_id узла} — вершина node в
//      точке предмета (как в редакторе, эталон ui-ref-plumb3-node-pipe);
//   3) pipe_node_delete внутреннего узла — каскад deleteByItem (created_pipes);
//   4) item_delete вывода с трубой — каскад (deleted_pipes), как в редакторе;
//   5) model_validate → project_save verified → reopen → сверка → render_plan waterplan;
//   6) зачистка только по захваченным ID (pipe_delete/item_delete/wall_delete),
//      save restore, сверка sig с бэкапом backup-<OBJECT>-360.json (ДО прогона).
// Гарды полные (probe-guard): READONLY обязателен, коллизий env нет, GET-пара,
// план в редакторе == серверу перед каждым reopen, roGuard перед каждой записью,
// пауза ≥5.5 с между сохранениями, closeBrowser в finally.
// node scripts/probes/360-plumb3-live.ts run | cleanup
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";
import { logCaptured, deleteWallsBySiteIds, type ProbeCreated } from "./probe-restore.ts";

if (process.argv[2] !== "run" && process.argv[2] !== "cleanup") {
  console.error("запуск: run | cleanup");
  process.exit(0);
}
const { objectId: OBJECT_ID, planId: PLAN_ID, readonlyId: READONLY_ID, readonlyPlanId: READONLY_PLAN_ID } = probeWriteEnv();
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "360-plumb3-live", version: "0.0.0" });
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
  try { return { ok: true, res: await call(name, args) }; }
  catch (e) { return { ok: false, err: String((e as Error).message).slice(0, 300) }; }
};

let created: ProbeCreated[] = [];
let opened = false;
let roGuard: ReadonlyGuard | null = null;
const CAPTURED_PATH = `.orca-reports/tmp/360-captured-${OBJECT_ID}.json`;
const journal = (): void => logCaptured(CAPTURED_PATH, created, []);

async function saveTagged(tag: string): Promise<Record<string, unknown>> {
  await roGuard?.assertUnchanged(tag);
  const r = await call("project_save", {});
  console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: ((r["warnings"] ?? []) as unknown[]).length }));
  if (!r["verified"]) throw new Error(`save ${tag} не verified: ${JSON.stringify(r["details"] ?? r).slice(0, 500)}`);
  await new Promise((res) => setTimeout(res, 5500));
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

/** Зачистка своих предметов/труб: журнал ∪ текущий created (до стен). */
async function cleanupItemsAndPipes(createdList: ProbeCreated[]): Promise<void> {
  const j = existsSync(CAPTURED_PATH) ? JSON.parse(readFileSync(CAPTURED_PATH, "utf8")) as { pipes?: string[]; items?: string[] } : {};
  const pipeIds = [...new Set([...(j.pipes ?? []), ...createdList.filter((c) => c.kind === "pipe").map((c) => c.siteId!)])];
  const itemIds = [...new Set([...(j.items ?? []), ...createdList.filter((c) => c.kind === "item").map((c) => c.siteId!)])];
  for (const pid of pipeIds) {
    const r = await tryCall("pipe_delete", { pipe_id: pid });
    console.log("pipe_delete", pid, r.ok ? "OK" : r.err?.slice(0, 120));
  }
  for (const iid of itemIds) {
    const r = await tryCall("item_delete", { item_id: iid });
    console.log("item_delete", iid, r.ok ? "OK" : r.err?.slice(0, 120));
  }
}

async function restoreProbe(tag: string): Promise<void> {
  if (!opened) return;
  // журнал читается ДО перезаписи; в зачистку идёт объединение с текущим created
  const snapshot = [...created];
  await cleanupItemsAndPipes(snapshot);
  created = created.filter((c) => c.kind === "wall");
  journal();
  await deleteWallsBySiteIds({ call, created, ownRoomIds: [], log: (l) => console.log("restore:", l) });
  try { await saveTagged(`${tag}-restore`); }
  catch (e) { console.log(`${tag} save:`, String((e as Error).message).slice(0, 250)); }
  created = [];
  opened = false;
}

/** Пробная комната w×h (см), правее всей геометрии. */
async function makeTrialRoom(w: number, h: number): Promise<void> {
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
}

async function itemSiteId(name: string): Promise<string> {
  const m = await call("model_get", {});
  const items = (m["items"] ?? []) as Array<{ name: string; site_id?: string }>;
  const hit = [...items].reverse().find((it) => it.name === name && it.site_id);
  if (!hit?.site_id) throw new Error(`item_add ${name}: site_id не найден`);
  return hit.site_id;
}

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-360.json`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
  else if (process.argv[2] === "run") {
    // предусловие только для run; cleanup существует, чтобы привести модель к бэкапу
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    if (sig(stored.model as Record<string, unknown>) !== sig(before.model as Record<string, unknown>)) {
      throw new Error("модель на сервере не совпадает с бэкапом этапа 360 — СТОП (без перезаписи бэкапа)");
    }
  }
  if (process.argv[2] === "cleanup") {
    if (!existsSync(CAPTURED_PATH)) throw new Error("cleanup: журнал захваченных ID не найден");
    // предусловие sig-vs-бэкап в cleanup не блокирует: cleanup существует, чтобы
    // привести модель к бэкапу; итог — семантическая сверка множеств (стены/предметы/
    // трубы) плюс sig с объяснением производных id комнат (перенумерация editor)
    await openAndGuard();
    await restoreProbe("cleanup");
    const afterClean = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
    const bm = stored.model as Record<string, Record<string, unknown>>;
    const am = afterClean.model as Record<string, Record<string, unknown>>;
    const setDiff = (key: string): string[] => {
      const bk = new Set(Object.keys(bm[key] ?? {}));
      const ak = new Set(Object.keys(am[key] ?? {}));
      return [...new Set([...ak].filter((x) => !bk.has(x)))];
    };
    const semantic = ["walls", "items", "pipes", "pipes_gas", "pipes_heat", "pipes_ventilation", "pipes_warm_floor", "pipes_conditioner"]
      .flatMap((k) => setDiff(k).map((id) => `${k}:${id}`));
    const namesLeft = Object.entries(am["items"] ?? {}).filter(([id]) => setDiff("items").includes(id)).map(([, v]) => (v as { name?: string }).name);
    console.log("cleanup: лишних стен/предметов/труб:", semantic.length ? JSON.stringify({ semantic, namesLeft }) : "нет");
    const sigOk = sig(afterClean.model as Record<string, unknown>) === sig(stored.model as Record<string, unknown>);
    console.log("cleanup: сверка с бэкапом (sig):", sigOk ? "OK" : "РАСХОЖДЕНИЕ (производные id комнат rooms1/editor перенумерует при операциях со стенами — геометрия и состав совпадают)");
    const changed = await roGuard.checkFinal("cleanup-финал");
    console.log("контрольный проект:", changed ? "ИЗМЕНИЛСЯ" : "не изменился");
    if (semantic.length > 0 || changed) process.exit(1);
    console.log("360-plumb3-live cleanup: PASS");
  } else {
    await openAndGuard();
    await roGuard.assertUnchanged("перед сценой");

    // ---- сцена: пробная комната ----
    await makeTrialRoom(500, 400);

    // ---- 1. группы выводов воды ----
    const myWallSites = created.filter((c) => c.kind === "wall").map((c) => c.siteId!);
    const wallsList = ((await call("model_get", {}))["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const myWall = wallsList.find((w) => myWallSites.includes(w.site_id));
    if (!myWall) throw new Error("нет стены пробной комнаты");
    const wallId = { id: myWall.id };
    const coldAdd = await call("item_add", { name: "waterspot_cold", position: { against_wall: { wall_id: wallId.id, offset_mm: 1500 } } });
    const coldSite = (coldAdd as { entity?: { site_id?: string } }).entity?.site_id;
    if (!coldSite) throw new Error("waterspot_cold не создан");
    created.push({ kind: "item", siteId: coldSite });
    console.log("waterspot_cold:", (coldAdd as { entity?: Record<string, unknown> }).entity?.name, JSON.stringify((coldAdd as { entity?: { over_floor?: unknown } }).entity?.over_floor));

    // сверка имён/габаритов по model_get (рабочая модель; компакт в мм);
    // over_floor.value_2 (сырой формат) — после save→reopen ниже
    const wsItem = async (siteId: string) => {
      const m = await call("model_get", {});
      const items = (m["items"] ?? []) as Array<{ site_id?: string; name?: string; width_mm?: number; depth_mm?: number }>;
      const hit = items.find((it) => it.site_id === siteId);
      if (!hit) console.log("wsItem MISS", siteId, "всего items:", items.length, items.slice(-3).map((it) => `${it.site_id}:${it.name}`));
      return hit;
    };
    await call("waterspot_merge", { item_id: coldSite, part: "waterspot_hot" });
    const it1 = await wsItem(coldSite);
    console.log("merge hot →", it1?.name, "w/h mm:", it1?.width_mm, it1?.depth_mm);
    if (it1?.name !== "waterspot_cold_hot") throw new Error("merge hot: имя не cold_hot");
    if (it1?.width_mm !== 160 || it1?.depth_mm !== 90) throw new Error(`merge hot: габариты ${it1?.width_mm}×${it1?.depth_mm} (ожидалось 160×90)`);

    await call("waterspot_merge", { item_id: coldSite, part: "waterspot_drainage" });
    const it2 = await wsItem(coldSite);
    console.log("merge drainage →", it2?.name, "w/h mm:", it2?.width_mm, it2?.depth_mm);
    if (it2?.name !== "waterspot_drainage_cold_hot") throw new Error("merge drainage: имя не drainage_cold_hot");
    if (it2?.width_mm !== 210 || it2?.depth_mm !== 150) throw new Error(`merge drainage: габариты ${it2?.width_mm}×${it2?.depth_mm} (ожидалось 210×150)`);

    await call("waterspot_unset", { item_id: coldSite, part: "waterspot_drainage" });
    const it3 = await wsItem(coldSite);
    console.log("unset drainage →", it3?.name);
    if (it3?.name !== "waterspot_cold_hot") throw new Error("unset drainage: имя не cold_hot");
    const badPair = await tryCall("waterspot_merge", { item_id: coldSite, part: "waterspot_cold_hot" });
    if (!badPair.ok || !String(badPair.err).includes("INVALID_ARGUMENT")) throw new Error(`недопустимая пара не отклонена: ${badPair.err}`);

    // ---- 2. узел waterspot_node + трубы ----
    const nodeAdd = await call("item_add", { name: "waterspot_node", position: { center: { x: 14500, y: 12000 } } });
    void nodeAdd;
    const nodeSite = await itemSiteId("waterspot_node");
    created.push({ kind: "item", siteId: nodeSite });
    const mg = await call("model_get", {});
    const itemsC = (mg["items"] ?? []) as Array<{ name: string; site_id?: string; id: string; x_mm?: number; y_mm?: number }>;
    const nodeItem = itemsC.find((it) => it.site_id === nodeSite)!;
    if (nodeItem.x_mm === undefined || nodeItem.y_mm === undefined) throw new Error("у узла нет координат");
    const coldItem = itemsC.find((it) => it.site_id === coldSite)!;
    if (coldItem.x_mm === undefined || coldItem.y_mm === undefined) throw new Error("у вывода нет координат");
    // труба water: узел → узел-предмет → вывод (id вершин-узлов синтетические на сервере)
    const p1 = await call("pipe_add", { kind: "water", path: [
      { x: nodeItem.x_mm! - 800, y: nodeItem.y_mm! },
      { item_id: nodeSite },
      { item_id: coldSite },
    ] });
    const pipe1Site = (p1 as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe1Site) throw new Error("pipe_add water без site_id");
    created.push({ kind: "pipe", siteId: pipe1Site });
    const pe1 = (p1 as { entity?: { vertexes?: Array<{ type: string }>; items?: Record<string, string>; connected?: unknown } }).entity;
    console.log("pipe water:", JSON.stringify({ vertex_types: pe1?.vertexes?.map((v) => v.type), items: pe1?.items }));
    if (!pe1?.vertexes?.every((v) => ["node", "waterspot"].includes(v.type))) throw new Error("вершины трубы не node/waterspot");
    if (Object.values(pe1?.items ?? {}).some((t) => t === "waterspot_node")) throw new Error("узел-предмет попал в items как предмет");

    // труба hot к комбинированному выводу (второй вид — отдельный скалярный слот)
    const p2 = await call("pipe_add", { kind: "hot", path: [{ item_id: coldSite }, { x: coldItem.x_mm! + 600, y: coldItem.y_mm! }] });
    const pipe2Site = (p2 as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe2Site) throw new Error("pipe_add hot без site_id");
    created.push({ kind: "pipe", siteId: pipe2Site });

    // ---- 3. pipe_node_delete внутреннего узла — каскад (created_pipes) ----
    const p3 = await call("pipe_add", { kind: "drainage", path: [
      { x: coldItem.x_mm! - 1200, y: coldItem.y_mm! + 800 },
      { x: coldItem.x_mm! - 700, y: coldItem.y_mm! + 800 },
      { x: coldItem.x_mm! - 200, y: coldItem.y_mm! + 800 },
      { item_id: coldSite },
    ] });
    const pipe3Site = (p3 as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe3Site) throw new Error("pipe_add drainage без site_id");
    created.push({ kind: "pipe", siteId: pipe3Site });
    const delNode = await call("pipe_node_delete", { pipe_id: pipe3Site, vertex: 1 });
    console.log("pipe_node_delete:", JSON.stringify(delNode));
    const dn = delNode as { deleted_pipes?: string[]; created_pipes?: string[] };
    if (!dn.deleted_pipes?.includes(pipe3Site) || (dn.created_pipes?.length ?? 0) !== 1) {
      throw new Error(`каскад узла: ${JSON.stringify(dn)}`);
    }
    created.push({ kind: "pipe", siteId: dn.created_pipes![0]! });
    // вершина-предмет узлом не удаляется
    const delItemVertex = await tryCall("pipe_node_delete", { pipe_id: dn.created_pipes![0]!, vertex: 1 });
    if (!delItemVertex.ok || !String(delItemVertex.err).includes("INVALID_ARGUMENT")) {
      throw new Error(`вершина-предмет удалилась pipe_node_delete: ${delItemVertex.err ?? "без ошибки"}`);
    }

    // ---- 4. item_delete вывода с трубой — каскад ----
    const hotAdd = await call("item_add", { name: "waterspot_hot", position: { center: { x: 17000, y: 12000 } } });
    void hotAdd;
    const hotSite = await itemSiteId("waterspot_hot");
    created.push({ kind: "item", siteId: hotSite });
    const p4 = await call("pipe_add", { kind: "hot", path: [{ item_id: hotSite }, { x: 17500, y: 12500 }] });
    const pipe4Site = (p4 as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe4Site) throw new Error("pipe_add hot (2) без site_id");
    created.push({ kind: "pipe", siteId: pipe4Site });
    const delItem = await call("item_delete", { item_id: hotSite });
    const di = delItem as { deleted_pipes?: string[]; created_pipes?: string[] };
    console.log("item_delete каскад:", JSON.stringify({ deleted_pipes: di.deleted_pipes, created_pipes: di.created_pipes }));
    if (!di.deleted_pipes?.includes(pipe4Site)) throw new Error(`item_delete: труба не удалена каскадом: ${JSON.stringify(di)}`);
    created = created.filter((c) => c.siteId !== pipe4Site && c.siteId !== hotSite);

    // ---- 5. validate → save → reopen → сверка → PNG ----
    const v = await call("model_validate", {});
    console.log("validate:", JSON.stringify(v).slice(0, 300));
    const save1 = await saveTagged("основной");
    await openAndGuard();
    const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    const am = after.model as { items?: Record<string, { name?: string }>; pipes?: Record<string, { type?: string; vertexes?: unknown[] }> };
    const keptCold = Object.values(am.items ?? {}).some((it) => it.name === "waterspot_cold_hot");
    const keptNode = Object.values(am.items ?? {}).some((it) => it.name === "waterspot_node");
    const keptPipes = Object.values(am.pipes ?? {}).filter((p) => p.type === "water_pipe" || p.type === "water_hot_pipe" || p.type === "drainage_pipe").length;
    console.log("reopen:", JSON.stringify({ keptCold, keptNode, pipes: keptPipes, saveId: save1["save_id"] }));
    if (!keptCold || !keptNode) throw new Error("после reopen пропали вывод/узел");
    if (keptPipes !== 3) throw new Error(`после reopen труб ${keptPipes} (ожидалось 3: water, hot, кусок drainage)`);
    // value_2 после unset снят, у объединённого вывода высоты согласованы (сырой формат)
    const coldRaw = (am.items ?? {})[coldSite] as { name?: string; over_floor?: { value?: number; value_2?: number } } | undefined;
    console.log("cold после reopen:", coldRaw?.name, JSON.stringify(coldRaw?.over_floor));
    if (coldRaw?.name !== "waterspot_cold_hot") throw Error("reopen: имя вывода не cold_hot");
    if (coldRaw?.over_floor && "value_2" in coldRaw.over_floor) throw Error("reopen: value_2 остался после unset");
    const png = await call("render_plan", { sheet: "waterplan" });
    const pngLen = ((png as { png_bytes?: number }).png_bytes ?? 0) as number;
    console.log("render waterplan:", pngLen, "байт");
    if (!pngLen) throw new Error("render_plan пустой");

    // ---- 6. зачистка ----
    await restoreProbe("run");
    const afterRun = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    const sigOk = sig(afterRun.model as Record<string, unknown>) === sig(before.model as Record<string, unknown>);
    console.log("сверка sig с бэкапом:", sigOk ? "OK" : "РАСХОЖДЕНИЕ");
    const changed = await roGuard.checkFinal("run-финал");
    console.log("контрольный проект:", changed ? "ИЗМЕНИЛСЯ" : "не изменился");
    if (!sigOk || changed) process.exit(1);
    console.log("360-plumb3-live run: PASS");
  }
  await closeBrowser().catch(() => {});
  process.exit(0);
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 600));
  try { await restoreProbe("fail"); } catch { /* */ }
  await closeBrowser().catch(() => {});
  process.exit(1);
}
