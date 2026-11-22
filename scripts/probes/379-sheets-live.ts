// 379: живая перепроверка фикс-2 ревью 378 в dev-объекте (ID — ТОЛЬКО из env
// командной строки, в файлы и коммиты не писать). По заданию 379:
//   (1) minor 378 №16 (открытие): лист с РЕАЛИСТИЧНЫМ именем (кириллица, ё,
//       апостроф, тире, «ёлочки») — sheet_add → save verified → reopen, лист
//       на месте; ОПАСНЫЕ строки на сайт НЕ отправляются ни в каком виде
//       (отказ на них закреплён офлайн-тестами tests/unit/379-review-fixes.test.ts);
//   (2) единая точка проверки модели перед Chromium (major 378 №14/№15) на
//       живой путь не влияет: безопасная модель проходит open → save → reopen.
// Гарды: probe-guard (пара объект/план, READONLY-гард по корневому эталону
// БЕЗ REF_INIT — эталон уже существует), checkEditorPlanMatch fail-closed
// перед каждым project_open, assertUnchanged перед каждой записью, restore по
// журналу site_id в finally (siteId снимается вместе с листом — minor 378 №18,
// лишнего restore-save нет), sig в конце и в catch, ≤30 запросов/мин (лимитер
// MCP), save не чаще раза в 5 с.
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… \
//   REMPLANNER_PROBE_READONLY_ID=… REMPLANNER_PROBE_READONLY_PLAN_ID=… \
//   node scripts/probes/379-sheets-live.ts run
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
const client = new Client({ name: "379-sheets-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  if (process.env["RP_TRACE"]) console.log("CALL", name, JSON.stringify(args).slice(0, 200));
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) {
    writeFileSync(".orca-reports/tmp/379-last-error.json", text(res));
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
  // бэкап НЕ перезаписывается между прогонами (minor 376 №11): базис до ПЕРВОГО
  // прогона 379; копия на прогон — в tmp со штампом времени
  const backupPath = `.orca-reports/backup-${ids.objectId}-379.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampPath = `.orca-reports/tmp/379-backup-${stamp}.json`;
  const before: LoadedModel = await loadModel(ctx.session(), ids.objectId, ids.planId);
  if (existsSync(backupPath)) {
    console.log("backup exists — НЕ перезаписывается:", backupPath);
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
  const capturedPath = `.orca-reports/tmp/379-captured-${stamp}.json`;
  const journal = (): void => {
    logCaptured(capturedPath, created, []);
    console.log("журнал захваченных ID:", capturedPath);
  };
  try {
    // ==== сцена: лист с реалистичным именем (minor 378 №16) ====
    // кириллица + ё + апостроф + тире + «ёлочки»; опасные строки на сайт не идут
    const NAME = "Ёлка '379' — «гостиная»";
    const sheetAdd = await call("sheet_add", { name: NAME, content: ["plan", "light"] }) as { id: string; plan: string };
    created.push({ kind: "sheet", siteId: sheetAdd.id });
    journal();
    check(typeof sheetAdd.id === "string" && sheetAdd.id.length >= 6, `sheet_add (${JSON.stringify(NAME)}): id=${sheetAdd.id}, план=${sheetAdd.plan}`);

    const mg1 = await call("model_get", {}) as Record<string, unknown>;
    const sheets1 = asList(mg1["custom_plans"]) as Array<{ site_id: string; name: string }>;
    check(sheets1.some((s) => s.site_id === sheetAdd.id && s.name === NAME), `model_get: лист на месте (${JSON.stringify(sheets1.map((s) => s.name))})`);

    const save1 = await gsave("лист с реалистичным именем");
    check(save1["verified"] === true, "save verified (лист с кириллицей, апострофом и «ёлочками» — minor 378 №16)");

    // reopen (повторный project_open при запущенном редакторе — major 378 №15
    // на живом пути): лист на месте, сохранение после reopen работает
    await call("project_open", { object_id: ids.objectId, plan_id: ids.planId });
    await assertEditorPlanMatch(editorOf(), ids.planId);
    const mg2 = await call("model_get", {}) as Record<string, unknown>;
    const sheets2 = asList(mg2["custom_plans"]) as Array<{ site_id: string; name: string }>;
    check(sheets2.some((s) => s.site_id === sheetAdd.id && s.name === NAME), "reopen: лист с реалистичным именем сохранился");

    // удаление листа — каскад; siteId листа снимается (minor 378 №18 — без
    // лишнего restore-save в finally)
    const del = await call("sheet_delete", { sheet_id: sheetAdd.id }) as { deleted: Record<string, number> };
    console.log("sheet_delete: каскад", JSON.stringify(del.deleted));
    for (const c of created) if (c.kind === "sheet") c.siteId = undefined;
    journal();
    const save2 = await gsave("удаление листа");
    check(save2["verified"] === true, "save verified (удаление листа)");
    const mg3 = await call("model_get", {}) as Record<string, unknown>;
    const sheets3 = asList(mg3["custom_plans"]) as Array<{ site_id: string; name: string }>;
    check(!sheets3.some((s) => s.site_id === sheetAdd.id), "после удаления листа в модели нет");
  } finally {
    try {
      await roGuard.assertUnchanged("restore");
      if (created.some((c) => c.siteId)) {
        // зачистка ТОЛЬКО общим probe-restore по журналу site_id
        await deleteCreatedByCaptured(call, created, (l) => console.log("restore-obj:", l));
        await restoreByCaptured({
          call,
          created,
          ownRoomIds: [],
          save: () => gsave("restore"),
          log: (line) => console.log("restore:", line),
        });
      } else {
        console.log("restore: захватов нет — restore-save пропущен (minor 378 №18)");
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
    const backupPath = `.orca-reports/backup-${ids.objectId}-379.json`;
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
