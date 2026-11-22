// 370: живая проверка «электрика ч.3» в dev-объекте (ID — ТОЛЬКО из env командной
// строки, в файлы и коммиты не писать). Сцены:
//   (1) вертикальные блоки: розетка + item_update layer=2 → save verified →
//       reopen → сверка слоя/центра/под-розеток → wiring между слоями → render PNG;
//   (2) F1 ревью 368: rebuild контура-одиночки по сырому GET до save — ОТДЕЛЬНЫЙ
//       контур (второй warm_floor_add), проверка на reopen с expect "none".
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону без
// REF_INIT), checkEditorPlanMatch fail-closed перед каждым project_open,
// assertUnchanged перед каждой записью (guardedSave), бэкап
// .orca-reports/backup-OBJECT_ID-370.json непосредственно перед прогоном,
// restore — общий probe-restore по журналу захваченных ID в finally,
// сверка sig с бэкапом в конце (и в catch), ≤30 запросов/мин (лимитер MCP).
//   node scripts/probes/370-electric3-live.ts run
//   … те же env + REMPLANNER_PROBE_WALL_SITE_IDS из журнала \
//   node scripts/probes/370-electric3-live.ts cleanup
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch } from "./probe-guard.ts";
import { restoreByCaptured, logCaptured, type ProbeCreated } from "./probe-restore.ts";

const phase = process.argv[2] ?? "run";
const isCleanup = phase === "cleanup";
mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: `370-electric3-live-${phase}`, version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/370-last-error.json", text(res));
    throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  }
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const tryCall = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
  try { return await call(name, args); } catch (e) { return { __error: String((e as Error).message).slice(0, 300) }; }
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

