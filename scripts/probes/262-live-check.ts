// 262: живая проверка зонирования потолка ПОСЛЕ исправлений ревью 261 в dev-проекте
// (REMPLANNER_PROBE_* из env, схема «бэкап → запись → проверка → восстановление»,
// правила 239: объекты создаются и удаляются только по захваченным site_id, метки
// резолвятся из свежего model_get; контрольный проект — только GET до/после).
// Сценарий: прямоугольная и Г-образная пробные комнаты + потолочный ригель,
// разделители (в т.ч. концы на разных гранях ригеля, хорда через выемку — отказ),
// затем split/merge стены и wall_delete ПОСЛЕ добавления разделителей, save,
// reopen, сверка с эталоном. node scripts/probes/262-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID и REMPLANNER_PROBE_READONLY_ID");
  process.exit(1);
}
if (OBJECT_ID === READONLY_ID) {
  console.error("REMPLANNER_PROBE_OBJECT_ID совпадает с REMPLANNER_PROBE_READONLY_ID — стоп");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "262-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<Record<string, unknown>> => {
  await sleep(1500);
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const body = text(res);
  if ((res as { isError?: boolean }).isError) {
    const err = new Error(`${name}: ${body.slice(0, 600)}`);
    (err as Error & { body?: string }).body = body;
    throw err;
  }
  if (!opts.quiet) console.log(`  ${name} →`, body.slice(0, 300));
  return JSON.parse(body) as Record<string, unknown>;
};
const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, "1");
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

