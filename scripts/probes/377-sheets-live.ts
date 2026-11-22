// 377: живая перепроверка фиксов ревью 376 (нижняя панель и листы) в dev-объекте
// (ID — ТОЛЬКО из env командной строки, в файлы и коммиты не писать). Отличия от
// 375-sheets-live.ts (каждое — красный без фикса на 7b04a69):
//   (1) major 376 №1: image_add БЕЗ text — запись с text:""/font_size:10
//       (Pictures.restore бандла на записи без text падает TypeError);
//   (2) major 376 №2: подпись с кавычками/апострофом — канонизация в
//       server-форму, save verified без NORMALIZATION_DROPPED, текст стабилен
//       при reopen, ответ несёт warning канонизации и видимый текст;
//   (3) major 376 №3: лист с допустимым именем (белый список) сохраняется и
//       verified; отказ на опасном имени проверяется ТОЛЬКО офлайн-тестом —
//       опасные строки на сайт НЕ отправляются ни в каком виде;
//   (4) major 376 №4: журнал захваченных site_id — полный (sheets/freelines/
//       thick_lines/figures/pictures), пишется после каждого захвата, зачистка
//       — ТОЛЬКО общий probe-restore (deleteCreatedByCaptured по журналу);
//   (5) minor 376 №11: бэкап backup-<OBJECT_ID>-377.json НЕ перезаписывается
//       между прогонами (пишется только при отсутствии; итог сверяется с ним —
//       базис до ПЕРВОГО прогона); отдельная копия на прогон — в tmp;
//   (6) minor 376 №5: ответ image_delete называет id удалённого изображения.
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону
// без REF_INIT), checkEditorPlanMatch fail-closed перед каждым project_open,
// assertUnchanged перед каждой записью, restore по журналу в finally, sig в
// конце и в catch, ≤30 запросов/мин (лимитер MCP), save не чаще раза в 5 с.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/377-sheets-live.ts run
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
const client = new Client({ name: "377-sheets-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/377-last-error.json", text(res));
    throw new Error(`${name}: ${text(res).slice(0, 900)}`);
  }
  return JSON.parse(text(res)) as Record<string, unknown>;
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