try {
  const { probeWriteEnv, assertTargetPair, readonlyGuard, readonlyRefPath } = await import("./probe-guard.ts");
  const ids = probeWriteEnv();
  await assertTargetPair(ctx.session(), ids.objectId, ids.planId);
  const roGuard = await readonlyGuard(ctx.session(), ids.readonlyId, ids.readonlyPlanId, readonlyRefPath(ids.readonlyId, ids.readonlyPlanId));
  const gsave = async (tag: string): Promise<Record<string, unknown>> => {
    await roGuard.assertUnchanged(tag);
    const r = await call("project_save", {}) as { verified?: boolean; warnings?: unknown[]; details?: unknown };
    console.log(`save ${tag}:`, JSON.stringify({ verified: r["verified"], warnings: (r["warnings"] ?? []).length }));
    if (!r["verified"]) throw new Error(`save ${tag} не verified: ${JSON.stringify(r["details"] ?? r).slice(0, 500)}`);
    await delay(5500);
    return r;
  };
  const backupPath = `.orca-reports/backup-${ids.objectId}-370.json`;

  if (isCleanup) {
    await roGuard.assertUnchanged("cleanup-before");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    const edC = editorOf();
    await assertEditorPlanMatch(edC, ids.planId);
    const wallSiteIds = (process.env["REMPLANNER_PROBE_WALL_SITE_IDS"] ?? "").split(",").filter(Boolean);
    console.log("cleanup: удаляю стены по захваченным site_id:", JSON.stringify(wallSiteIds));
    const created: ProbeCreated[] = wallSiteIds.map((siteId) => ({ kind: "wall", siteId }));
    if (created.length > 0) {
      await restoreByCaptured({
        call,
        created,
        ownRoomIds: [],
        save: () => gsave("cleanup"),
        log: (line) => console.log("restore:", line),
      });
    } else {
      console.log("cleanup: журнал пуст — restore-save пропущен");
    }
    const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
    const same = sig(after.model) === sig(ref.model);
    console.log("sig restored == backup:", same);
    if (!same) exitCode = 1;
    await roGuard.checkFinal("finally");
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stampPath = `.orca-reports/tmp/370-backup-${stamp}.json`;
    const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    writeFileSync(stampPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written:", backupPath, "and", stampPath, "sig:", sig(before.model).slice(0, 40));
    await roGuard.assertUnchanged("before");

    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await call("render_plan", {});
    const ed = editorOf();
    console.log("editor:", ed ? "создан" : "НЕТ");
    await assertEditorPlanMatch(ed, ids.planId);
    console.log("гард «план в редакторе == серверу» (fail-closed): OK");

    const created: ProbeCreated[] = [];
    const capturedPath = `.orca-reports/tmp/370-captured-${stamp}.json`;
    const journal = (): void => {
      logCaptured(capturedPath, created, []);
      console.log("журнал захваченных ID:", capturedPath);
    };
    try {
      // — пробная комната правее/ниже всей геометрии (как 359) —
      const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
      const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
      const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
      const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, TW = 300, TH = 240;
      const mm = (p: { x: number; y: number }): { x: number; y: number } => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
      const rect: [{ x: number; y: number }, { x: number; y: number }][] = [
        [{ x: ox, y: oy }, { x: ox + TW, y: oy }],
        [{ x: ox + TW, y: oy }, { x: ox + TW, y: oy + TH }],
        [{ x: ox + TW, y: oy + TH }, { x: ox, y: oy + TH }],
        [{ x: ox, y: oy + TH }, { x: ox, y: oy }],
      ];
      for (const [s, e] of rect) {
        const r = await call("wall_add", { start: mm(s), end: mm(e), thickness_mm: 100, kind: "partition" });
        created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
      }
      journal();
      const save0 = await gsave("trial-room");
      check(save0["verified"] === true, "save verified (пробная комната)");

      // ==== сцена (1): вертикальные блоки ====
      const mg0 = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
      const tw = mg0.walls.find((w) => w.site_id === created[0]!.siteId);
      if (!tw) { console.error("своя перегородка не найдена — СТОП"); process.exit(1); }
      const s1 = await call("item_add", { name: "socket", position: { against_wall: { wall_id: tw.id, offset_mm: 1000 } } }) as { entity: { site_id: string } };
      const s2 = await call("item_add", { name: "socket", position: { against_wall: { wall_id: tw.id, offset_mm: 1000 } } }) as { entity: { site_id: string } };
      created.push({ kind: "item", siteId: s1.entity.site_id }, { kind: "item", siteId: s2.entity.site_id });
      journal();
      const upd = await call("item_update", { item_id: s2.entity.site_id, layer: 2 }) as { entity?: { site_id?: string; layer?: number; y_mm?: number; y1_mm?: number } };
      console.log("item_update layer=2 →", JSON.stringify(upd.entity ?? {}));
      const mg1 = (await call("model_get", {})) as unknown as { items: Array<{ site_id: string; name: string; layer?: number; y_mm: number; socket_group?: Array<{ id: string; x_mm: number; y_mm: number }> }> };
      const i1 = mg1.items.find((i) => i.site_id === s1.entity.site_id)!;
      const i2 = mg1.items.find((i) => i.site_id === s2.entity.site_id)!;
      check(i2.layer === 2, `model_get: слой 2 у второй розетки (layer=${i2.layer})`);
      check(i1.layer === undefined, `model_get: у первой розетки слоя нет (layer=${String(i1.layer)})`);
      check(i2.y_mm - i1.y_mm === 260, `центр слоя 2 на 260 мм дальше от стены: ${i2.y_mm - i1.y_mm}`);
      check(i2.socket_group?.[0] !== undefined && i2.socket_group[0].y_mm - (i1.socket_group?.[0]?.y_mm ?? 0) === 260,
        `center под-розетки следует за слоем: ${JSON.stringify({ s1: i1.socket_group?.[0], s2: i2.socket_group?.[0] })}`);

      // проводка между слоями (socket → socket, sub-адресация)
      const wiring = await call("wiring_add", {
        kind: "wire_3_25",
        path: [
          { item_id: i1.site_id, sub_id: i1.socket_group?.[0]?.id },
          { x: Math.round((ox + TW / 2) * 10), y: Math.round((oy + 60) * 10) },
          { item_id: i2.site_id, sub_id: i2.socket_group?.[0]?.id },
        ],
      }) as { entity?: { id?: string } };
      console.log("wiring_add:", JSON.stringify(wiring.entity ?? {}));
      const wiringId = String(wiring.entity?.id ?? "");
      if (wiringId) created.push({ kind: "cable", siteId: wiringId });
      journal();
      const save1 = await gsave("электрика слоёв");
      check(save1["verified"] === true, "save verified (слои + проводка)");

      // reopen: слой/центр/проводка сохранились
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      const ed2 = editorOf();
      await assertEditorPlanMatch(ed2, ids.planId);
      const mg2 = (await call("model_get", {})) as unknown as typeof mg1 & { cables_socket?: Array<{ id: string; items?: unknown[] }> };
      const j1 = mg2.items.find((i) => i.site_id === s1.entity.site_id)!;
      const j2 = mg2.items.find((i) => i.site_id === s2.entity.site_id)!;
      check(j2.layer === 2, `после reopen: слой 2 сохранился (layer=${j2.layer})`);
      check(j2.y_mm === i2.y_mm && j1.y_mm === i1.y_mm, `центры не съехали (${j1.y_mm}/${j2.y_mm})`);
      check((mg2.cables_socket?.length ?? 0) === 1, `после reopen: кабель проводки на месте (${mg2.cables_socket?.length})`);
      const render = await call("render_plan", { sheet: "sockets" });
      const bytes = Number((render as { bytes?: number })["bytes"] ?? 0);
      check(bytes > 10000, `render_plan sockets отдал PNG (${bytes})`);

      // ==== сцена (2) — F1 ревью 368: rebuild контура-одиночки, сырой GET до save ====
      const col = await call("item_add", { name: "radiator_collector", position: { against_wall: { wall_id: tw.id, offset_mm: 2400 } } }) as { entity: { site_id: string } };
      created.push({ kind: "item", siteId: col.entity.site_id });
      const wf1 = await call("warm_floor_add", { kind: "water", corner1: { x: Math.round((ox + 20) * 10), y: Math.round((oy + 20) * 10) }, corner2: { x: Math.round((ox + 100) * 10), y: Math.round((oy + 100) * 10) } }) as { entity: { id?: string; site_id?: string } };
      const wf2 = await call("warm_floor_add", { kind: "water", corner1: { x: Math.round((ox + 140) * 10), y: Math.round((oy + 20) * 10) }, corner2: { x: Math.round((ox + 220) * 10), y: Math.round((oy + 100) * 10) } }) as { entity: { id?: string; site_id?: string } };
      const wf1Id = String(wf1.entity.id ?? wf1.entity.site_id ?? "");
      const wf2Id = String(wf2.entity.id ?? wf2.entity.site_id ?? "");
      created.push({ kind: "warm_floor", siteId: wf1Id }, { kind: "warm_floor", siteId: wf2Id });
      journal();
      const p1 = await call("pipe_add", { kind: "warm_floor", path: [{ item_id: col.entity.site_id }, { x: Math.round((ox + 120) * 10), y: Math.round((oy + 130) * 10) }, { item_id: wf1Id }] }) as { entity?: { id?: string } };
      const p2 = await call("pipe_add", { kind: "warm_floor", path: [{ item_id: col.entity.site_id }, { x: Math.round((ox + 240) * 10), y: Math.round((oy + 130) * 10) }, { item_id: wf2Id }] }) as { entity?: { id?: string } };
      const p2Id = String(p2.entity?.id ?? "");
      if (p2Id) created.push({ kind: "pipe", siteId: p2Id });
      journal();
      const save2 = await gsave("два контура");
      check(save2["verified"] === true, "save verified (коллектор + 2 контура + 2 магистрали)");

      // reopen и сырой GET: у обоих контуров ссылка на свою магистраль (предусловие)
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      await assertEditorPlanMatch(editorOf(), ids.planId);
      type WfMap = Record<string, { props?: { pipes_warm_floor?: Record<string, unknown> } }>;
      const raw1 = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const wfs1 = (raw1.model["warm_floors"] ?? {}) as WfMap;
      const ref1pre = wfs1[wf1Id]?.props?.pipes_warm_floor ?? {};
      const ref2pre = wfs1[wf2Id]?.props?.pipes_warm_floor ?? {};
      console.log("сырой GET до мутации: ref1:", JSON.stringify(ref1pre), "ref2:", JSON.stringify(ref2pre));
      check(Object.keys(ref1pre).length === 1 && Object.keys(ref2pre).length === 1, "предусловие F1: оба контура на сервере со ссылкой на свою магистраль (проверка не тавтологична)");

      // rebuild (б): удаляем вершину-контур второй магистрали → контур-одиночка,
      // ссылка снимается (unset_tree_id) СРАЗУ в ws.model и после save+reopen
      const del = await call("pipe_node_delete", { pipe_id: p2Id, vertex: 2 }) as { deleted?: unknown[]; created?: unknown[]; removed?: boolean };
      console.log("pipe_node_delete (вершина контура wf2):", JSON.stringify(del));
      const raw2 = await loadModel(ctx.session(), ids.objectId, ids.planId); // сырой GET ДО save
      const wfs2 = (raw2.model["warm_floors"] ?? {}) as WfMap;
      console.log("сырой GET до save: ref2 на сервере ещё прежний:", JSON.stringify(wfs2[wf2Id]?.props?.pipes_warm_floor ?? {}));
      const save3 = await gsave("rebuild контура-одиночки");
      check(save3["verified"] === true, "save verified (rebuild без висячей ссылки)");
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      await assertEditorPlanMatch(editorOf(), ids.planId);
      const raw3 = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const wfs3 = (raw3.model["warm_floors"] ?? {}) as WfMap;
      const ref1post = wfs3[wf1Id]?.props?.pipes_warm_floor ?? {};
      const ref2post = wfs3[wf2Id]?.props?.pipes_warm_floor ?? {};
      console.log("после reopen: ref1:", JSON.stringify(ref1post), "ref2:", JSON.stringify(ref2post));
      check(Object.keys(ref2post).length === 0, "F1 (б) на reopen: у контура-одиночки висячей ссылки нет (expect none)");
      check(Object.keys(ref1post).length === 1, "контроль: у первого контура ссылка цела");
      const pwf3 = (raw3.model["pipes_warm_floor"] ?? {}) as Record<string, { vertexes?: Array<{ id: string }> }>;
      const p2live = Object.values(pwf3).find((p) => p.vertexes?.some((v) => v.id === wf2Id));
      check(!p2live, "F1: контур-одиночка не в вершинах ни одной трубы (rebuild)");
      try {
        const render2 = await call("render_plan", { sheet: "warm_floor" });
        check(Number((render2 as { bytes?: number })["bytes"] ?? 0) > 10000, "render_plan warm_floor отдал PNG");
      } catch (e) { console.log("render warm_floor error:", String((e as Error).message).slice(0, 200)); }

      // — зачистка созданных объектов (обратный порядок зависимостей) —
      await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
      await assertEditorPlanMatch(editorOf(), ids.planId);
      if (wiringId) console.log("wiring_delete:", JSON.stringify(await tryCall("wiring_delete", { wiring_id: wiringId })));
      for (const pid of [p2Id, String(p1.entity?.id ?? "")]) {
        if (pid) console.log("pipe_delete", pid, JSON.stringify(await tryCall("pipe_delete", { pipe_id: pid })));
      }
      for (const wf of [wf1Id, wf2Id]) {
        if (wf) console.log("warm_floor_delete", wf, JSON.stringify(await tryCall("warm_floor_delete", { warm_floor_id: wf })));
      }
      for (const iid of [col.entity.site_id, s2.entity.site_id, s1.entity.site_id]) {
        console.log("item_delete", iid, JSON.stringify(await tryCall("item_delete", { item_id: iid })));
      }
      const saveCleanup = await gsave("зачистка объектов");
      check(saveCleanup["verified"] === true, "save verified (зачистка объектов)");
      created.length = 0; // объекты удалены — стены удаляет restore ниже
      journal();
    } finally {
      try {
        await roGuard.assertUnchanged("restore");
        const nothingToRestore = !created.some((c) => c.siteId);
        if (nothingToRestore) {
          console.log("restore: захватов нет — restore-save пропущен");
        } else {
          await restoreByCaptured({
            call,
            created,
            ownRoomIds: [],
            save: () => gsave("restore"),
            log: (line) => console.log("restore:", line),
          });
        }
      } catch (e) {
        console.log("restore error:", String((e as Error).message).slice(0, 250));
        exitCode = 1;
      }
      const after: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
      const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
      const same = sig(after.model) === sig(ref.model);
      console.log("sig restored == backup:", same);
      if (!same) {
        console.error(`модель dev-объекта не совпала с бэкапом ${backupPath} — восстановите cleanup-фазой пробы по захваченным ID`);
        exitCode = 1;
      }
      await roGuard.checkFinal("finally");
    }
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 600));
  // ревью 368 F4 (образец): в catch после restore — сверка sig с бэкапом и checkFinal
  try {
    const ids = (await import("./probe-guard.ts")).probeWriteEnv();
    const afterFail = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-370.json`;
    if (readFileSync(backupPath, "utf8")) {
      const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
      console.error("FAIL-restore: сверка sig с бэкапом:", sig(afterFail.model) === sig(ref.model) ? "OK" : "РАСХОЖДЕНИЕ");
    }
  } catch (fe) { console.error("FAIL-restore check:", String((fe as Error).message).slice(0, 300)); }
  await client.close().catch(() => {});
  try { await closeBrowser(); } catch { /* */ }
  process.exit(1);
}
await client.close();
try { await closeBrowser(); } catch { /* */ }
if (fails.length > 0) console.log("FAILS:", fails.join(" | "));
process.exit(exitCode);
