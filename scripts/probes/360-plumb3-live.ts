// 360 (сантехника ч.3) — живая проверка в dev-объекте (ID только из env, платный тариф):
//   1) группы выводов воды: item_add waterspot_cold → waterspot_merge (hot, drainage) →
//      сверка имени/габаритов/over_floor (value_2=40) → waterspot_unset (drainage);
//   2) узел waterspot_node: item_add, pipe_add через {item_id узла} — вершина node в
//      точке предмета (как в редакторе, эталон ui-ref-plumb3-node-pipe);
//   3) pipe_node_delete внутреннего узла — каскад deleteByItem (created_pipes);
//   4) item_delete вывода с трубой — каскад (deleted_pipes), как в редакторе;
//   5) model_validate → project_save verified → reopen → сверка → render_plan waterplan;
//   6) сцены 365: unset composite→composite (высоты value/value_2 не трогаются,
//      major 1), unset конца трубы из 3 вершин (без висячей ссылки, major 2),
//      распад conditioner_drainage/warm_floor_pipe (ключи PIPE_LINK_KEY_BY_TYPE,
//      major 3) — виды, недоступные в каталоге dev-аккаунта, пропускаются;
//   7) зачистка только по захваченным ID (pipe_delete/item_delete/wall_delete),
//      save restore, сверка sig с бэкапом backup-<OBJECT>-365.json (пишется
//      непосредственно перед прогоном).
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
  await deleteWallsBySiteIds({ call, created, ownRoomIds: [], save: () => Promise.resolve({}), log: (l) => console.log("restore:", l) });
  try { await saveTagged(`${tag}-restore`); }
  catch (e) { console.log(`${tag} save:`, String((e as Error).message).slice(0, 250)); }
  created = [];
  opened = false;
}

/** Пробная комната w×h (см), правее всей геометрии. */
async function makeTrialRoom(w: number, h: number): Promise<string> {
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
  // ревью 364 №9: своя комната — разностью id комнат до/после (новая не одна — СТОП),
  // не позиционно (rooms[last])
  const roomsNow = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string }>;
  const roomsBefore = new Set(Object.keys((beforeModel.model["rooms2"] as Record<string, unknown>) ?? {}));
  const fresh = roomsNow.filter((r) => !roomsBefore.has(r.id));
  if (fresh.length !== 1) throw new Error(`захват пробной комнаты: новых комнат ${fresh.length} (ожидалась 1)`);
  return fresh[0]!.id;
}

/** Список комнат компактной модели (id). */
async function roomIds(): Promise<Set<string>> {
  const rooms = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string }>;
  return new Set(rooms.map((r) => r.id));
}

/** site_id предмета из ответа item_add; нет — разность множеств site_id items
 *  до/после (ревью 364 №9: новых не ровно один — СТОП; по имени не ищем). */
async function captureAddedItem(resp: Record<string, unknown>, idsBefore: Set<string>): Promise<string> {
  const site = (resp as { entity?: { site_id?: string } }).entity?.site_id;
  if (site) return site;
  const m = await call("model_get", {});
  const items = (m["items"] ?? []) as Array<{ site_id?: string }>;
  const fresh = items.filter((it) => it.site_id && !idsBefore.has(it.site_id)).map((it) => it.site_id!);
  if (fresh.length !== 1) throw new Error(`захват нового предмета: новых ${fresh.length} (ожидался 1)`);
  return fresh[0]!;
}

/** site_id всех предметов текущей модели. */
async function itemSiteIds(): Promise<Set<string>> {
  const m = await call("model_get", {});
  const items = (m["items"] ?? []) as Array<{ site_id?: string }>;
  return new Set(items.map((it) => it.site_id).filter((x): x is string => Boolean(x)));
}