const created: Array<{ kind: "wall" | "delimiter" | "ceiling" | "rigel"; siteId?: string; roomRef?: string; roomId?: string }> = [];
let opened = false;
const freshLabel = async (coll: "walls" | "rigels", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {}, { quiet: true });
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};
const saveStep = async (tag: string): Promise<{ verified: boolean; warnings: unknown[] }> => {
  const res = await call("project_save", {}, { quiet: true });
  const out = { verified: Boolean(res["verified"]), warnings: (res["warnings"] ?? []) as unknown[] };
  console.log(`SAVE ${tag}: verified=${out.verified} rounds=${res["rounds"]} warnings=${JSON.stringify(out.warnings).slice(0, 500)}`);
  if (!out.verified) throw new Error(`save ${tag} не verified`);
  await sleep(5500);
  return out;
};
const cleanup = async (): Promise<void> => {
  try {
    if (!opened) return;
    // делители по свежему finish_get
    for (const roomRef of [...new Set(created.map((c) => c.roomRef).filter(Boolean) as string[])]) {
      try {
        const fin = await call("finish_get", { room_id: roomRef }, { quiet: true });
        const zds = (((fin as unknown as Array<Record<string, unknown>>)[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>);
        for (const d of zds) {
          try { await call("zone_ceiling_remove", { delimiter_id: String(d["site_id"] ?? d["id"]) }, { quiet: true }); } catch { /* уже нет */ }
        }
        try { await call("finish_ceiling_remove", { room_id: roomRef }, { quiet: true }); } catch { /* уже нет */ }
      } catch { /* комната могла исчезнуть */ }
    }
    // ригель по свежей метке
    const rigelSite = created.find((c) => c.kind === "rigel")?.siteId;
    if (rigelSite) {
      const label = await freshLabel("rigels", rigelSite);
      if (label) { try { await call("rigel_delete", { rigel_id: label }, { quiet: true }); } catch { /* уже нет */ } }
    }
    // стены по свежим меткам
    const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
    let left = [...wallSites];
    for (let guard = 0; guard < 60 && left.length > 0; guard++) {
      const label = await freshLabel("walls", left[0]!);
      if (!label) { left.shift(); continue; }
      try { await call("wall_delete", { wall_id: label }, { quiet: true }); } catch (e) { console.log(`  wall_delete ${label}: ${(e as Error).message.slice(0, 120)}`); }
      left.shift();
    }
    const saveRes = await call("project_save", {}, { quiet: true });
    console.log("cleanup save verified:", saveRes["verified"]);
  } catch (e) {
    console.error("CLEANUP FAIL:", String((e as Error).message ?? e).slice(0, 400));
  }
};

/** Семантическая сигнатура модели (сокр. версия 260): служебные поля исключены,
 *  комнаты/стены/делители — в канонических формах. */
function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  const rooms = {
    ...((c["rooms1"] ?? {}) as Record<string, Record<string, unknown>>),
    ...((c["rooms2"] ?? {}) as Record<string, Record<string, unknown>>),
  } as Record<string, Record<string, unknown>>;
  const canonPoly = (poly: unknown): string => {
    if (!Array.isArray(poly)) return "";
    return (poly as Array<{ x: number; y: number }>).map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(";") + "#";
  };
  const polyList: string[] = [];
  const polyIndex = new Map<string, number>();
  for (const r of Object.values(rooms)) {
    const k = canonPoly(r["polygon"]);
    if (!polyIndex.has(k)) { polyIndex.set(k, polyList.length); polyList.push(k); }
  }
  const roomAlias = new Map<string, string>();
  Object.entries(rooms).forEach(([rid, r]) => {
    const idx = polyIndex.get(canonPoly(r["polygon"]));
    roomAlias.set(rid, `RR${idx === undefined ? polyList.length : idx}`);
  });
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      for (const rec of Object.values(map)) {
        if (Array.isArray(rec["edges"])) {
          rec["edges"] = (rec["edges"] as Array<Record<string, unknown>>).map((e, i) => ({ ...e, id: `ed${i}` }));
        }
        if (Array.isArray(rec["id_of_edges"])) {
          rec["id_of_edges"] = (rec["id_of_edges"] as unknown[]).map((_, i) => `ed${i}`);
        }
      }
      const renamed: Record<string, Record<string, unknown>> = {};
      for (const [rid, rec] of Object.entries(map)) renamed[roomAlias.get(rid) ?? rid] = rec;
      c[rk] = renamed;
    }
  }
  const walls = (c["walls"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const w of Object.values(walls)) {
    const eds2 = w["eds2"] as Record<string, unknown> | undefined;
    if (eds2) {
      for (const side of Object.keys(eds2)) {
        if (Array.isArray(eds2[side])) {
          eds2[side] = (eds2[side] as Array<Record<string, unknown>>).map((e) => JSON.stringify({ ...e, id: null, pc: null })).sort();
        }
      }
    }
  }
  const aliasAll = (v: unknown, parentKey?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => aliasAll(x));
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const kk of Object.keys(v as Record<string, unknown>).sort()) o[kk] = aliasAll((v as Record<string, unknown>)[kk], kk);
      return o;
    }
    if (typeof v === "string" && (parentKey === "id_room" || parentKey === "id")) {
      return roomAlias.get(v) ?? (parentKey === "id_room" ? "DANGLING" : v);
    }
    return v;
  };
  return JSON.stringify(aliasAll(c));
}

