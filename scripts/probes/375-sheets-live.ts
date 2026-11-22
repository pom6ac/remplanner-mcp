// 375: живая проверка нижней панели и листов в dev-объекте (ID — ТОЛЬКО из env
// командной строки, в файлы и коммиты не писать). Сцены:
//   (1) листы: sheet_add → freeline_add/thick_line_add/figure_add на
//       custom_<id> → model_get → model_validate → save verified → reopen →
//       сверка → sheet_delete (каскад линий/фигур листа) → save verified;
//   (2) изображения: image_upload (синтетический PNG из кода пробы) →
//       image_add по url из загрузки → save verified → reopen → url/центр на
//       месте → image_delete → save verified.
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону
// без REF_INIT — любое расхождение рабочего проекта = немедленный стоп), checkEditorPlanMatch
// fail-closed перед каждым project_open, assertUnchanged перед каждой записью,
// бэкап .orca-reports/backup-<OBJECT_ID>-375.json непосредственно перед ПЕРВЫМ
// прогоном (итог сверять с ним), restore — общий probe-restore по журналу
// захваченных site_id в finally, сверка sig с бэкапом в конце и в catch,
// ≤30 запросов/мин (лимитер MCP).
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/375-sheets-live.ts run
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { sig } from "./probe-sig.ts";
import { assertEditorPlanMatch } from "./probe-guard.ts";
import { restoreByCaptured, deleteCreatedByCaptured, logCaptured, type ProbeCreated } from "./probe-restore.ts";

