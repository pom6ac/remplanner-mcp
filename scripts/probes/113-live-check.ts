// 113: живая проверка раздела «Размеры и комментарии» через MCP-инструменты в dev-проекте
// (REMPLANNER_PROBE_OBJECT_ID/PLAN из env, схема «бэкап → запись → проверка →
// восстановление»; пробы удаляют только созданное ими по ID).
// Контрольный проект (только GET) — REMPLANNER_SNAPSHOT_OBJECT_ID/PLAN.
// Схема: контрольный GET → бэкап → baseline validate → dim_add (свободный +
// привязанный к предмету) + comment_add → dims_list/comments_list → validate →
// save (без NORMALIZATION_DROPPED) → reopen → сверка → render PNG → удаление
// созданного → save → полная семантическая сверка data с бэкапом → контрольный GET.
// Watchdog 8 минут, таймауты на вызовах, явный process.exit.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;

const WATCHDOG_MS = 8 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG: ${WATCHDOG_MS / 1000} с — принудительный выход`);
  process.exit(9);
}, WATCHDOG_MS);

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} (${ms} мс)`)), ms)),
  ]);
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await withTimeout(client.callTool({ name, arguments: args }), 120_000, name);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}

/** Служебные поля (меняются при каждом сохранении/открытии) и регенерируемые id
 *  (id комнат rooms1/rooms2 переименовываются по содержимому; id внутри eds2 —
 *  <regen>). rooms2/settings НЕ исключаются (урок R7 ревью 93). */
function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  const stripIds = (v: any): any => {
    if (Array.isArray(v)) return v.map(stripIds);
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = k === "id" && typeof val === "string" ? "<regen>" : stripIds(val);
      return o;
    }
    return v;
  };
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  for (const key of ["rooms1", "rooms2"]) {
    if (c[key] && typeof c[key] === "object") {
      const entries = Object.entries<any>(c[key]).map(([rid, r]) => [rid, stripIds(r)] as const)
        .sort((u, v) => JSON.stringify(u[1]).localeCompare(JSON.stringify(v[1])));
      c[key] = Object.fromEntries(entries.map(([, v], i) => [`ROOM${i + 1}`, v]));
    }
  }
  return JSON.stringify(norm(c));
}

