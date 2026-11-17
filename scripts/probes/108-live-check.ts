// 108: живая проверка исправлений ревью 107 в dev-проекте (REMPLANNER_PROBE_OBJECT_ID /
// REMPLANNER_PROBE_PLAN_ID из env, только inline; контрольный проект — REMPLANNER_SNAPSHOT_*,
// только GET до/после). Бэкап — локальный JSON в .orca-reports/tmp/.
// Сценарии (записи в модели НЕ сохраняются — все пометки отменяются, существующие стены
// не изменяются и не чинятся):
//   1. защита НОВЫХ висячих концов живьём: free-standing стена plan:a → INVALID_GEOMETRY;
//   2. строгий enum материалов живьём: wall_add c_nonsense → INVALID_ARGUMENT;
//   3. R10 живьём: demolish стены (пометка) + demolish_cancel при УНАСЛЕДОВАННЫХ
//      висячих концах старых стен (на 4cad482 обе операции отклонялись guard'ом);
//   4. полная сверка data с бэкапом (исключения: walls.*.eds2.*.*.id, session/log_plan,
//      id комнат — комнаты сверяются по содержимому), контрольный проект до/после.
// Сценарии R2 (merge секторов), R4 (пара замены в updateOpening) и R11 (каскад в ответе
// opening_delete) с записью стен в dev-объекте недоступны: перегородка со свободными
// концами — НОВЫЕ висячие концы (guard правильно отклоняет), у существующих узлов нет
// пригодных пар, у граней — редактор считает onlay (старое состояние, чинить запрещено);
// покрыты пробой 108-norm-check (анонимный проект, настоящий нормализатор + настоящий
// Workspace с guard'ом и verified-save).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID (inline)");
  process.exit(1);
}
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;

