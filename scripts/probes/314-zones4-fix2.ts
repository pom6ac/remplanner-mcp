// 314 (ревью 313): живая перепроверка фикса повторного ревью в dev-проекте
// (REMPLANNER_PROBE_* из env, схема «бэкап → запись → проверка → восстановление»):
// B — wall_add делит комнату с закладной и ОДИНАКОВОЙ отделкой зон → save verified
// без NORMALIZATION_DROPPED (ложная строгость сверки split снята), полигоны зон
// сверяются с частями; №4 — ниша + ceiling_rigel_add → save → reopen: ниша в зоне
// с отделкой, линия обрезана по ребру зоны (сверка полигонов). Контрольный GET до/
// после (ID из env) — канон + save_id, в finally. Восстановление по захваченным
// site_id в finally.
// node scripts/probes/314-zones4-fix2.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard, type ReadonlyGuard } from "./probe-guard.ts";
import { sig } from "./probe-sig.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … run (ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID/PLAN_ID/READONLY_ID/READONLY_PLAN_ID");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "314-zones4-fix2", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 2000)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const snap = async (objectId: string, planId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, planId);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`${OUT}/314-get-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const save = async (label: string): Promise<Record<string, unknown>> => {
  await sleep(5100); // сохранение не чаще раза в 5 с
  const res = await call("project_save", {});
  console.log(`${label}: save`, JSON.stringify({ verified: res["verified"], warnings: res["warnings"] }));
  return res;
};

let created: Array<{ kind: "wall" | "rigel" | "delimiter" | "ceiling"; siteId?: string; roomRef?: string }> = [];
let opened = false;
let before: LoadedModel | null = null;
let roBefore: LoadedModel | null = null;

let restored = false;
async function restoreByCaptured(): Promise<void> {
  if (restored || !opened) return;
  restored = true;
  // отделка/ниши блокируют wall_delete — снимаем перед удалением стен
  const roomRefCap = created.find((c) => c.kind === "ceiling")?.roomRef;
  if (roomRefCap) {
    try { await call("finish_ceiling_niche_remove", { room_id: roomRefCap }); } catch { /* уже сняты */ }
    try { await call("finish_ceiling_remove", { room_id: roomRefCap }); } catch { /* уже снята */ }
    await save("restore: снять отделку");
  }
  const mg = await call("model_get", {});
  const crs = (mg["ceiling_rigels"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "rigel" && x.siteId)) {
    if (!crs.some((r) => r.site_id === c.siteId)) { console.log(`restore: пропуск закладной ${c.siteId} — на сервере нет`); continue; }
    try { await call("ceiling_rigel_delete", { rigel_id: c.siteId! }); } catch { /* уже нет */ }
  }
  const mg2 = await call("model_get", {});
  const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
  const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 200)); }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  const saveRes = await save("restore: зачистка");
  if (!saveRes["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;
}

/** Записи потолков комнаты: [индекс, exist, материал, xMin..xMax полигона, ниши]. */
const ceilBrief = (model: Record<string, unknown>, trialId: string): string => {
  const rooms = (model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  const r = rooms[trialId];
  if (!r) return "комната не найдена";
  const ceils = (Array.isArray(r["ceilings"]) ? r["ceilings"] : []) as Array<Record<string, unknown>>;
  return ceils.map((c, i) => {
    const poly = (c["polygon"] ?? []) as Array<{ x: number; y: number }>;
    const xs = poly.map((p) => Math.round(p.x));
    const nch = (Array.isArray(c["niches"]) ? c["niches"] : []) as Array<Record<string, unknown>>;
    const n = nch.some((nn) => nn?.exist === true) ? " N" : "";
    return `#${i} ${c["exist"] === true ? String(c["material"]) : "-"} [${xs.length ? `${Math.min(...xs)}..${Math.max(...xs)}` : "нет полигона"}]${n}`;
  }).join(" | ");
};

let trialId = "";
let trialRef = "";
let roGuard: ReadonlyGuard | null = null;

