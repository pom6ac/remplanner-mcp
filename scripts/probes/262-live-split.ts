// 262b: живой эталон — разделители зон при НАСТОЯЩЕМ split комнаты (новая стена
// через комнату) в dev-проекте (правила 239, бэкап уже снят 262-live-check).
// Кейсы: A — конец разделителя в узле разреза; B — разрез в 10 см от конца
// разделителя (H7 из ревью 261); C — разделитель поперёк разреза.
// node scripts/probes/262-live-split.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") {
  console.error("запуск: … run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || OBJECT_ID === READONLY_ID) {
  console.error("нужны корректные REMPLANNER_PROBE_* (OBJECT_ID != READONLY_ID)");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "262-live-split", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}, quiet = false): Promise<Record<string, unknown>> => {
  await sleep(1500);
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const body = text(res);
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${body.slice(0, 4000)}`);
  if (!quiet) console.log(`  ${name} →`, body.slice(0, 200));
  return JSON.parse(body) as Record<string, unknown>;
};
const created: Array<{ kind: "wall" | "delimiter" | "rigel"; siteId?: string }> = [];
let opened = false;
const freshLabel = async (coll: "walls" | "rigels", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {}, true);
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};
// ревью 263 N7: зачистка только по захваченным site_id через свежий model_get —
// без «удалить все делители проекта»
const removeCapturedDelimiters = async (): Promise<void> => {
  let left = created.filter((c) => c.kind === "delimiter" && c.siteId).map((c) => c.siteId!);
  for (let guard = 0; guard < 20 && left.length > 0; guard++) {
    const mg = await call("model_get", {}, true);
    const list = (mg["zone_delimiters"] ?? []) as Array<{ id: string; site_id: string }>;
    const mine = list.filter((d) => left.includes(d.site_id || d.id));
    if (mine.length === 0) return;
    for (const d of mine) {
      const ref = d.site_id || d.id;
      try { await call("zone_ceiling_remove", { delimiter_id: ref }, true); } catch (e) { console.log(`  zone_ceiling_remove ${ref}:`, String((e as Error).message).slice(0, 120)); }
      left = left.filter((s) => s !== ref);
    }
  }
  if (left.length > 0) console.error("CLEANUP: не удалены разделители:", left.join(","));
};
const cleanup = async (): Promise<void> => {
  try {
    if (!opened) return;
    await removeCapturedDelimiters();
    const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
    let left = [...wallSites];
    for (let pass = 0; pass < 4 && left.length > 0; pass++) {
      for (const sid of [...left]) {
        const mg2 = await call("model_get", {}, true);
        const list = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
        if (!list.some((w) => w.site_id === sid)) { left = left.filter((x) => x !== sid); continue; }
        const label = list.find((w) => w.site_id === sid)!.id;
        try { await call("wall_delete", { wall_id: label }, true); left = left.filter((x) => x !== sid); }
        catch (e) { console.log(`  wall_delete ${label} (попытка ${pass + 1}):`, String((e as Error).message).slice(0, 160)); await sleep(3000); await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true); }
      }
    }
    if (left.length > 0) console.error("CLEANUP: не удалены стены:", left.join(","));
    const saveRes = await call("project_save", {}, true);
    console.log("cleanup save verified:", saveRes["verified"]);
  } catch (e) {
    console.error("CLEANUP FAIL:", String((e as Error).message ?? e).slice(0, 300));
  }
};
const observeZones = async (tag: string, minX: number): Promise<void> => {
  const m = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const zones = (m.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>;
  const rooms = (m.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const trial = Object.entries(rooms).filter(([, r]) => (r.polygon ?? []).some((q) => q.x >= minX));
  console.log(`OBSERVE ${tag}:`, JSON.stringify({
    rooms: trial.map(([rid, r]) => ({ rid, poly: r.polygon?.map((p) => [Math.round(p.x), Math.round(p.y)]) })),
    zones: Object.entries(zones).map(([k, d]) => ({
      key: k, id_room: d["id_room"], length: d["length"],
      p1: (d["vertexes"] as Array<{ point?: { x: number; y: number } }> ?? [])[0]?.point,
      p2: (d["vertexes"] as Array<{ point?: { x: number; y: number } }> ?? []).at(-1)?.point,
    })),
  }));
};

// ревью 263 N7: гард контрольного проекта (только GET) до и после прогона
const snapReadonly = async (tag: string): Promise<unknown> => {
  const m = await loadModel(ctx.session(), READONLY_ID, "1");
  writeFileSync(`${OUT}/get-${READONLY_ID}-split-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

try {
  const snapBefore = await snapReadonly("before");
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-262.json`;
  if (!existsSync(backupPath)) throw new Error("нет бэкапа 262 — сначала 262-live-check");
  const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: Record<string, unknown> };
  const strip = (m: unknown) => { const c = structuredClone(m as Record<string, unknown>); for (const k of ["save_id", "session", "log_plan", "version", "errors", "is_forced"]) delete c[k]; return JSON.stringify(c); };
  console.log("бэкап сверка (strip):", strip(stored.model) === strip(before.model) ? "совпадает" : "РАСХОЖДЕНИЕ (поле session/log_plan меняется при входе — сверка только глазами)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  opened = true;

  const rawWalls = (before.model!["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const mm = (x: number, y: number) => ({ x: Math.round(x * 10), y: Math.round(y * 10) });
  const addWall = async (p1: { x: number; y: number }, p2: { x: number; y: number }): Promise<string> => {
    const res = await call("wall_add", { start: mm(p1.x, p1.y), end: mm(p2.x, p2.y), thickness_mm: 100 }, true);
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add не вернул site_id");
    created.push({ kind: "wall", siteId: sid });
    return sid;
  };

  // комната A: 300×200, разделитель слева-направо, конец в будущем узле разреза
  const ox = Math.ceil(maxX) + 600;
  for (const [p1, p2] of [
    [{ x: ox, y: 0 }, { x: ox + 300, y: 0 }],
    [{ x: ox + 300, y: 0 }, { x: ox + 300, y: 200 }],
    [{ x: ox + 300, y: 200 }, { x: ox, y: 200 }],
    [{ x: ox, y: 200 }, { x: ox, y: 0 }],
  ] as Array<[{ x: number; y: number }, { x: number; y: number }]>) await addWall(p1, p2);
  await call("project_save", {}, true);
  await sleep(5500);
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  const mA = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsA = (mA.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const refA = `R${Object.keys(roomsA).indexOf(Object.entries(roomsA).find(([, r]) => (r.polygon ?? []).every((q) => q.x >= ox - 1 && q.x <= ox + 301))![0]) + 1}`;
  // делитель от левого ребра до точки будущего разреза (x = ox+100, на нижнем ребре)
  const zdA = await call("zone_ceiling_add", { room_id: refA, from_mm: mm(ox, 100), to_mm: mm(ox + 100, 0) }, true);
  console.log("делитель A:", JSON.stringify(zdA).slice(0, 200));
  created.push({ kind: "delimiter", siteId: String((zdA as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  // разрез: новая стена по x=ox+100 от нижнего ребра до верхнего (узел совпадает с концом делителя)
  await addWall({ x: ox + 100, y: 0 }, { x: ox + 100, y: 200 });
  const saveA = await call("project_save", {}, true);
  console.log("SAVE A (конец делителя в узле разреза): verified=", saveA["verified"], "warnings=", JSON.stringify(saveA["warnings"]).slice(0, 400));
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  await observeZones("A-после-split", ox);

  // комната B: 300×200, разрез в 10 см от конца делителя (H7 ревью 261)
  const ox2 = ox + 400;
  for (const [p1, p2] of [
    [{ x: ox2, y: 0 }, { x: ox2 + 300, y: 0 }],
    [{ x: ox2 + 300, y: 0 }, { x: ox2 + 300, y: 200 }],
    [{ x: ox2 + 300, y: 200 }, { x: ox2, y: 200 }],
    [{ x: ox2, y: 200 }, { x: ox2, y: 0 }],
  ] as Array<[{ x: number; y: number }, { x: number; y: number }]>) await addWall(p1, p2);
  await call("project_save", {}, true);
  await sleep(5500);
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  const mB = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsB = (mB.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const refB = `R${Object.keys(roomsB).indexOf(Object.entries(roomsB).find(([, r]) => (r.polygon ?? []).every((q) => q.x >= ox2 - 1 && q.x <= ox2 + 301))![0]) + 1}`;
  const zdB = await call("zone_ceiling_add", { room_id: refB, from_mm: mm(ox2 + 200, 0), to_mm: mm(ox2 + 200, 200) }, true);
  console.log("делитель B (вертикальный):", JSON.stringify(zdB).slice(0, 200));
  created.push({ kind: "delimiter", siteId: String((zdB as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  // разрез на 15 см левее делителя: делитель остаётся в правой части (H7 ревью 261)
  await addWall({ x: ox2 + 180, y: 0 }, { x: ox2 + 180, y: 200 });
  const saveB = await call("project_save", {}, true);
  console.log("SAVE B (разрез в 10 см от конца): verified=", saveB["verified"], "warnings=", JSON.stringify(saveB["warnings"]).slice(0, 400));
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  await observeZones("B-после-split", ox2);

  // комната C: 300×200, делитель поперёк будущего разреза
  const ox3 = ox2 + 400;
  for (const [p1, p2] of [
    [{ x: ox3, y: 0 }, { x: ox3 + 300, y: 0 }],
    [{ x: ox3 + 300, y: 0 }, { x: ox3 + 300, y: 200 }],
    [{ x: ox3 + 300, y: 200 }, { x: ox3, y: 200 }],
    [{ x: ox3, y: 200 }, { x: ox3, y: 0 }],
  ] as Array<[{ x: number; y: number }, { x: number; y: number }]>) await addWall(p1, p2);
  await call("project_save", {}, true);
  await sleep(5500);
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
  const mC = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsC = (mC.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const refC = `R${Object.keys(roomsC).indexOf(Object.entries(roomsC).find(([, r]) => (r.polygon ?? []).every((q) => q.x >= ox3 - 1 && q.x <= ox3 + 301))![0]) + 1}`;
  const zdC = await call("zone_ceiling_add", { room_id: refC, from_mm: mm(ox3, 100), to_mm: mm(ox3 + 300, 100) }, true);
  console.log("делитель C (поперёк):", JSON.stringify(zdC).slice(0, 200));
  created.push({ kind: "delimiter", siteId: String((zdC as { entity?: { site_id?: string } }).entity?.site_id ?? "") });
  try {
    await addWall({ x: ox3 + 150, y: 0 }, { x: ox3 + 150, y: 200 });
    const saveC = await call("project_save", {}, true);
    console.log("SAVE C (делитель поперёк разреза): verified=", saveC["verified"], "warnings=", JSON.stringify(saveC["warnings"]).slice(0, 400));
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, true);
    await observeZones("C-после-split", ox3);
  } catch (e) {
    console.log("C: разрез отклонён/не прошёл:", String((e as Error).message).slice(0, 300));
  }

  // восстановление: разделители — только свои по захваченным site_id через
  // свежий model_get (ревью 263 N7)
  await removeCapturedDelimiters();
  const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
  let left = [...wallSites];
  for (let guard = 0; guard < 60 && left.length > 0; guard++) {
    const label = await freshLabel("walls", left[0]!);
    if (!label) { left.shift(); continue; }
    try { await call("wall_delete", { wall_id: label }, true); } catch { /* уже нет */ }
    left.shift();
  }
  const saveR = await call("project_save", {}, true);
  console.log("restore save verified:", saveR["verified"]);
  if (!saveR["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;

  // контрольный проект после (ревью 263 N7)
  const snapAfter = await loadModel(ctx.session(), READONLY_ID, "1");
  const roSame = sig(snapAfter.model) === sig(snapBefore.model);
  console.log("контрольный проект:", roSame ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
  if (!roSame) throw new Error("контрольный проект изменился");
  console.log("262-live-split OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 4000));
  await cleanup();
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