const WATCHDOG = setTimeout(() => {
  console.error("TIMEOUT: общий watchdog 8 минут истёк");
  process.exit(90);
}, 8 * 60_000);
WATCHDOG.unref();

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const t = setTimeout(() => {
    console.error(`TIMEOUT: вызов ${name} не ответил за 150 с`);
    process.exit(91);
  }, 150_000);
  t.unref();
  const res = await client.callTool({ name, arguments: args });
  clearTimeout(t);
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 600)}`);
  return JSON.parse(text(res as never));
}
function errorCode(res: { content: { type: string; text?: string }[] }): string {
  const t = text(res);
  try {
    return (JSON.parse(t) as { code?: string }).code ?? "UNKNOWN";
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    if (m) {
      try { return (JSON.parse(m[0]) as { code?: string }).code ?? "UNKNOWN"; } catch { /* ниже */ }
    }
    return t.slice(0, 120);
  }
}
async function callErr(client: Client, name: string, args: Record<string, unknown>): Promise<{ code: string; raw: string } | null> {
  const t = setTimeout(() => process.exit(91), 150_000);
  t.unref();
  const res = await client.callTool({ name, arguments: args });
  clearTimeout(t);
  if (!res.isError) return null;
  return { code: errorCode(res as never), raw: text(res as never).slice(0, 500) };
}

const EDS2_ID = /^walls\.[^.]+\.eds2\.[a-z]+\.\d+\.id$/;
function strip(m: any): string {
  const walk = (v: any, p: string): any => {
    if (Array.isArray(v)) return v.map((e, i) => walk(e, `${p}.${i}`));
    if (v !== null && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v).sort()) {
        const kp = p ? `${p}.${k}` : k;
        if (EDS2_ID.test(kp) || (p === "" && (k === "session" || k === "log_plan"))) continue;
        if ((p === "rooms1" || p === "rooms2") && k === "id") continue;
        o[k] = walk(v[k], kp);
      }
      const keys = Object.keys(o);
      if (p === "rooms1" || p === "rooms2") {
        return JSON.stringify(keys.map((k) => JSON.stringify(o[k])).sort());
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(structuredClone(m), ""));
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
  const client = new Client({ name: "108-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let before: any = null;

  try {
    mkdirSync(".orca-reports/tmp", { recursive: true });

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
    writeFileSync(".orca-reports/tmp/backup-dev-108.json", JSON.stringify({
      _source: "GET через project_open + model_get, dev-проект из env (inline), scripts/probes/108-live-check.ts; id не печатаются",
      model: before,
    }, null, 1));
    console.log("backup ok; counters:", JSON.stringify({
      walls: Object.keys(before.walls ?? {}).length,
      holes: Object.values<any>(before.walls ?? {}).reduce((n: number, w: any) => n + Object.keys(w.holes ?? {}).length, 0),
      rooms: Object.keys(before.rooms2 ?? {}).length,
    }));

    const vBase = await call(client, "model_validate", {});
    console.log("validate (baseline): проблем", (vBase.problems ?? []).length, "(старые висячие стыки, не чинятся)");

    // 1. защита новых дефектов живьём: free-standing стена plan:a вдали от стен
    const freeErr = await callErr(client, "wall_add", { start: { x: 5000, y: 8000 }, end: { x: 6500, y: 8000 } });
    console.log("wall_add free-standing plan:a →", freeErr?.code ?? "ПРОШЁЛ (неожиданно)", "(ожидается INVALID_GEOMETRY — защита новых дефектов)");
    if (freeErr?.code !== "INVALID_GEOMETRY") throw new Error(`защита новых висячих концов не сработала: ${freeErr?.raw ?? "операция прошла"}`);

    // 2. строгий enum материалов живьём
    const errBadMat = await callErr(client, "wall_add", { kind: "partition", material: "c_nonsense", start: { x: 5000, y: 8000 }, end: { x: 6500, y: 8000 } });
    console.log("wall_add material=c_nonsense →", errBadMat?.code ?? "ПРОШЁЛ", "(ожидается INVALID_ARGUMENT)");
    if (errBadMat?.code !== "INVALID_ARGUMENT") throw new Error("строгий enum материалов не работает на живом редакторе");

    // 2b. R10 живьём: перегородка пробы при унаследованных концах. Свободные концы
    // перегородки — НОВЫЕ висячие концы, guard правильно отклоняет (шаг 1); попытка
    // поставить концы на грани существующих стен даёт onlay редактора (старое состояние).
    // Фиксируем попытку и идём дальше: перегородка покроется 108-norm-check.
    const partErr = await callErr(client, "wall_add", { kind: "partition", material: "pgb", start: { x: 5000, y: 8000 }, end: { x: 6500, y: 8000 } });
    console.log("wall_add перегородки (свободные концы) →", partErr?.code ?? "ПРОШЁЛ", "— запись стен в dev-объекте недоступна, сценарии перегородки/пары покрывает 108-norm-check");

    // 3. R10 живьём: пометка демонтажа существующей стены + отмена (спецификация
    // разрешает пометку с последующей отменой и сверкой; wall демонтированный целиком
    // берём дальше от старых стыков)
    const target = Object.values<any>(before.walls).find((w) => (w.demount ?? 0) !== 1);
    if (!target) throw new Error("нет стены для пометки демонтажа");
    const demRes = await call(client, "demolish", { target: "wall", id: target.id });
    if (!demRes.wallId) throw new Error("demolish стены не сработал");
    console.log("R10: demolish существующей стены при унаследованных концах — OK (пометка)");
    const canRes = await call(client, "demolish_cancel", { target: "wall", id: target.id });
    if (!canRes.wallId) throw new Error("demolish_cancel не сработал");
    console.log("R10: demolish_cancel при унаследованных концах — OK (пометка снята)");

    // 4. сверка с бэкапом: переоткрытие проекта (каноническое чтение GET; рабочая копия
    // workspace после нормализаций содержит регенерированные редактором borders)
    await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const after = await call(client, "model_get", { detail: "full" });
    const same = strip(after) === strip(before);
    console.log("полная сверка data с бэкапом (исключения: walls.*.eds2.*.*.id, session/log_plan, id комнат):", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
    if (!same) {
      const diff = diffKeysOf(JSON.parse(strip(before)), JSON.parse(strip(after)));
      console.log("различающиеся пути:", diff.slice(0, 20).join(" | "));
      writeFileSync(".orca-reports/tmp/backup-dev-108-after.json", JSON.stringify({ model: after }, null, 1));
      throw new Error("модель dev-объекта изменилась после пробы");
    }

    // 5. контрольный проект: GET после
    if (SNAP_ID && SNAP_PLAN && snapBefore) {
      await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
      const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
      console.log("контрольный проект:", snapAfter === snapBefore ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
      if (snapAfter !== snapBefore) throw new Error("контрольный проект изменился");
    }
    console.log("108-live OK");
  } catch (e) {
    console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
    // записей нет (все пометки отменяются в самом сценарии), аварийное восстановление не нужно
    process.exitCode = 1;
  } finally {
    await client.close();
    process.exit(process.exitCode ?? 0);
  }
}

await main();
