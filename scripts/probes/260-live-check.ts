// 260: живая проверка зонирования потолка в dev-проекте (REMPLANNER_PROBE_* из env,
// схема «бэкап → запись → проверка → восстановление»): пробная комната из 4 стен
// (создаётся и удаляется по захваченным site_id; метки резолвятся из свежего
// model_get перед каждым удалением — инцидент 240), покрытие потолка, два
// разделителя зон, split/merge стены пробной комнаты, restore в finally.
// Контрольный проект (только GET) — REMPLANNER_PROBE_READONLY_ID.
// node scripts/probes/260-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, assertUnchangedRef, newGuardRef, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
  process.exit(0);
}
const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID (322 N3б)");
  process.exit(1);
}
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "260-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, READONLY_PLAN_ID);
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

/** Созданные объекты: удаление в finally по site_id (метки — из свежего model_get). */
const created: Array<{ kind: "wall" | "delimiter" | "ceiling"; siteId?: string; roomRef?: string; roomId?: string }> = [];
let opened = false;
const freshLabel = async (coll: "walls", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {});
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};
const cleanup = async (): Promise<void> => {
  try {
    if (opened) {
      // делители и покрытие
      if (created.some((c) => c.kind === "delimiter" || c.kind === "ceiling") && created.find((c) => c.roomRef)?.roomRef) {
        const roomRef = created.find((c) => c.roomRef)!.roomRef!;
        const fin = await call("finish_get", { room_id: roomRef });
        const zds = (((fin as unknown as Array<Record<string, unknown>>)[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>);
        for (const d of zds) {
          try { await call("zone_ceiling_remove", { delimiter_id: String(d["site_id"] ?? d["id"]) }); } catch { /* уже нет */ }
        }
        try { await call("finish_ceiling_remove", { room_id: roomRef }); } catch { /* уже нет */ }
      }
      // стены по свежим меткам
      const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
      let left = [...wallSites];
      for (let guard = 0; guard < 40 && left.length > 0; guard++) {
        const label = await freshLabel("walls", left[0]!);
        if (!label) { left.shift(); continue; }
        await call("wall_delete", { wall_id: label });
        left.shift();
      }
      await assertUnchangedRef(roRef, "{tag}");
      await call("project_save", {});
      console.log("cleanup save: OK");
    }
  } catch (e) {
    console.error("CLEANUP FAIL:", String((e as Error).message ?? e).slice(0, 400));
  }
};

/** Семантическая сигнатура модели (как в 245/250): служебные поля исключены,
 *  регенерируемые id (eds2, edges, комнаты, узлы/делители, части отделки) —
 *  в канонические формы. */
function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  const walls = (c["walls"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const w of Object.values(walls)) {
    const eds2 = w["eds2"] as Record<string, unknown> | undefined;
    if (eds2) {
      for (const side of Object.keys(eds2)) {
        if (Array.isArray(eds2[side])) {
          const canon = (eds2[side] as Array<Record<string, unknown>>)
            .map((e) => ({ ...e, id: null, pc: null }))
            .map((e) => JSON.stringify(e, Object.keys(e).sort()))
            .sort();
          eds2[side] = canon;
        }
      }
    }
  }
  const rooms = {
    ...((c["rooms1"] ?? {}) as Record<string, Record<string, unknown>>),
    ...((c["rooms2"] ?? {}) as Record<string, Record<string, unknown>>),
  } as Record<string, Record<string, unknown>>;
  const canonPoly = (poly: unknown): string => {
    if (!Array.isArray(poly)) return "";
    const pts = (poly as Array<{ x: number; y: number }>)
      .map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    let min = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]!.x < pts[min]!.x || (pts[i]!.x === pts[min]!.x && pts[i]!.y < pts[min]!.y)) min = i;
    }
    return pts.map((p) => `${p.x},${p.y}`).join(";") + `#${min}`;
  };
  const polyList: string[] = [];
  const polyIndex = new Map<string, number>();
  for (const r of Object.values(rooms)) {
    const k = canonPoly(r["polygon"]);
    if (!polyIndex.has(k)) {
      polyIndex.set(k, polyList.length);
      polyList.push(k);
    }
  }
  const roomAlias = new Map<string, string>();
  Object.entries(rooms).forEach(([rid, r]) => {
    const k = canonPoly(r["polygon"]);
    const idx = polyIndex.get(k);
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
        if (rec["delimiters"] && typeof rec["delimiters"] === "object") {
          const canon: Record<string, unknown> = {};
          for (const d of Object.values(rec["delimiters"] as Record<string, Record<string, unknown>>)) {
            const v = (d["vertexes"] ?? []) as Array<{ point?: { x: number; y: number } }>;
            const pts = v.map((x) => x.point ? `${Math.round(x.point.x * 10) / 10},${Math.round(x.point.y * 10) / 10}` : "?").sort();
            canon[`${d["type"]}|${d["plan"]}|${pts.join(";")}`] = { type: d["type"], plan: d["plan"], length: d["length"], on_size: d["on_size"], items: Object.values(d["items"] ?? {}).sort() };
          }
          rec["delimiters"] = canon;
        }
        for (const kk of ["floorMoldings", "ceilingMoldings"]) {
          if (Array.isArray(rec[kk])) {
            rec[kk] = (rec[kk] as Array<Record<string, unknown>>).map((side) => {
              const s = structuredClone(side);
              if (s && typeof s === "object" && s["parts"] && typeof s["parts"] === "object") {
                const parts: Record<string, unknown> = {};
                for (const p of Object.values(s["parts"] as Record<string, Record<string, unknown>>)) {
                  parts[JSON.stringify(p, Object.keys(p).sort())] = { ...p, id: null, id_room: null, id_ceiling: null };
                }
                s["parts"] = parts;
              }
              return s;
            });
          }
        }
        if (Array.isArray(rec["ceilings"])) {
          rec["ceilings"] = (rec["ceilings"] as Array<Record<string, unknown>>).map((ce) => ({ ...ce, id: null, id_room: null }));
        }
      }
    }
  }
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      const renamed: Record<string, Record<string, unknown>> = {};
      for (const [rid, rec] of Object.entries(map)) {
        renamed[roomAlias.get(rid) ?? rid] = rec;
      }
      c[rk] = renamed;
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