mkdirSync(".orca-reports/tmp", { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "375-sheets-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/375-last-error.json", text(res));
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

type CallFn = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** model_get detail=full отдаёт коллекции словарём (как в модели) — приводим к списку. */
const asList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v as Record<string, unknown>[] : Object.values((v ?? {}) as Record<string, Record<string, unknown>>);

/** Синтетический PNG 8×6 (IHDR 8×6) — не ПДн, рисуется в коде пробы. */
function pngBytes(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const sig2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  return Buffer.concat([sig2, len, Buffer.from("IHDR"), ihdr]);
}

/** Зачистка созданных объектов пробы — ТОЛЬКО общий probe-restore по журналу
 *  (major 376 №4: локальный дубль deleteCreatedObjects удалён). */
async function deleteCreatedObjects(call: CallFn, created: ProbeCreated[], log: (line: string) => void): Promise<void> {
  await deleteCreatedByCaptured(call as unknown as import("./probe-restore.ts").ProbeCall, created, log);
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
  const backupPath = `.orca-reports/backup-${ids.objectId}-375.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/375-backup-${stamp}.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  // minor 376 №11: бэкап НЕ перезаписывается между прогонами — пишется только
  // при отсутствии (базис до ПЕРВОГО прогона), итог сверяется с ним
  if (existsSync(backupPath)) {
    console.log("backup exists — НЕ перезаписывается (minor 376 №11):", backupPath);
  } else {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written (первый прогон):", backupPath, "sig:", sig(before.model).slice(0, 40));
  }
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
  const capturedPath = `.orca-reports/tmp/375-captured-${stamp}.json`;
  const journal = (): void => {
    logCaptured(capturedPath, created, []);
    console.log("журнал захваченных ID:", capturedPath);
  };
  try {
    // ==== сцена (1): листы и «Нарисовать элемент» ====
    const sheetAdd = await call("sheet_add", { name: "Лист 375", content: ["plan", "light"] }) as { id: string; plan: string };
    created.push({ kind: "sheet", siteId: sheetAdd.id });
    journal();
    check(typeof sheetAdd.id === "string" && sheetAdd.id.length >= 6, `sheet_add: id=${sheetAdd.id}, план=${sheetAdd.plan}`);
    const fl = await call("freeline_add", { points: [{ x: 12000, y: 9000 }, { x: 14000, y: 9000 }, { x: 14000, y: 10000 }], plan: sheetAdd.plan, color: "#ff0000", type_stroke: "dash" }) as { id: string };
    created.push({ kind: "freeline", siteId: fl.id });
    journal();
    check(typeof fl.id === "string", `freeline_add: id=${fl.id} на ${sheetAdd.plan}`);
    const tl = await call("thick_line_add", { points: [{ x: 12000, y: 11000 }, { x: 14000, y: 11000 }], width_mm: 300, plan: sheetAdd.plan }) as { id: string };
    created.push({ kind: "thick_line", siteId: tl.id });
    journal();
    check(typeof tl.id === "string", `thick_line_add: id=${tl.id}, ширина 300 мм`);
    const fig = await call("figure_add", { type: "rect_round", center: { x: 16000, y: 9500 }, width_mm: 600, height_mm: 400, angle_deg: 0, plan: sheetAdd.plan }) as { id: string };
    created.push({ kind: "figure", siteId: fig.id });
    journal();
    check(typeof fig.id === "string", `figure_add: id=${fig.id} (rect_round 600×400)`);

    const mg1 = await call("model_get", {}) as Record<string, unknown>;
    const sheets1 = asList(mg1["custom_plans"]) as Array<{ site_id: string; name: string; after_plan: string; content: string[] }>;
    const fls1 = asList(mg1["freelines"]) as Array<{ site_id: string; plan: string; points_mm: number[][] }>;
    const tls1 = asList(mg1["thick_lines"]) as Array<{ site_id: string; plan: string; width_mm?: number }>;
    const figs1 = asList(mg1["free_figures"]) as Array<{ site_id: string; type: string; plan: string }>;
    check(sheets1.some((s) => s.site_id === sheetAdd.id && s.name === "Лист 375" && Array.isArray(s.content) && s.content.includes("plan")), `model_get: лист на месте (${JSON.stringify(sheets1.map((s) => s.name))})`);
    check(fls1.some((l) => l.site_id === fl.id && l.plan === sheetAdd.plan && l.points_mm.length === 3), `model_get: свободная линия на месте (${fls1.length} шт.)`);
    check(tls1.some((l) => l.site_id === tl.id && l.width_mm === 300), `model_get: толстая линия с шириной 300 мм (${JSON.stringify(tls1.map((l) => l.width_mm))})`);
    check(figs1.some((f) => f.site_id === fig.id && f.type === "rect_round"), `model_get: фигура на месте (${figs1.length} шт.)`);

    const val = await call("model_validate", {}) as { problems?: Array<{ code: string }> };
    // в dev-объекте есть унаследованные WALL_DANGLING (не от этой пробы): фиксируем
    // список, отказами считаем только проблемы по сущностям этого раздела
    const drawProblems = (val["problems"] ?? []).filter((p) => JSON.stringify(p).includes("custom_"));
    check(drawProblems.length === 0, `model_validate: проблем раздела ${drawProblems.length} (всего ${(val["problems"] ?? []).length}, унаследованные не считаются)`);

    const save1 = await gsave("листы и «Нарисовать элемент»");
    check(save1["verified"] === true, "save verified (листы)");

    // reopen: всё на месте
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mg2 = await call("model_get", {}) as Record<string, unknown>;
    const sheets2 = asList(mg2["custom_plans"]) as Array<{ site_id: string; name: string }>;
    const fls2 = asList(mg2["freelines"]) as Array<{ site_id: string; plan: string }>;
    const tls2 = asList(mg2["thick_lines"]) as Array<{ site_id: string }>;
    const figs2 = asList(mg2["free_figures"]) as Array<{ site_id: string; type: string }>;
    check(sheets2.some((s) => s.site_id === sheetAdd.id && s.name === "Лист 375"), "reopen: лист сохранился");
    check(fls2.some((l) => l.site_id === fl.id && l.plan === sheetAdd.plan), "reopen: свободная линия сохранилась (лист custom_<id>)");
    check(tls2.some((l) => l.site_id === tl.id), "reopen: толстая линия сохранилась");
    check(figs2.some((f) => f.site_id === fig.id && f.type === "rect_round"), "reopen: фигура сохранилась");

    const render1 = await tryCall("render_plan", {});
    check(render1 !== null && !("__error" in (render1 ?? {})), `render_plan после листов: ${JSON.stringify(render1).slice(0, 120)}`);

    // удаление листа — каскад линий/фигур (CustomPlan.delete)
    const del = await call("sheet_delete", { sheet_id: sheetAdd.id }) as { deleted: Record<string, number> };
    check((del.deleted["freelines"] ?? 0) >= 1 && (del.deleted["free_figures"] ?? 0) >= 1 && (del.deleted["thick_lines"] ?? 0) >= 1,
      `sheet_delete: каскад ${JSON.stringify(del.deleted)}`);
    for (const c of created) if (["freeline", "thick_line", "figure"].includes(c.kind)) c.siteId = undefined;
    const save2 = await gsave("удаление листа (каскад)");
    check(save2["verified"] === true, "save verified (удаление листа)");

    // ==== сцена (2): изображения ====
    const b64 = pngBytes(8, 6).toString("base64");
    const up = await call("image_upload", { data_base64: b64 }) as { url: string; width_original_px: number; height_original_px: number; mime: string };
    check(up.mime === "image/png" && up.width_original_px === 8 && up.height_original_px === 6 && typeof up.url === "string" && up.url.length > 0,
      `image_upload: url=${String(up.url).slice(0, 30)}, ${up.width_original_px}×${up.height_original_px} ${up.mime}`);
    const pic = await call("image_add", { url: up.url, center: { x: 6000, y: 4000 }, width_original_px: up.width_original_px, height_original_px: up.height_original_px, text: "Проба 375" }) as { id: string; width_mm: number };
    created.push({ kind: "picture", siteId: pic.id });
    journal();
    check(typeof pic.id === "string", `image_add: id=${pic.id}, размер из исходника ${pic.width_mm} мм`);
    const save3 = await gsave("изображение на плане");
    check(save3["verified"] === true, "save verified (изображение)");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mg3 = await call("model_get", {}) as Record<string, unknown>;
    const pics3 = asList(mg3["pictures"]) as Array<{ site_id: string; url: string; text?: string }>;
    check(pics3.some((p) => p.site_id === pic.id && p.url === up.url), "reopen: изображение с тем же url сохранилось");
    check(pics3.some((p) => p.site_id === pic.id && p.text === "Проба 375"), "reopen: подпись изображения сохранилась");
    const render2 = await tryCall("render_plan", {});
    check(render2 !== null && !("__error" in (render2 ?? {})), `render_plan с изображением: ${JSON.stringify(render2).slice(0, 120)}`);
    const pdel = await call("image_delete", { image_id: pic.id }) as { deleted: string };
    check(pdel["deleted"] === pic.id, `image_delete: ${pdel.deleted}`);
    for (const c of created) if (c.kind === "picture") c.siteId = undefined;
    const save4 = await gsave("удаление изображения");
    check(save4["verified"] === true, "save verified (удаление изображения)");
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
  try {
    const { probeWriteEnv } = await import("./probe-guard.ts");
    const ids = probeWriteEnv();
    const afterFail = await loadModel(ctx.session(), ids.objectId, ids.planId);
    const backupPath = `.orca-reports/backup-${ids.objectId}-375.json`;
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