function diffKeysOf(a: any, b: any, path = "", out: string[] = []): string[] {
  if (out.length > 50) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { out.push(path || "<root>"); return out; }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) diffKeysOf(a?.[k], b?.[k], path ? `${path}.${k}` : k, out);
  return out;
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "113-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let persisted = false;
  let before: any = null;
  let created: { rulerIds: string[]; commentIds: string[] } = { rulerIds: [], commentIds: [] };

  try {
    // 0. контрольный проект: GET до (запись запрещена)
    let snapBefore: string | null = null;
    if (SNAP_ID && SNAP_PLAN) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      snapBefore = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект: снимок до снят");
    }

    // 1. бэкап модели до
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    before = await call(client, "model_get", { detail: "full" });
    writeFileSync(".orca-reports/backup-dev-113.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env, scripts/probes/113-live-check.ts, только чтение; id проектов/планов не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length, items: Object.keys(before.items ?? {}).length,
      rooms: Object.keys(before.rooms2 ?? {}).length,
      rulers: Object.keys(before.rulers ?? {}).length, comments: Object.keys(before.comments ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length);

    // 2. инструменты: свободный размер, размер с привязкой к предмету, комментарий
    const itemIds = Object.keys(before.items ?? {});
    console.log("dim_add free:", JSON.stringify(await call(client, "dim_add", {
      p1: { x: 1000, y: 1000 }, p2: { x: 4000, y: 1000 },
      offset_mm: 300, offset_side: "l", show_everywhere: true,
    })));
    if (itemIds.length > 0) {
      console.log("dim_add attached:", JSON.stringify(await call(client, "dim_add", {
        p1: { x: 1000, y: 2000 }, p2: { x: 3000, y: 2000 },
        attach1: itemIds[0], offset_mm: 200,
      })));
    }
    console.log("comment_add:", JSON.stringify(await call(client, "comment_add", {
      point: { x: 2000, y: 3000 }, text: "Проверка MCP 113", font_size: 12, framed: true,
    })));
    // некорректные вызовы отклоняются атомарно
    for (const [name, args] of [
      ["dim_add", { p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } }],
      ["dim_add", { p1: { x: 0, y: 0 }, p2: { x: 5000, y: 0 }, attach1: "нет_такого" }],
      ["comment_add", { point: { x: 0, y: 0 }, text: "" }],
      ["comment_add", { point: { x: 0, y: 0 }, text: "x", url: "javascript:alert(1)" }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      const raw = text(res as never);
      // zod-схемы отклоняют на уровне протокола (MCP error -32602), модельный слой — JSON {code}
      let code = "";
      try { code = (JSON.parse(raw) as { code?: string }).code ?? ""; } catch { code = raw.startsWith("MCP error") ? "SCHEMA_REJECT" : raw.slice(0, 40); }
      console.log("invalid", name, "→", code);
      if (!res.isError) throw new Error(`ожидаемый отказ не случился: ${name}`);
    }

    const dimsNow = await call(client, "dims_list", {});
    const commentsNow = await call(client, "comments_list", {});
    // пробы удаляют только созданное ими по ID: исключаем существовавшие до пробы
    const beforeRulers = new Set(Object.keys(before.rulers ?? {}));
    const beforeComments = new Set(Object.keys(before.comments ?? {}));
    created.rulerIds = (dimsNow as any[]).map((d) => d.id).filter((id) => !beforeRulers.has(id));
    created.commentIds = (commentsNow as any[]).map((c) => c.id).filter((id) => !beforeComments.has(id));
    console.log("dims_list:", JSON.stringify(dimsNow).slice(0, 900));
    console.log("comments_list:", JSON.stringify(commentsNow).slice(0, 600));

    // 3. validate → save → reopen → сверка
    const v = await call(client, "model_validate", {});
    console.log("validate: проблем", (v.problems ?? []).length);
    const saveRes = await call(client, "project_save", {});
    persisted = true;
    console.log("save:", JSON.stringify({ verified: saveRes.verified, rounds: saveRes.rounds, warnings: saveRes.warnings }));
    if (!saveRes.verified) throw new Error("save не verified");

    // reopen: размеры и комментарии пережили сохранение
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const dimsAfter = await call(client, "dims_list", {});
    const commentsAfter = await call(client, "comments_list", {});
    const gotRuler = new Set((dimsAfter as any[]).map((d) => d.id));
    const missingRulers = created.rulerIds.filter((id) => !gotRuler.has(id));
    const missingComments = created.commentIds.filter((id) => !(commentsAfter as any[]).some((c) => c.id === id));
    console.log("reopen: dims", dimsAfter.length, "comments", commentsAfter.length,
      missingRulers.length ? `ПОТЕРЯНЫ РАЗМЕРЫ: ${missingRulers}` : "размеры на месте",
      missingComments.length ? `ПОТЕРЯНЫ КОММЕНТАРИИ: ${missingComments}` : "комментарии на месте");
    if (missingRulers.length || missingComments.length) throw new Error("после reopen созданное потеряно");

    // render
    const png = await call(client, "render_plan", { sheet: "init" });
    console.log("render init:", png.bytes, "байт,", png.path);

    // 4. восстановление: удалить созданное пробой (по ID)
    for (const id of created.rulerIds) await call(client, "dim_delete", { dim_id: id });
    for (const id of created.commentIds) await call(client, "comment_delete", { comment_id: id });
    const saveRes2 = await call(client, "project_save", {});
    console.log("cleanup save:", JSON.stringify({ verified: saveRes2.verified, rounds: saveRes2.rounds }));
    if (!saveRes2.verified) throw new Error("cleanup save не verified");

    // 5. полная семантическая сверка с бэкапом
    const after = await call(client, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diffKeys = diffKeysOf(before, after);
      console.log("различающиеся пути:", diffKeys.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/backup-dev-113-after.json", JSON.stringify({ model: after }, null, 1));
      throw new Error("модель не совпала с бэкапом");
    }

    // 6. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("113-live OK");
    clearTimeout(watchdog);
    await client.close();
    process.exit(0);
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    if (process.env.RP_DEBUG) console.error((e as Error).stack);
    // аварийное восстановление: удалить созданное пробой
    try {
      if (persisted) {
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        for (const id of created.rulerIds) await call(client, "dim_delete", { dim_id: id }).catch(() => {});
        for (const id of created.commentIds) await call(client, "comment_delete", { comment_id: id }).catch(() => {});
        const r = await call(client, "project_save", {});
        console.log("аварийное восстановление:", r.verified ? "OK" : "не verified");
      }
    } catch (e2) {
      console.error("RESTORE-FAIL:", String((e2 as Error).message ?? e2).slice(0, 400));
    }
    clearTimeout(watchdog);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

await main();
