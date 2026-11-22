// 372: живая перепроверка фикса major 371 №1 в dev-объекте (ID — ТОЛЬКО из env
// командной строки, в файлы и коммиты не писать). Сцена:
//   (1) розетка на своей перегородке → item_update layer=2 (центр на 260 мм
//       дальше от стены) → item_update against_wall по той же стене БЕЗ layer —
//       смещение слоя сохраняется (y_mm − y_mm соседа = 260), layer=2 → тот же
//       перенос с явным layer=2 — то же правило → save verified → reopen →
//       слой/центры сохранились.
//   Скос (slope_side 22/44) живьём не проверяется: slope_side редактор ставит
//   только перетаскиванием предмета на откос (UI drag), MCP-инструмента нет —
//   ветка покрыта офлайн-тестом по форме бандла (ui-ref-electric3-slope).
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону без
// REF_INIT), assertEditorPlanMatch fail-closed перед каждым project_open,
// assertUnchanged перед каждой записью, бэкап
// .orca-reports/backup-<OBJECT_ID>-372.json непосредственно перед прогоном,
// restore — общий probe-restore по журналу захваченных ID в finally (зачистка
// предметов только по журналу site_id, ревью 371 №6), сверка sig с бэкапом в
// конце и в catch (ревью 368 F4), ≤30 запросов/мин (лимитер MCP).
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/372-electric3-live.ts run
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

mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "372-electric3-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/372-last-error.json", text(res));
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

type ItemView = { site_id: string; name: string; layer?: number; y_mm?: number; x_mm?: number; socket_group?: Array<{ id: string; x_mm: number; y_mm: number }> };
type CallFn = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Зачистка созданных объектов пробы ТОЛЬКО по журналу захваченных ID
 *  (ревью 371 №6: удаление по имени и по ID из env запрещено). */