/** model_get detail=full отдаёт коллекции словарём — приводим к списку. */
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
  // minor 376 №11: бэкап НЕ перезаписывается между прогонами — пишется только
  // при отсутствии файла (базис до ПЕРВОГО прогона), итог сверяется с ним.
  // Копия на прогон — в tmp со штампом времени (для сверки ревьюером).
  const backupPath = `.orca-reports/backup-${ids.objectId}-377.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/377-backup-${stamp}.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) {
    console.log("backup exists — НЕ перезаписывается (minor 376 №11):", backupPath);
  } else {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("backup written (первый прогон):", backupPath, "sig:", sig(before.model).slice(0, 40));
  }
  writeFileSync(stampPath, JSON.stringify(before, null, 1) + "\n");
  await roGuard.assertUnchanged("before");

  await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
  await call("render_plan", {});
  const ed = editorOf();
  console.log("editor:", ed ? "создан" : "НЕТ");
  await assertEditorPlanMatch(ed, ids.planId);
  console.log("гард «план в редакторе == серверу» (fail-closed): OK");

  const created: ProbeCreated[] = [];
  const capturedPath = `.orca-reports/tmp/377-captured-${stamp}.json`;
  const journal = (): void => {
    logCaptured(capturedPath, created, []);
    console.log("журнал захваченных ID:", capturedPath);
  };
  try {
    // ==== сцена (1): лист с допустимым именем + «Нарисовать элемент» ====
    // major 376 №3: имя — из белого списка; отказ на опасном имени проверен
    // офлайн-тестом (tests/unit/377-review-fixes.test.ts), на сайт НЕ отправляется
    const sheetAdd = await call("sheet_add", { name: "Лист 377", content: ["plan", "light"] }) as { id: string; plan: string };
    created.push({ kind: "sheet", siteId: sheetAdd.id });
    journal();
    check(typeof sheetAdd.id === "string" && sheetAdd.id.length >= 6, `sheet_add (имя из белого списка): id=${sheetAdd.id}, план=${sheetAdd.plan}`);
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
    const sheets1 = asList(mg1["custom_plans"]) as Array<{ site_id: string; name: string }>;
    check(sheets1.some((s) => s.site_id === sheetAdd.id && s.name === "Лист 377"), `model_get: лист на месте (${JSON.stringify(sheets1.map((s) => s.name))})`);

    const save1 = await gsave("листы и «Нарисовать элемент»");
    check(save1["verified"] === true, "save verified (листы)");

    // reopen: лист на месте
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mg2 = await call("model_get", {}) as Record<string, unknown>;
    const sheets2 = asList(mg2["custom_plans"]) as Array<{ site_id: string; name: string }>;
    check(sheets2.some((s) => s.site_id === sheetAdd.id && s.name === "Лист 377"), "reopen: лист сохранился");

    // удаление листа — каскад (CustomPlan.delete)
    const del = await call("sheet_delete", { sheet_id: sheetAdd.id }) as { deleted: Record<string, number> };
    check((del.deleted["freelines"] ?? 0) >= 1 && (del.deleted["free_figures"] ?? 0) >= 1 && (del.deleted["thick_lines"] ?? 0) >= 1,
      `sheet_delete: каскад ${JSON.stringify(del.deleted)}`);
    for (const c of created) if (["freeline", "thick_line", "figure"].includes(c.kind)) c.siteId = undefined;
    const save2 = await gsave("удаление листа (каскад)");
    check(save2["verified"] === true, "save verified (удаление листа)");

    // ==== сцена (2): изображения — major 376 №1/№2 ====
    const b64 = pngBytes(8, 6).toString("base64");
    const up = await call("image_upload", { data_base64: b64 }) as { url: string; width_original_px: number; height_original_px: number; mime: string };
    check(up.mime === "image/png" && up.width_original_px === 8 && up.height_original_px === 6 && typeof up.url === "string" && up.url.length > 0,
      `image_upload: url=${String(up.url).slice(0, 30)}, ${up.width_original_px}×${up.height_original_px} ${up.mime}`);
    // major 376 №1: image_add БЕЗ text — restore бандла не падает, text ""
    const pic = await call("image_add", { url: up.url, center: { x: 6000, y: 4000 }, width_original_px: up.width_original_px, height_original_px: up.height_original_px }) as { id: string; width_mm: number };
    created.push({ kind: "picture", siteId: pic.id });
    journal();
    const mgPic = await call("model_get", {}) as Record<string, unknown>;
    const pics1 = asList(mgPic["pictures"]) as Array<{ site_id: string; text?: string }>;
    const pic1 = pics1.find((p) => p.site_id === pic.id);
    check(pic1 !== undefined && pic1.text === "", `image_add без text: text="${pic1?.text ?? "нет записи"}" (major 376 №1)`);
    const save3 = await gsave("изображение без подписи");
    check(save3["verified"] === true, "save verified (изображение без подписи — restore бандла не падает)");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);

    // major 376 №2: подпись с кавычками — канонизация в server-форму,
    // save verified (без ложного NORMALIZATION_DROPPED), warning и видимый текст в ответе
    const cap = "Проба 377 'it' \"A\"";
    const upd = await call("image_update", { image_id: pic.id, text: cap }) as { text?: string; warnings?: string[] };
    check(typeof upd.text === "string" && upd.text.length > 0, `image_update с кавычками: text=${JSON.stringify(upd.text)}`);
    check(Array.isArray(upd.warnings) && upd.warnings.some((w) => String(w).includes("канонизирован")), `warning канонизации в ответе: ${JSON.stringify(upd.warnings ?? [])}`);
    const save4 = await gsave("изображение с подписью с кавычками");
    check(save4["verified"] === true, "save verified (подпись с кавычками — без NORMALIZATION_DROPPED, major 376 №2)");
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mg3 = await call("model_get", {}) as Record<string, unknown>;
    const pics3 = asList(mg3["pictures"]) as Array<{ site_id: string; url: string; text?: string }>;
    const pic3 = pics3.find((p) => p.site_id === pic.id);
    check(pic3 !== undefined && pic3.text === upd.text, `reopen: подпись стабильна (${JSON.stringify(pic3?.text)})`);
    check(pics3.some((p) => p.site_id === pic.id && p.url === up.url), "reopen: изображение с тем же url сохранилось");
    const render2 = await tryCallRender();
    check(render2 !== null && !("__error" in (render2 ?? {})), `render_plan с изображением: ${JSON.stringify(render2).slice(0, 120)}`);

    // minor 376 №5: image_delete называет id удалённого
    const pdel = await call("image_delete", { image_id: pic.id }) as { deleted: string };
    check(pdel["deleted"] === pic.id, `image_delete: deleted=${pdel.deleted} == id удалённого (minor 376 №5)`);
    for (const c of created) if (c.kind === "picture") c.siteId = undefined;
    const save5 = await gsave("удаление изображения");
    check(save5["verified"] === true, "save verified (удаление изображения)");
  } finally {
    try {
      await roGuard.assertUnchanged("restore");
      if (created.some((c) => c.siteId)) {
        // major 376 №4: зачистка ТОЛЬКО общим probe-restore по журналу
        await deleteCreatedByCaptured(call, created, (l) => console.log("restore-obj:", l));
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
    console.log("sig restored == backup (до ПЕРВОГО прогона):", same);
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
    const backupPath = `.orca-reports/backup-${ids.objectId}-377.json`;
    if (existsSync(backupPath)) {
      const ref = JSON.parse(readFileSync(backupPath, "utf8")) as LoadedModel;
      console.error("FAIL-restore: сверка sig с бэкапом (до первого прогона):", sig(afterFail.model) === sig(ref.model) ? "OK" : "РАСХОЖДЕНИЕ");
    } else {
      console.error("FAIL-restore: бэкапа ещё нет (падение до первой записи) — сверка невозможна, записей не было");
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

async function tryCallRender(): Promise<Record<string, unknown> | null> {
  try { return await call("render_plan", {}); }
  catch (e) { return { __error: String((e as Error).message).slice(0, 300) }; }
}