const roRef = newGuardRef();
try {
  // 0. ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(OBJECT_ID, READONLY_ID, READONLY_PLAN_ID));
  roRef.current = roGuard;
  await roGuard.assertUnchanged("перед записями");
  const snapBefore = await snap(READONLY_ID, "before");

  // 1. бэкап dev-проекта (только если ещё нет — иначе сверка)
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/260-live-before.json`, JSON.stringify(before, null, 1));
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-260.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    const same = sig(stored.model) === sig(before.model);
    console.log("бэкап существует; сверка с текущим GET:", same ? "совпадает" : "РАСХОЖДЕНИЕ — СТОП");
    if (!same) throw new Error("модель на сервере не совпадает с бэкапом — сначала разберитесь (возможны чужие правки)");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  opened = true;

  // 2. пробная комната: правее всей геометрии, 4 стены 200×150 см
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 300;
  const oy = 0;
  const w = 200, h = 150;
  const rect: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
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
  console.log("стены пробной комнаты:", created.length);
  await assertUnchangedRef(roRef, "{tag}");
  const saveRoom = await call("project_save", {});
  console.log("save пробной комнаты:", JSON.stringify({ verified: saveRoom["verified"], rounds: saveRoom["rounds"] }));
  if (!saveRoom["verified"]) throw new Error("save пробной комнаты не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterRoom = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const roomsAfter = (afterRoom.model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }> }>;
  const trialEntry = Object.entries(roomsAfter).find(([, r]) => {
    const p = r.polygon ?? [];
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1);
  });
  if (!trialEntry) throw new Error("пробная комната не появилась в rooms2");
  const trialRoomId = trialEntry[0]!;
  const roomRef = `R${Object.keys(roomsAfter).indexOf(trialRoomId) + 1}`;
  if (roomRef === "R0") throw new Error(`метка пробной комнаты не найдена (${trialRoomId})`);
  console.log("пробная комната:", trialRoomId, "метка:", roomRef);
  created.push({ kind: "ceiling", roomRef, roomId: trialRoomId });

  // 4. топология ДО отделки: split нижней стены пробной комнаты (коллинеарная вершина)
  const bottomSite = created.find((c) => c.kind === "wall")!.siteId!;
  const bottomLabel = await freshLabel("walls", bottomSite);
  if (!bottomLabel) throw new Error("нижняя стена пробной комнаты не найдена");
  const splitRes = await call("wall_split", { wall_id: bottomLabel, at_mm: 1000 });
  const partIds = (((splitRes as { entity?: unknown }).entity ?? []) as Array<{ site_id?: string }>).map((p) => p.site_id).filter(Boolean) as string[];
  if (partIds.length !== 2) throw new Error("wall_split не вернул две части");
  created.push({ kind: "wall", siteId: partIds[0] }, { kind: "wall", siteId: partIds[1] });
  console.log("split:", partIds);
  await assertUnchangedRef(roRef, "{tag}");
  const saveSplit = await call("project_save", {});
  console.log("save после split:", JSON.stringify({ verified: saveSplit["verified"], rounds: saveSplit["rounds"], warnings: saveSplit["warnings"] }));
  if (!saveSplit["verified"]) throw new Error("save после split не verified");

  // 5. merge: снести обе части нижней стены и поставить одну целую (контур тот же)
  for (const pid of partIds) {
    const label = await freshLabel("walls", pid);
    if (label) await call("wall_delete", { wall_id: label });
  }
  const reAdd = await call("wall_add", {
    start: { x: Math.round(ox * 10), y: Math.round(oy * 10) },
    end: { x: Math.round((ox + w) * 10), y: Math.round(oy * 10) },
    thickness_mm: 100,
  });
  const reAddId = (reAdd as { entity?: { site_id?: string } }).entity?.site_id;
  if (!reAddId) throw new Error("wall_add (merge) не вернул site_id");
  created.push({ kind: "wall", siteId: reAddId });
  await assertUnchangedRef(roRef, "{tag}");
  const saveMerge = await call("project_save", {});
  console.log("save после merge:", JSON.stringify({ verified: saveMerge["verified"], rounds: saveMerge["rounds"], warnings: saveMerge["warnings"] }));
  if (!saveMerge["verified"]) throw new Error("save после merge не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

  // 5b. покрытие потолка + два разделителя зон (диагональ + параллельная у левого верхнего угла)
  await call("finish_ceiling_set", { room_id: roomRef, material: "gypsum_ceiling" });
  const zd1 = await call("zone_ceiling_add", {
    room_id: roomRef,
    from_mm: { x: Math.round((ox + 20) * 10), y: Math.round((oy + 5) * 10) },
    to_mm: { x: Math.round((ox + 180) * 10), y: Math.round((oy + 145) * 10) },
  });
  console.log("zd1:", JSON.stringify({ id: zd1["id"], site_id: zd1["site_id"], length_mm: zd1["length_mm"] }));
  created.push({ kind: "delimiter", siteId: String(zd1["site_id"] ?? ""), roomRef });
  const zd2 = await call("zone_ceiling_add", {
    room_id: roomRef,
    from_mm: { x: Math.round((ox + 40) * 10), y: Math.round((oy + 145) * 10) },
    to_mm: { x: Math.round((ox + 5) * 10), y: Math.round((oy + 114) * 10) },
  });
  console.log("zd2:", JSON.stringify({ id: zd2["id"], site_id: zd2["site_id"], length_mm: zd2["length_mm"] }));
  created.push({ kind: "delimiter", siteId: String(zd2["site_id"] ?? ""), roomRef });
  await assertUnchangedRef(roRef, "{tag}");
  const saved = await call("project_save", {});
  console.log("save:", JSON.stringify({ verified: saved["verified"], rounds: saved["rounds"], warnings: saved["warnings"] }));
  if (!saved["verified"]) throw new Error("save не verified");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const fin = await call("finish_get", { room_id: roomRef });
  const finArr = fin as unknown as Array<Record<string, unknown>>;
  const zd = finArr[0]?.["zone_delimiters"] as Array<Record<string, unknown>> | undefined;
  if (!zd || zd.length !== 2) throw new Error(`после reopen разделителей ${zd?.length ?? 0}, ожидалось 2`);
  console.log("после reopen: разделителей", zd.length, "потолок:", JSON.stringify(finArr[0]?.["ceiling"]));
  writeFileSync(`${OUT}/260-live-finish-get.json`, JSON.stringify(fin, null, 1));

  // 5c. перенос стены пробной комнаты: делитель должен пережить (опциональный шаг —
  // поведение фиксируем, при отказе не валим пробу)
  try {
    const topLabel = await freshLabel("walls", created.find((c) => c.kind === "wall" && c.siteId !== bottomSite && c.siteId !== reAddId)?.siteId ?? "");
    if (topLabel) {
      await call("wall_move", { wall_id: topLabel, offset_mm: 30 });
      await assertUnchangedRef(roRef, "{tag}");
      const saveMove = await call("project_save", {});
      console.log("wall_move:", JSON.stringify({ verified: saveMove["verified"], rounds: saveMove["rounds"], warnings: saveMove["warnings"] }));
      await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
      const finMove = await call("finish_get", { room_id: roomRef });
      const zdMove = ((finMove as unknown as Array<Record<string, unknown>>)[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>;
      console.log("после wall_move: разделителей", zdMove.length, zdMove.length > 0 ? "(делитель пережил перенос стены)" : "(делитель удалён редактором)");
    }
  } catch (moveErr) {
    console.log("wall_move: отказ (зафиксировано):", String((moveErr as Error).message).slice(0, 300));
  }

  // 6. восстановление (в схеме этапа — до сверки)
  const finRestore = await call("finish_get", { room_id: roomRef });
  const zdRestore = ((finRestore as unknown as Array<Record<string, unknown>>)[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>;
  for (const d of zdRestore) await call("zone_ceiling_remove", { delimiter_id: String(d["site_id"] ?? d["id"]) });
  await call("finish_ceiling_remove", { room_id: roomRef });
  const wallSites = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!);
  let left = [...wallSites];
  for (let guard = 0; guard < 40 && left.length > 0; guard++) {
    const label = await freshLabel("walls", left[0]!);
    if (!label) { left.shift(); continue; }
    await call("wall_delete", { wall_id: label });
    left.shift();
  }
  await assertUnchangedRef(roRef, "{tag}");
  const saveRes2 = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes2["verified"], rounds: saveRes2["rounds"] }));
  if (!saveRes2["verified"]) throw new Error("restore save не verified");
  created.length = 0; // восстановлено
  opened = false;

  // 7. полная семантическая сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/get-own-after-260.json`, JSON.stringify(finalModel, null, 1));

  // 8. ревью 319 №4: контрольный проект сверяется с фиксированным эталоном
  {
    const roChanged = await roGuard.checkFinal("в конце");
    if (roChanged) throw new Error("контрольный проект изменился");
  }
  console.log("260-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  await cleanup();
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