async function deleteCreatedObjects(call: CallFn, created: ProbeCreated[], log: (line: string) => void): Promise<void> {
  const take = (kind: string): string[] => {
    const ids = created.filter((c) => c.kind === kind && c.siteId).map((c) => c.siteId!);
    for (const id of ids) created.splice(created.findIndex((c) => c.kind === kind && c.siteId === id), 1);
    return ids;
  };
  for (const id of take("item").reverse()) {
    const r = await tryCall("item_delete", { item_id: id });
    log(`item_delete ${id}: ${"__error" in (r ?? {}) ? String((r as { __error?: string }).__error).slice(0, 120) : "ok"}`);
  }
}

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
  const backupPath = `.orca-reports/backup-${ids.objectId}-372.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/372-backup-${stamp}.json`;
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
  const capturedPath = `.orca-reports/tmp/372-captured-${stamp}.json`;
  const journal = (): void => {
    logCaptured(capturedPath, created, []);
    console.log("журнал захваченных ID:", capturedPath);
  };
  try {
    // — пробная комната из перегородок правее/ниже всей геометрии (как в 370) —
    const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
    const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
    const maxY = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.y, w.p2.y]));
    const ox = Math.ceil(maxX) + 300, oy = Math.ceil(maxY) + 300, TW = 600, TH = 240;
    const mm = (p: { x: number; y: number }): { x: number; y: number } => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
    const walls: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: ox, y: oy }, { x: ox + TW, y: oy }],
      [{ x: ox + TW, y: oy }, { x: ox + TW, y: oy + TH }],
      [{ x: ox + TW, y: oy + TH }, { x: ox, y: oy + TH }],
      [{ x: ox, y: oy + TH }, { x: ox, y: oy }],
    ];
    for (const [s, e] of walls) {
      const r = await call("wall_add", { start: mm(s), end: mm(e), thickness_mm: 100, kind: "partition" });
      created.push({ kind: "wall", siteId: (r["entity"] as { site_id?: string })?.site_id });
    }
    journal();
    const save0 = await gsave("пробная комната");
    check(save0["verified"] === true, "save verified (пробная комната)");

    // ==== сцена (1): перенос вдоль стены розетки со слоем 2 (major 371 №1) ====
    const mg0 = (await call("model_get", {})) as unknown as { walls: Array<{ id: string; site_id?: string }> };
    const tw = mg0.walls.find((w) => w.site_id === created[0]!.siteId);
    if (!tw) throw new Error("своя перегородка не найдена — СТОП (throw: не обходит finally restore)");
    const s1 = await call("item_add", { name: "socket", position: { against_wall: { wall_id: tw.id, offset_mm: 1000 } } }) as { entity: { site_id: string } };
    const s2 = await call("item_add", { name: "socket", position: { against_wall: { wall_id: tw.id, offset_mm: 1000 } } }) as { entity: { site_id: string } };
    created.push({ kind: "item", siteId: s1.entity.site_id }, { kind: "item", siteId: s2.entity.site_id });
    journal();
    const mgA = (await call("model_get", {})) as unknown as { items: ItemView[] };
    const i1 = mgA.items.find((i) => i.site_id === s1.entity.site_id)!;
    const i2 = mgA.items.find((i) => i.site_id === s2.entity.site_id)!;
    const yBase = i1.y_mm!;
    check(i1.layer === undefined && i2.layer === undefined, "предусловие: у обеих розеток слоя нет");
    // слой 2 второй розетке
    await call("item_update", { item_id: s2.entity.site_id, layer: 2 });
    const mgB = (await call("model_get", {})) as unknown as { items: ItemView[] };
    const l2 = mgB.items.find((i) => i.site_id === s2.entity.site_id)!;
    check(l2.layer === 2, `layer=2: model_get даёт слой 2 (layer=${l2.layer})`);
    check(l2.y_mm! - yBase === 260, `слой 2: центр на 260 мм дальше от стены (${l2.y_mm!} − ${yBase})`);
    // перенос вдоль стены БЕЗ layer — смещение слоя сохраняется (фикс 372)
    await call("item_update", { item_id: s2.entity.site_id, position: { against_wall: { wall_id: tw.id, offset_mm: 1500 } } });
    const mgC = (await call("model_get", {})) as unknown as { items: ItemView[] };
    const mv = mgC.items.find((i) => i.site_id === s2.entity.site_id)!;
    check(mv.layer === 2, `после against_wall без layer: слой 2 сохранён (layer=${mv.layer})`);
    check(mv.y_mm! - yBase === 260, `после against_wall без layer: смещение слоя сохранено (${mv.y_mm!} − ${yBase} = 260)`);
    check(mv.x_mm! !== i2.x_mm!, `розетка переехала вдоль стены (${i2.x_mm} → ${mv.x_mm})`);
    const sub2 = mv.socket_group?.[0];
    check(sub2 !== undefined && sub2.y_mm - (mgC.items.find((i) => i.site_id === s1.entity.site_id)!.socket_group?.[0]?.y_mm ?? 0) === 260,
      `center под-розетки следует за слоем: ${JSON.stringify(sub2)}`);
    // тот же перенос с явным layer=2 — то же правило относительно новой позиции
    await call("item_update", { item_id: s2.entity.site_id, position: { against_wall: { wall_id: tw.id, offset_mm: 2000 } }, layer: 2 });
    const mgD = (await call("model_get", {})) as unknown as { items: ItemView[] };
    const ex = mgD.items.find((i) => i.site_id === s2.entity.site_id)!;
    check(ex.layer === 2 && ex.y_mm! - yBase === 260, `после against_wall с явным layer=2: слой и смещение те же (${ex.layer}, ${ex.y_mm!} − ${yBase})`);
    const save1 = await gsave("перенос вдоль стены со слоем 2");
    check(save1["verified"] === true, "save verified (перенос со слоем)");
    // reopen: слой и центр сохранились
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mgE = (await call("model_get", {})) as unknown as { items: ItemView[] };
    const rp = mgE.items.find((i) => i.site_id === s2.entity.site_id)!;
    check(rp.layer === 2 && rp.y_mm === ex.y_mm, `после reopen: слой 2 и центр на месте (${rp.layer}, ${rp.y_mm})`);
    try {
      const render = await call("render_plan", { sheet: "sockets" });
      check(Number((render as { bytes?: number })["bytes"] ?? 0) > 10000, `render_plan sockets отдал PNG (${(render as { bytes?: number })["bytes"]})`);
    } catch (e) { console.log("render sockets error:", String((e as Error).message).slice(0, 200)); }

    // — зачистка созданных объектов по журналу (обратный порядок зависимостей) —
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    await deleteCreatedObjects(call as unknown as CallFn, created, (l) => console.log("cleanup:", l));
    journal();
    const saveCleanup = await gsave("зачистка объектов");
    check(saveCleanup["verified"] === true, "save verified (зачистка объектов)");
  } finally {
    try {
      await roGuard.assertUnchanged("restore");
      if (created.some((c) => c.siteId)) {
        await deleteCreatedObjects(call as unknown as CallFn, created, (l) => console.log("restore-obj:", l));
        await restoreByCaptured({
          call,
          created,
          ownRoomIds: [],
          save: () => gsave("restore"),
          log: (line) => console.log("restore:", line),
        });
      } else {
        console.log("restore: захватов нет — restore-save пропущен");
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
      console.error(`модель dev-объекта не совпала с бэкапом ${backupPath} — восстановите cleanup-фазой по журналу ${capturedPath}`);
      exitCode = 1;
    }
    await roGuard.checkFinal("finally");
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 600));
  // ревью 368 F4: в catch после restore — сверка sig с бэкапом и checkFinal
  try {
    const { probeWriteEnv } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    const afterFail = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-372.json`;
    const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
    console.error("FAIL-restore: сверка sig с бэкапом:", sig(afterFail.model) === sig(ref.model) ? "OK" : "РАСХОЖДЕНИЕ");
  } catch (fe) { console.error("FAIL-restore check:", String((fe as Error).message).slice(0, 300)); }
  await client.close().catch(() => {});
  try { await closeBrowser(); } catch { /* */ }
  process.exit(1);
}
await client.close();
try { await closeBrowser(); } catch { /* */ }
if (fails.length > 0) console.log("FAILS:", fails.join(" | "));
process.exit(exitCode);