try {
  // 0. контрольный проект до (только GET)
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, `${OUT}/314-readonly-ref.json`);
  await roGuard.assertUnchanged("перед записями");
  roBefore = await snap(READONLY_ID, READONLY_PLAN_ID, "readonly-before");

  // 1. бэкап dev-проекта (бэкап → запись → проверка → восстановление)
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-314.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;
  // гард «план в редакторе == серверу»
  await call("render_plan", {});
  const editor = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editor ? await editor.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу»: OK");

  // 2. пробная комната: правее всей геометрии, 4 стены 220×160 см, толщина 100 мм
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 300;
  const oy = 0;
  const w = 220, h = 160;
  type Pt = { x: number; y: number };
  const rect: [Pt, Pt][] = [
    [{ x: ox, y: oy }, { x: ox + w, y: oy }],
    [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }],
    [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }],
    [{ x: ox, y: oy + h }, { x: ox, y: oy }],
  ];
  for (const [p1, p2] of rect) {
    const res = await call("wall_add", {
      start: { x: Math.round(p1.x * 10), y: Math.round(p1.y * 10) },
      end: { x: Math.round(p2.x * 10), y: Math.round(p2.y * 10) },
      thickness_mm: 100,
    });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add не вернул entity.site_id");
    created.push({ kind: "wall", siteId: sid });
  }
  await save("пробная комната");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const trial = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1);
  });
  if (!trial) throw new Error("пробная комната не появилась в rooms2");
  trialId = trial[0]!;
  trialRef = `R${Object.keys(roomsAfter).indexOf(trialId) + 1}`;
  console.log("пробная комната:", trialId, "метка:", trialRef);
  created.push({ kind: "ceiling", roomRef: trialRef });
  // метка W верхнем стены (3-я в порядке добавления: bottom, right, top, left)
  const mgWalls = (await call("model_get", {}))["walls"] as Array<{ id: string; site_id: string }>;
  const topWallSite = created[2]!.siteId!;
  const topWallLabel = mgWalls.find((wl) => wl.site_id === topWallSite)?.id;
  if (!topWallLabel) throw new Error("метка верхней стены не найдена в model_get");

  // ---------- №4: ниша + rigel_add → ниша в зоне-наследнике, линия обрезана ----------
  await call("finish_ceiling_set", { room_id: trialRef, material: "gypsum_ceiling", profile: "standard" });
  await save("№4: отделка");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const niche = await call("finish_ceiling_niche_add", { room_id: trialRef, wall_id: topWallLabel });
  console.log("№4 finish_ceiling_niche_add:", JSON.stringify(niche).slice(0, 160));
  await save("№4: ниша");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const stN = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  console.log("№4 ceilings до закладной:", ceilBrief(stN.model as Record<string, unknown>, trialId));
  const rigelX = ox + 110;
  const rgN = await call("ceiling_rigel_add", {
    room_id: trialRef,
    start: { x: Math.round(rigelX * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round(rigelX * 10), y: Math.round((oy + h - 6) * 10) },
  });
  const rgNSite = String(rgN["site_id"] ?? "");
  if (!rgNSite) throw new Error("ceiling_rigel_add №4 не вернул site_id");
  created.push({ kind: "rigel", siteId: rgNSite });
  await save("№4: закладная (перенос ниши)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const stN2 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  console.log("№4 ceilings после rigel_add:", ceilBrief(stN2.model as Record<string, unknown>, trialId));
  {
    const rooms = (stN2.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
    const ceils = (rooms[trialId]!["ceilings"] ?? []) as Array<Record<string, unknown>>;
    const holders = ceils.filter((c) =>
      c["exist"] === true && typeof c["material"] === "string" &&
      ((Array.isArray(c["niches"]) ? c["niches"] : []) as Array<Record<string, unknown>>).some((nn) => nn?.exist === true));
    if (holders.length !== 1) throw new Error(`№4: ниша должна быть в одной записи с отделкой, получено ${holders.length}`);
    const zonePoly = (holders[0]!["polygon"] ?? []) as Array<{ x: number; y: number }>;
    const xs = zonePoly.map((p) => p.x);
    const [zx0, zx1] = [Math.min(...xs), Math.max(...xs)];
    const nch = (holders[0]!["niches"] ?? []) as Array<Record<string, unknown>>;
    const idx = nch.findIndex((nn) => nn?.exist === true);
    const part = Object.values((nch[idx]!["parts"] ?? {}) as Record<string, Record<string, unknown>>)[0]!;
    const line = part["line"] as { p1: { x: number; y: number }; p2: { x: number; y: number } };
    console.log(`№4 зона-наследник: x ${zx0.toFixed(2)}..${zx1.toFixed(2)}, линия ниши: ${JSON.stringify(line)}`);
    // сверка полигонов: линия ниши внутри полигона зоны-наследника, полосу закладной не пересекает
    const inZone = [line.p1, line.p2].every((p) => p.x >= zx0 - 1 && p.x <= zx1 + 1);
    if (!inZone) throw new Error(`№4: линия ниши (${line.p1.x}..${line.p2.x}) вне полигона зоны-наследника (${zx0}..${zx1})`);
    const band = [line.p1.x, line.p2.x].some((x) => x > rigelX - 4 && x < rigelX + 4);
    if (band) throw new Error(`№4: линия ниши проходит через закладную (x≈${rigelX}): ${JSON.stringify(line)}`);
    const zoneYs = zonePoly.map((p) => p.y);
    if (Math.abs(line.p1.y - line.p2.y) > 0.05 || Math.abs(line.p1.y - Math.max(...zoneYs)) > 1) {
      throw new Error(`№4: линия ниши не на ребре зоны-наследника (y ${line.p1.y} vs ${Math.min(...zoneYs)}..${Math.max(...zoneYs)}): ${JSON.stringify(line)}`);
    }
    const idc = part["id_ceiling"];
    if (idc !== holders[0]!["id"]) throw new Error(`№4: id_ceiling ${String(idc)} != id записи-наследника ${String(holders[0]!["id"])}`);
    console.log("№4: ниша в зоне с отделкой, линия обрезана по ребру — OK");
  }
  // зачистка №4
  await call("finish_ceiling_niche_remove", { room_id: trialRef });
  await call("ceiling_rigel_delete", { rigel_id: rgNSite });
  await call("finish_ceiling_remove", { room_id: trialRef });
  await save("№4: зачистка");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

  // ---------- B: wall_add делит комнату с закладной и одинаковой отделкой зон ----------
  await call("finish_ceiling_set", { room_id: trialRef, material: "gypsum_ceiling", profile: "standard" });
  await save("B: отделка");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const rgB = await call("ceiling_rigel_add", {
    room_id: trialRef,
    start: { x: Math.round(rigelX * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round(rigelX * 10), y: Math.round((oy + h - 6) * 10) },
  });
  const rgBSite = String(rgB["site_id"] ?? "");
  if (!rgBSite) throw new Error("ceiling_rigel_add B не вернул site_id");
  created.push({ kind: "rigel", siteId: rgBSite });
  await save("B: закладная");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  // отделка во ВСЕ зоны (зонированная комната)
  await call("finish_ceiling_set", { room_id: trialRef, material: "gypsum_ceiling", profile: "standard" });
  await save("B: отделка обеих зон");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const stB = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  console.log("B ceilings до wall_add:", ceilBrief(stB.model as Record<string, unknown>, trialId));
  // стена x = ox+60 делит комнату (между левой стеной и закладной)
  const wallRes = await call("wall_add", {
    start: { x: Math.round((ox + 60) * 10), y: Math.round(oy * 10) },
    end: { x: Math.round((ox + 60) * 10), y: Math.round((oy + h) * 10) },
    thickness_mm: 100,
  });
  const wallSite = (wallRes as { entity?: { site_id?: string } }).entity?.site_id;
  if (!wallSite) throw new Error("wall_add B не вернул entity.site_id");
  created.push({ kind: "wall", siteId: wallSite });
  const saveB = await save("B: wall_add (ключевая проверка)");
  if (!saveB["verified"]) throw new Error("B: save после wall_add не verified (NORMALIZATION_DROPPED?)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const stB2 = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  {
    const rooms = (stB2.model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
    const parts = Object.entries(rooms).filter(([, r]) => {
      const p = (r["polygon"] ?? []) as Array<{ x: number; y: number }>;
      return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1);
    });
    console.log("B: комнат в зоне пробы после split:", parts.length);
    if (parts.length !== 2) throw new Error(`B: ожидалось 2 части, найдено ${parts.length}`);
    for (const [pid, r] of parts) {
      const poly = (r["polygon"] ?? []) as Array<{ x: number; y: number }>;
      const [px0, px1] = [Math.min(...poly.map((p) => p.x)), Math.max(...poly.map((p) => p.x))];
      const ceils = (r["ceilings"] ?? []) as Array<Record<string, unknown>>;
      const mats = ceils.filter((c) => c["exist"] === true && typeof c["material"] === "string");
      console.log(`B часть ${pid}: x ${px0.toFixed(0)}..${px1.toFixed(0)}, зон с отделкой: ${mats.length}, ${ceilBrief(stB2.model as Record<string, unknown>, pid)}`);
      if (mats.length === 0) throw new Error(`B: часть ${pid} осталась без отделки потолка`);
      // сверка полигонов: полигон каждой зоны внутри полигона своей части
      for (const c of mats) {
        const zp = (c["polygon"] ?? []) as Array<{ x: number; y: number }>;
        const [zx0, zx1] = [Math.min(...zp.map((p) => p.x)), Math.max(...zp.map((p) => p.x))];
        if (zx0 < px0 - 1 || zx1 > px1 + 1) {
          throw new Error(`B: полигон зоны (${zx0}..${zx1}) вне полигона части (${px0}..${px1})`);
        }
      }
    }
    console.log("B: save verified без NORMALIZATION_DROPPED, отделка в обеих частях, полигоны зон в пределах частей — OK");
  }
  // зачистка B
  try { await call("finish_ceiling_niche_remove", { room_id: trialRef }); } catch { /* ниш нет */ }
  await call("finish_ceiling_remove", { room_id: trialRef });
  await save("B: снять отделку");
  await call("ceiling_rigel_delete", { rigel_id: rgBSite });
  await call("model_get", {});
  const mgW2 = (await call("model_get", {}))["walls"] as Array<{ id: string; site_id: string }>;
  const divLabel = mgW2.find((wl) => wl.site_id === wallSite)?.id;
  if (divLabel) {
    try { await call("wall_delete", { wall_id: divLabel }); } catch (e) { console.log("B: wall_delete:", String((e as Error).message).slice(0, 200)); }
  }
  await save("B: зачистка");

  // восстановление по захваченным site_id
  await restoreByCaptured();

  // полная семантическая сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/314-get-own-after.json`, JSON.stringify(finalModel, null, 1));
  if (!same) throw new Error("dev-проект не совпал с бэкапом");
  console.log("314-zones4-fix2 OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 4000));
  process.exitCode = 1;
} finally {
  try {
    await restoreByCaptured();
  } catch (ce) {
    console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400));
    process.exitCode = 1;
  }
  if (before) {
    try {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model);
      if (same) console.log("finally: семантическая сверка с бэкапом — OK");
      else {
        writeFileSync(`${OUT}/314-get-own-after.json`, JSON.stringify(final, null, 1));
        console.error("РАСХОЖДЕНИЕ после restore: модель не совпала с бэкапом (дамп в 314-get-own-after.json)");
        process.exitCode = 1;
      }
    } catch (ve) {
      console.error("VERIFY FAIL:", String((ve as Error).message ?? ve).slice(0, 400));
      process.exitCode = 1;
    }
  }
  // контрольный GET «после» — в finally; ревью 319 №4: с фиксированным эталоном
  try {
    if (!roGuard) throw new Error("гард контрольного проекта не создан");
    const roOk = !(await roGuard.checkFinal("finally"));
    console.log("finally: контрольный проект:", roOk ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
  } catch (re) {
    console.error("finally: контрольная сверка не удалась:", String((re as Error).message ?? re).slice(0, 300));
    process.exitCode = 1;
  }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
