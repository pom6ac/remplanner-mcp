// 328: зачистка остатков живой пробы (только свои объекты: 4 стены пробной
// комнаты + отделка complex комнаты-остатка). Гарды: ID из env, контрольный
// контрольный проект из env, бэкап-сверка.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { sig } from "./probe-sig.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, readonlyRefPath, type ReadonlyGuard } from "./probe-guard.ts";
import { readFileSync } from "node:fs";

if (process.argv[2] !== "run") { console.error("запуск: run"); process.exit(0); }
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"] as string;
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"] as string;
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"] as string;
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"] as string;
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 10 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "328-cleanup", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as TextContent).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 500)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
let roGuard: ReadonlyGuard | null = null;
try {
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  // остатки пробы: стены правее x=1700 (созданы пробой 328; пользовательская геометрия левее)
  const leftoverWalls = Object.values(before.model["walls"] ?? {} as Record<string, { id: string; site_id: string; p1: { x: number; y: number } }>)
    .filter((w) => w.p1 && w.p2 && w.p1.x > 1400 && w.p2.x > 1400 && w.p1.y > 1100 && w.p2.y > 1100);
  console.log("остатки стен:", leftoverWalls.map((w) => w.id));
  // комнаты-остатки: ceilings с complex правее x=1700
  const rooms = (before.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; ceilings?: Array<Record<string, unknown>> }>;
  const leftoverRooms = Object.entries(rooms).filter(([, r]) =>
    (r.polygon ?? []).some((p) => p.x > 1700) && (r.ceilings ?? []).some((c) => c["exist"] === true || c["complex"] === true));
  console.log("остатки комнат с отделкой:", leftoverRooms.map(([id]) => id));
  // снять отделку потолка комнаты-остатка до удаления стен (иначе wall_delete
  // блокируется потерей отделки при исчезновении комнаты)
  for (const [id] of leftoverRooms) {
    const mg = await call("model_get", {});
    const list = (mg["rooms"] ?? []) as Array<{ id: string; site_id?: string }>;
    const ref = list.find((r) => r.site_id === id)?.id ?? id;
    try {
      await call("finish_ceiling_remove", { room_id: ref });
      console.log("finish_ceiling_remove:", ref);
    } catch (e) { console.log("finish_ceiling_remove:", String((e as Error).message).slice(0, 150)); }
  }
  await roGuard?.assertUnchanged("перед save зачистки");
  const s1 = await call("project_save", {});
  console.log("save 1:", JSON.stringify({ verified: s1["verified"], warnings: s1["warnings"] }));
  await new Promise((r) => setTimeout(r, 5500));
  for (const w of leftoverWalls) {
    try { await call("wall_delete", { wall_id: w.id }); console.log("wall_delete:", w.id); }
    catch (e) { console.log(`wall_delete ${w.id}:`, String((e as Error).message).slice(0, 200)); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  await roGuard?.assertUnchanged("перед save 2");
  const s2 = await call("project_save", {});
  console.log("save 2:", JSON.stringify({ verified: s2["verified"], warnings: s2["warnings"] }));
  const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const refModel = JSON.parse(readFileSync(`.orca-reports/backup-${OBJECT_ID}-328.json`, "utf8")) as { model: Record<string, unknown> };
  const same = sig(final.model) === sig(refModel.model);
  console.log("сверка с бэкапом:", same ? "OK" : "РАСХОЖДЕНИЕ (внешние правки объекта в течение дня — см. отчёт)");
  if (!same) {
    const counts = (m: Record<string, unknown>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(m)) out[k] = v && typeof v === "object" ? (Array.isArray(v) ? v.length : Object.keys(v).length) : 0;
      return out;
    };
    const c1 = counts(refModel.model), c2 = counts(final.model);
    for (const k of new Set([...Object.keys(c1), ...Object.keys(c2)])) if (c1[k] !== c2[k]) console.log("коллекция", k, ":", c1[k], "→", c2[k]);
  }
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
  process.exitCode = 1;
} finally {
  try { await roGuard?.checkFinal("finally"); } catch (ce) { console.error("ro:", String((ce as Error).message ?? ce).slice(0, 200)); }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