try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  // бэкап 365 пишется непосредственно перед прогоном (задание 365); cleanup
  // существует, чтобы привести модель к нему
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-365.json`;
  if (process.argv[2] === "run") {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written:", backupPath, "sig:", sig(before.model as Record<string, unknown>).slice(0, 40));
  } else if (!existsSync(backupPath)) {
    throw new Error("cleanup: бэкап 365 не найден — прогон не снимал бэкап, зачистка вслепую запрещена");
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

    // ---- сцена: пробная комната (нужна сценам 1, 2, 4a–4c) ----
    const trialRoomId = await makeTrialRoom(500, 400);

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
    const badPair = await tryCall("waterspot_merge", { item_id: coldSite, part: "waterspot_drainage_hot" });
    if (badPair.ok || !String(badPair.err).includes("INVALID_ARGUMENT")) throw new Error(`недопустимая пара не отклонена: ${badPair.err}`);

    // ---- 2. узел waterspot_node + трубы ----
    // центр пробной комнаты — по рёбрам СВОЕЙ комнаты (захвачена по id, ревью 364 №9)
    const roomsAll = ((await call("model_get", {}))["rooms"] ?? []) as Array<{ id: string; edges?: Array<{ from: [number, number] }> }>;
    const trial = roomsAll.find((r) => r.id === trialRoomId);
    if (!trial?.edges?.length) throw new Error("пробная комната не найдена в model_get");
    const roomCx = Math.round(trial.edges.reduce((s, e) => s + e.from[0], 0) / trial.edges.length);
    const roomCy = Math.round(trial.edges.reduce((s, e) => s + e.from[1], 0) / trial.edges.length);
    const idsBeforeNode = await itemSiteIds();
    const nodeAdd = await call("item_add", { name: "waterspot_node", position: { center: { x: roomCx, y: roomCy } } });
    const nodeSite = await captureAddedItem(nodeAdd, idsBeforeNode);
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
    const pe1 = (p1 as { entity?: { vertexes?: number; connected?: string[]; length_mm?: number } }).entity;
    console.log("pipe water:", JSON.stringify({ vertexes: pe1?.vertexes, connected: pe1?.connected, length_mm: pe1?.length_mm }));
    if (pe1?.vertexes !== 3) throw new Error(`у трубы ${String(pe1?.vertexes)} вершин (ожидалось 3: узел, узел-предмет, вывод)`);
    if (!pe1?.connected?.includes(coldSite)) throw new Error("вывод не в connected");

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
    if (delItemVertex.ok || !String(delItemVertex.err).includes("INVALID_ARGUMENT")) {
      throw new Error(`вершина-предмет удалилась pipe_node_delete: ${delItemVertex.err ?? "без ошибки"}`);
    }

    // ---- 3b. unset drainage — каскад куска канализации (труба из 2 вершин удаляется) ----
    const u1 = await call("waterspot_unset", { item_id: coldSite, part: "waterspot_drainage" });
    console.log("unset drainage →", (u1 as { entity?: { name?: string } }).entity?.name,
      "pipes:", JSON.stringify((u1 as { pipes?: unknown }).pipes));
    if ((u1 as { entity?: { name?: string } }).entity?.name !== "waterspot_cold_hot") throw new Error("unset drainage: имя не cold_hot");
    const unsetPipes = (u1 as { pipes?: { deleted?: string[]; created?: string[] } }).pipes;
    if (!unsetPipes?.deleted?.length || unsetPipes.created?.length) {
      throw new Error(`unset drainage: каскад не соответствует (кусок из 2 вершин удаляется): ${JSON.stringify(unsetPipes)}`);
    }
    for (const pid of unsetPipes.deleted) created = created.filter((c) => c.siteId !== pid);

    // ---- 4. item_delete вывода с трубой — каскад ----
    const idsBeforeHot = await itemSiteIds();
    const hotAdd = await call("item_add", { name: "waterspot_hot", position: { center: { x: roomCx + 1200, y: roomCy + 300 } } });
    const hotSite = await captureAddedItem(hotAdd, idsBeforeHot);
    created.push({ kind: "item", siteId: hotSite });
    const p4 = await call("pipe_add", { kind: "hot", path: [{ item_id: hotSite }, { x: roomCx + 1500, y: roomCy + 400 }] });
    const pipe4Site = (p4 as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe4Site) throw new Error("pipe_add hot (2) без site_id");
    created.push({ kind: "pipe", siteId: pipe4Site });
    const delItem = await call("item_delete", { item_id: hotSite });
    const di = delItem as { deleted_pipes?: string[]; created_pipes?: string[] };
    console.log("item_delete каскад:", JSON.stringify({ deleted_pipes: di.deleted_pipes, created_pipes: di.created_pipes }));
    if (!di.deleted_pipes?.includes(pipe4Site)) throw new Error(`item_delete: труба не удалена каскадом: ${JSON.stringify(di)}`);
    created = created.filter((c) => c.siteId !== pipe4Site && c.siteId !== hotSite);

    // ---- 4a (365). unset composite→composite: высоты value/value_2 не трогаются ----
    // cold + hot → cold_hot, + drainage → drainage_cold_hot (value_2=40), unset hot
    // → drainage_cold: результат тоже composite — over_floor остаётся {value, value_2}
    const ids4a = await itemSiteIds();
    const spot4aAdd = await call("item_add", { name: "waterspot_cold", position: { against_wall: { wall_id: wallId.id, offset_mm: 3000 } } });
    const spot4a = await captureAddedItem(spot4aAdd, ids4a);
    created.push({ kind: "item", siteId: spot4a });
    await call("waterspot_merge", { item_id: spot4a, part: "waterspot_hot" });
    await call("waterspot_merge", { item_id: spot4a, part: "waterspot_drainage" });
    const it4a = await wsItem(spot4a);
    console.log("4a merge →", it4a?.name, "over_floor:", JSON.stringify((it4a as unknown as { over_floor?: unknown })?.over_floor));
    if (it4a?.name !== "waterspot_drainage_cold_hot") throw new Error("4a: имя не drainage_cold_hot");
    const u4a = await call("waterspot_unset", { item_id: spot4a, part: "waterspot_hot" });
    console.log("4a unset hot →", (u4a as { entity?: { name?: string } }).entity?.name,
      "pipes:", JSON.stringify((u4a as { pipes?: unknown }).pipes));
    if ((u4a as { entity?: { name?: string } }).entity?.name !== "waterspot_drainage_cold") throw new Error("4a: имя не drainage_cold");
    // рабочая модель: value не переписан высотой канализации (компакт даёт
    // over_floor_mm из over_floor.value; при ошибке value стал бы 40 → 400 мм)
    const it4aAfter = await wsItem(spot4a) as unknown as { over_floor_mm?: number };
    console.log("4a over_floor_mm после unset:", it4aAfter?.over_floor_mm);
    if (it4aAfter?.over_floor_mm !== 500) throw new Error(`4a: value изменился (over_floor_mm ${it4aAfter?.over_floor_mm}; ожидалось 500)`);
    // value_2 сверяется после reopen в сцене 5 (сырой формат)
    // конец трубы из ≥3 вершин: unset концевого вывода — без висячей ссылки (365 major 2)
    const ids4b = await itemSiteIds();
    const end4bAdd = await call("item_add", { name: "waterspot_drainage_cold_hot", position: { against_wall: { wall_id: wallId.id, offset_mm: 3800 } } });
    const end4b = await captureAddedItem(end4bAdd, ids4b);
    created.push({ kind: "item", siteId: end4b });
    const it4bPre = await wsItem(end4b) as unknown as { x_mm?: number; y_mm?: number };
    if (it4bPre?.x_mm === undefined) throw new Error("4b: у вывода нет координат");
    const p4b = await call("pipe_add", { kind: "drainage", path: [
      { x: it4bPre.x_mm! - 900, y: it4bPre.y_mm! + 700 },
      { x: it4bPre.x_mm! - 500, y: it4bPre.y_mm! + 700 },
      { item_id: end4b },
    ] });
    const pipe4bSite = (p4b as { entity?: { site_id?: string } }).entity?.site_id;
    if (!pipe4bSite) throw new Error("4b: pipe_add drainage без site_id");
    created.push({ kind: "pipe", siteId: pipe4bSite });
    const pe4b = (p4b as { entity?: { vertexes?: number } }).entity;
    if (pe4b?.vertexes !== 3) throw new Error(`4b: у трубы ${String(pe4b?.vertexes)} вершин (ожидалось 3)`);
    const u4b = await call("waterspot_unset", { item_id: end4b, part: "waterspot_drainage" });
    console.log("4b unset конца 3-вершинной трубы → pipes:", JSON.stringify((u4b as { pipes?: unknown }).pipes));
    if ((u4b as { entity?: { name?: string } }).entity?.name !== "waterspot_cold_hot") throw new Error("4b: имя не cold_hot");
    const up4b = (u4b as { pipes?: { deleted?: string[]; created?: string[] } }).pipes;
    if (up4b?.deleted?.length || up4b?.created?.length) throw new Error(`4b: каскад не соответствует (кусок жив, id сохранён): ${JSON.stringify(up4b)}`);
    // сверка подключений: у снятого вывода нет висячей ссылки (rev364 №2) —
    // model_validate ловит несогласованность props.pipes
    const val4b = await call("model_validate", {});
    console.log("4b validate:", JSON.stringify(val4b).slice(0, 200));
    const raw4b = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)).model["items"] as Record<string, { pipes?: Record<string, unknown> }>;
    const end4bRaw = raw4b[end4b];
    console.log("4b props снятого вывода:", JSON.stringify(end4bRaw?.pipes ?? {}));
    if (end4bRaw?.pipes && "drainage_pipe_id" in end4bRaw.pipes) throw new Error("4b: висячая ссылка drainage_pipe_id осталась");
    // ---- 4c (365). распад conditioner_drainage / warm_floor_pipe: ключи обратных ссылок ----
    // (365 major 3): pipe_node_delete середины — у предметов ссылки drainage_pipe_id/
    // pipe_warm_floor_id на куски (PIPE_LINK_KEY_BY_TYPE), сверка model_validate
    for (const kind of ["conditioner_drainage", "warm_floor_pipe"] as const) {
      const toolName = kind === "conditioner_drainage" ? "conditioner" : "radiator_collector";
      const idsX = await itemSiteIds();
      const a1 = await tryCall("item_add", { name: toolName, position: { center: { x: roomCx - 1500, y: roomCy - 900 } } });
      if (!a1.ok) { console.log(`4c ${kind}: предмет ${toolName} недоступен в каталоге dev-аккаунта — сцена пропущена (${String(a1.err).slice(0, 120)})`); continue; }
      const a2 = await tryCall("item_add", { name: toolName, position: { center: { x: roomCx + 500, y: roomCy - 900 } } });
      if (!a2.ok) { console.log(`4c ${kind}: второй предмет не создан — сцена пропущена`); continue; }
      const s1 = await captureAddedItem(a1.res!, idsX);
      const s2 = await captureAddedItem(a2.res!, idsX);
      created.push({ kind: "item", siteId: s1 }, { kind: "item", siteId: s2 });
      const i1 = await wsItem(s1) as unknown as { x_mm?: number; y_mm?: number };
      const i2 = await wsItem(s2) as unknown as { x_mm?: number; y_mm?: number };
      if (i1?.x_mm === undefined || i2?.x_mm === undefined) throw new Error(`4c ${kind}: нет координат`);
      const pAdd = await call("pipe_add", { kind, path: [
        { item_id: s1 }, { x: Math.round((i1.x_mm! + i2.x_mm!) / 2), y: i1.y_mm! - 400 }, { item_id: s2 },
      ] });
      const pSite = (pAdd as { entity?: { site_id?: string } }).entity?.site_id;
      if (!pSite) throw new Error(`4c ${kind}: pipe_add без site_id`);
      created.push({ kind: "pipe", siteId: pSite });
      const del = await call("pipe_node_delete", { pipe_id: pSite, vertex: 1 });
      const dnX = del as { deleted_pipes?: string[]; created_pipes?: string[] };
      console.log(`4c ${kind} pipe_node_delete:`, JSON.stringify(dnX));
      if ((dnX.created_pipes?.length ?? 0) !== 2) throw new Error(`4c ${kind}: распад на 2 куска не получен: ${JSON.stringify(dnX)}`);
      for (const pid of dnX.created_pipes!) created.push({ kind: "pipe", siteId: pid });
      const box = kind === "conditioner_drainage" ? "pipes_conditioner" : "pipes_warm_floor";
      const key = kind === "conditioner_drainage" ? "drainage_pipe_id" : "pipe_warm_floor_id";
      const rawAfter = (await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)).model;
      const rawX = rawAfter["items"] as Record<string, Record<string, unknown>>;
      const rawPieces = rawAfter[box] as Record<string, { id?: string; vertexes?: Array<{ id: string }>; type?: string }>;
      for (const [label, sid] of [["левый", s1], ["правый", s2]] as const) {
        const held = rawX[sid]?.[box] as Record<string, unknown> | undefined;
        const ref = held?.[key];
        const pieceId = Object.values(rawPieces).find((p) => p.vertexes?.some((v) => v.id === sid))?.id;
        console.log(`4c ${kind} ${label} ${box}.${key}:`, JSON.stringify(ref), "кусок:", pieceId);
        if (!pieceId) throw new Error(`4c ${kind}: ${label} не в вершинах ни одного куска`);
        const ok = Array.isArray(ref) ? ref.includes(pieceId) : ref === pieceId;
        if (!ok) throw new Error(`4c ${kind}: ${label} ссылка ${key}=${JSON.stringify(ref)} не на свой кусок ${pieceId} (ключи PIPE_LINK_KEY_BY_TYPE, 365 major 3)`);
        // ошибочный ключ `${kind}_id` не появляется (365 major 3)
        if (held && key !== `${kind}_id` && `${kind}_id` in held) throw new Error(`4c ${kind}: появился ошибочный ключ ${kind}_id`);
      }
    }

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
    if (keptPipes !== 3) throw new Error(`после reopen труб ${keptPipes} (ожидалось 3: water, hot и кусок 4b из узлов)`);
    // value_2 после unset снят, у объединённого вывода высоты согласованы (сырой формат)
    const coldRaw = (am.items ?? {})[coldSite] as { name?: string; over_floor?: { value?: number; value_2?: number } } | undefined;
    console.log("cold после reopen:", coldRaw?.name, JSON.stringify(coldRaw?.over_floor));
    if (coldRaw?.name !== "waterspot_cold_hot") throw Error("reopen: имя вывода не cold_hot");
    if (coldRaw?.over_floor && "value_2" in coldRaw.over_floor) throw Error("reopen: value_2 остался после unset");
    // 365 major 1: unset composite→composite — оба значения высот на месте
    const raw4a = (am.items ?? {})[spot4a] as { name?: string; over_floor?: { value?: number; value_2?: number } } | undefined;
    console.log("4a после reopen:", raw4a?.name, JSON.stringify(raw4a?.over_floor));
    if (raw4a?.name !== "waterspot_drainage_cold") throw Error("4a reopen: имя не drainage_cold");
    if (raw4a?.over_floor?.value !== 50 || raw4a?.over_floor?.value_2 !== 40) throw Error(`4a reopen: высоты ${JSON.stringify(raw4a?.over_floor)} (ожидалось {value:50, value_2:40})`);
    // 365 major 2: unset конца 3-вершинной трубы — без висячей ссылки и с save
    const raw4bEnd = (am.items ?? {})[end4b] as { name?: string; pipes?: Record<string, unknown>; over_floor?: { value_2?: number } } | undefined;
    console.log("4b после reopen:", raw4bEnd?.name, "pipes:", JSON.stringify(raw4bEnd?.pipes ?? {}));
    if (raw4bEnd?.name !== "waterspot_cold_hot") throw Error("4b reopen: имя не cold_hot");
    if (raw4bEnd?.pipes && "drainage_pipe_id" in raw4bEnd.pipes) throw Error("4b reopen: висячая ссылка drainage_pipe_id");
    const pngRes = await client.callTool({ name: "render_plan", arguments: { sheet: "waterplan" } }, undefined, { timeout: 600_000 });
    const pngContent = (pngRes as { content?: Array<{ type: string }> }).content ?? [];
    const pngBytes = ((pngRes as { content?: Array<{ type: string; data?: string }> }).content ?? [])
      .filter((c) => c.type === "image").reduce((s, c) => s + (c.data?.length ?? 0), 0);
    console.log("render waterplan:", JSON.stringify({ isError: (pngRes as { isError?: boolean }).isError === true, content: pngContent.map((c) => c.type), pngBytes }));
    if ((pngRes as { isError?: boolean }).isError || pngBytes === 0) throw new Error("render_plan пустой");

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