try {
  // 0. контрольный проект до (только GET)
  const snapBefore = await snap(READONLY_ID, "before");

  // 1. бэкап dev-проекта
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/262-live-before.json`, JSON.stringify(before, null, 1));
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-262.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь (возможны чужие правки)");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  opened = true;

  // 2. пробные комнаты правее всей геометрии
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 600;
  const oy = 0;
  const mm = (x: number, y: number) => ({ x: Math.round(x * 10), y: Math.round(y * 10) });
  const rect: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [{ x: ox, y: oy }, { x: ox + 300, y: oy }],
    [{ x: ox + 300, y: oy }, { x: ox + 300, y: oy + 200 }],
    [{ x: ox + 300, y: oy + 200 }, { x: ox, y: oy + 200 }],
    [{ x: ox, y: oy + 200 }, { x: ox, y: oy }],
  ];
  const gshape: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [{ x: ox + 400, y: oy }, { x: ox + 800, y: oy }],
    [{ x: ox + 800, y: oy }, { x: ox + 800, y: oy + 200 }],
    [{ x: ox + 800, y: oy + 200 }, { x: ox + 600, y: oy + 200 }],
    [{ x: ox + 600, y: oy + 200 }, { x: ox + 600, y: oy + 400 }],
    [{ x: ox + 600, y: oy + 400 }, { x: ox + 400, y: oy + 400 }],
    [{ x: ox + 400, y: oy + 400 }, { x: ox + 400, y: oy }],
  ];
  const addWall = async (p1: { x: number; y: number }, p2: { x: number; y: number }): Promise<string> => {
    const res = await call("wall_add", { start: mm(p1.x, p1.y), end: mm(p2.x, p2.y), thickness_mm: 100 }, { quiet: true });
    const sid = (res as { entity?: { site_id?: string } }).entity?.site_id;
    if (!sid) throw new Error("wall_add не вернул entity.site_id");
    created.push({ kind: "wall", siteId: sid });
    return sid;
  };
  for (const [p1, p2] of rect) await addWall(p1, p2);
  for (const [p1, p2] of gshape) await addWall(p1, p2);
  console.log("стены пробных комнат:", created.length);
  await saveStep("после стен");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });

  // метки комнат (по bbox)
  const afterWalls = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterWalls.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const roomInBox = (x0: number, x1: number, y0: number, y1: number): string => {
    const found = Object.entries(roomsAfter).find(([, r]) => {
      const p = r.polygon ?? [];
      return p.length >= 3 && p.every((q) => q.x >= x0 - 1 && q.x <= x1 + 1 && q.y >= y0 - 1 && q.y <= y1 + 1);
    });
    if (!found) throw new Error(`комната в (${x0}..${x1}, ${y0}..${y1}) не появилась в rooms2`);
    return `R${Object.keys(roomsAfter).indexOf(found[0]) + 1}`;
  };
  const rectRef = roomInBox(ox, ox + 300, oy, oy + 200);
  const gRef = roomInBox(ox + 400, ox + 800, oy, oy + 400);
  created.push({ kind: "ceiling", roomRef: rectRef }, { kind: "ceiling", roomRef: gRef });
  console.log("пробные комнаты:", rectRef, gRef);

  // 3. ригель в прямоугольной комнате + покрытие потолка
  const rigel = await call("rigel_add", { start: mm(ox + 180, oy + 60), end: mm(ox + 260, oy + 60), depth_mm: 300 }, { quiet: true });
  const rigelSite = (rigel as { entity?: { site_id?: string } }).entity?.site_id;
  if (!rigelSite) throw new Error("rigel_add не вернул site_id");
  created.push({ kind: "rigel", siteId: rigelSite });
  // покрытие потолка НЕ ставим: потеря покрытия при split/merge блокируется
  // слоем отделки (эталон 260), а здесь проверяется слой зон

  // 4. разделители: концы на разных гранях ригеля (верх/лево) + линия в Г-комнате
  const zd1 = await call("zone_ceiling_add", { room_id: rectRef, from_mm: mm(ox, oy + 160), to_mm: mm(ox + 220, oy + 75) }, { quiet: true });
  console.log("zd1 (ригель, верхняя грань):", JSON.stringify(zd1));
  created.push({ kind: "delimiter", siteId: String((zd1 as { entity?: { site_id?: string } }).entity?.site_id ?? ""), roomRef: rectRef });
  const zd2 = await call("zone_ceiling_add", { room_id: rectRef, from_mm: mm(ox + 120, oy), to_mm: mm(ox + 180, oy + 60) }, { quiet: true });
  console.log("zd2 (ригель, левая грань):", JSON.stringify(zd2));
  created.push({ kind: "delimiter", siteId: String((zd2 as { entity?: { site_id?: string } }).entity?.site_id ?? ""), roomRef: rectRef });
  const zd3 = await call("zone_ceiling_add", { room_id: gRef, from_mm: mm(ox + 550, oy), to_mm: mm(ox + 550, oy + 400) }, { quiet: true });
  console.log("zd3 (Г-комната):", JSON.stringify(zd3));
  created.push({ kind: "delimiter", siteId: String((zd3 as { entity?: { site_id?: string } }).entity?.site_id ?? ""), roomRef: gRef });
  // хорда через выемку Г-комнаты — ожидаем отказ (ревью 261 №2)
  try {
    await call("zone_ceiling_add", { room_id: gRef, from_mm: mm(ox + 700, oy + 200), to_mm: mm(ox + 600, oy + 300) }, { quiet: true });
    console.log("FAIL: хорда через выемку прошла (ожидался INVALID_ARGUMENT)");
    throw new Error("хорда через выемку не отвергнута");
  } catch (e) {
    if (String((e as Error).message).includes("не отвергнута")) throw e;
    console.log("хорда через выемку отвергнута:", String((e as Error).message).slice(0, 160));
  }
  await saveStep("после разделителей");

  // 5. reopen → эталон разделителей (по сырой модели: id_room не стабилен,
  // наблюдаем геометрию и состав)
  const observe = async (tag: string): Promise<Record<string, unknown>> => {
    const m = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    const zones = (m.model["zone_delimiters"] ?? {}) as Record<string, Record<string, unknown>>;
    const rooms = (m.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
    const trial = Object.entries(rooms).filter(([, r]) => (r.polygon ?? []).some((q) => q.x >= ox - 1 && q.x <= ox + 800 + 1 && q.y >= oy - 1 && q.y <= oy + 400 + 1));
    const obs = {
      rooms: trial.map(([rid, r]) => ({ rid, poly: r.polygon?.map((p) => [Math.round(p.x), Math.round(p.y)]) })),
      zone_delimiters: Object.entries(zones).map(([k, d]) => ({
        key: k, id: d["id"], id_room: roomAliasOf(rooms, String(d["id_room"] ?? "")), type: d["type"], length: d["length"],
        p1: (d["vertexes"] as Array<{ point?: { x: number; y: number } }> ?? [])[0]?.point,
        p2: (d["vertexes"] as Array<{ point?: { x: number; y: number } }> ?? []).at(-1)?.point,
      })),
    };
    console.log(`OBSERVE ${tag}:`, JSON.stringify(obs));
    return obs;
  };
  const roomAliasOf = (rooms: Record<string, { polygon?: Array<{ x: number; y: number }> }>, rid: string): string | null => {
    const poly = rooms[rid]?.polygon ?? null;
    if (!poly) return rid in rooms ? rid : null;
    const key = JSON.stringify(poly.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]));
    for (const [k, r] of Object.entries(rooms)) {
      if (JSON.stringify((r.polygon ?? []).map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10])) === key) return k;
    }
    return rid;
  };
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const etalon = await observe("reopen-после-разделителей");
  writeFileSync(`${OUT}/262-live-etalon.json`, JSON.stringify({ object_id: OBJECT_ID, plan_id: PLAN_ID, etalon }, null, 1));
  if ((etalon["zone_delimiters"] as unknown[]).length !== 3) {
    throw new Error("после reopen не все разделители на месте");
  }

  // 6. split нижней стены прямоугольной комнаты ПОСЛЕ разделителей
  const bottomSite = created.find((c) => c.kind === "wall")!.siteId!;
  const bottomLabel = await freshLabel("walls", bottomSite);
  if (!bottomLabel) throw new Error("нижняя стена пробной комнаты не найдена");
  const splitRes = await call("wall_split", { wall_id: bottomLabel, at_mm: 1000 }, { quiet: true });
  const partIds = (((splitRes as { entity?: unknown }).entity ?? []) as Array<{ site_id?: string }>).map((p) => p.site_id).filter(Boolean) as string[];
  if (partIds.length !== 2) throw new Error("wall_split не вернул две части");
  created.push({ kind: "wall", siteId: partIds[0] }, { kind: "wall", siteId: partIds[1] });
  await saveStep("после split");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const obsSplit = await observe("после-split");

  // 7. merge: снести обе части и поставить одну целую (контур тот же)
  for (const pid of partIds) {
    const label = await freshLabel("walls", pid);
    if (label) await call("wall_delete", { wall_id: label }, { quiet: true });
  }
  const reAdd = await call("wall_add", { start: mm(ox, oy), end: mm(ox + 300, oy), thickness_mm: 100 }, { quiet: true });
  const reAddId = (reAdd as { entity?: { site_id?: string } }).entity?.site_id;
  if (!reAddId) throw new Error("wall_add (merge) не вернул site_id");
  created.push({ kind: "wall", siteId: reAddId });
  await saveStep("после merge");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const obsMerge = await observe("после-merge");

  // 8. wall_delete в Г-комнате ПОСЛЕ разделителей (ревью 261 №5: штатный случай,
  // без ложной блокировки; каскад/подсказка — по стандарту редактора)
  const gWallSite = created[7]!.siteId!; // G4 — вертикальная стена выемки (стены 0..3 rect, 4..9 Г)
  const gWallLabel = await freshLabel("walls", gWallSite);
  if (!gWallLabel) throw new Error("стена выемки Г-комнаты не найдена");
  const delRes = await call("wall_delete", { wall_id: gWallLabel }, { quiet: true });
  console.log("wall_delete (Г-комната, стена выемки):", JSON.stringify(delRes).slice(0, 300));
  const delStep = await saveStep("после wall_delete в комнате с разделителем");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID }, { quiet: true });
  const obsDel = await observe("после-wall_delete");
  writeFileSync(`${OUT}/262-live-etalon.json`, JSON.stringify({ object_id: OBJECT_ID, plan_id: PLAN_ID, etalon, obsSplit, obsMerge, obsDel, delWarnings: delStep.warnings }, null, 1));

  // 9. восстановление (до сверки)
  for (const roomRef of [...new Set(created.map((c) => c.roomRef).filter(Boolean) as string[])]) {
    try {
      const fin = await call("finish_get", { room_id: roomRef }, { quiet: true });
      const zds = (((fin as unknown as Array<Record<string, unknown>>)[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>);
      for (const d of zds) await call("zone_ceiling_remove", { delimiter_id: String(d["site_id"] ?? d["id"]) }, { quiet: true });
      await call("finish_ceiling_remove", { room_id: roomRef }, { quiet: true });
    } catch { /* комната исчезла */ }
  }
  const rigelLabel = await freshLabel("rigels", rigelSite);
  if (rigelLabel) await call("rigel_delete", { rigel_id: rigelLabel }, { quiet: true });
  const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
  let left = [...wallSites];
  for (let guard = 0; guard < 60 && left.length > 0; guard++) {
    const label = await freshLabel("walls", left[0]!);
    if (!label) { left.shift(); continue; }
    try { await call("wall_delete", { wall_id: label }, { quiet: true }); } catch { /* уже нет */ }
    left.shift();
  }
  const saveRes2 = await call("project_save", {}, { quiet: true });
  console.log("restore save verified:", saveRes2["verified"]);
  if (!saveRes2["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;

  // 10. сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/get-own-after-262.json`, JSON.stringify(finalModel, null, 1));

  // 11. контрольный проект после
  const snapAfter = await loadModel(ctx.session(), READONLY_ID, "1");
  const roSame = sig(snapAfter.model) === sig(snapBefore.model);
  console.log("контрольный проект:", roSame ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
  if (!roSame) throw new Error("контрольный проект изменился");
  console.log("262-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  await cleanup();
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
