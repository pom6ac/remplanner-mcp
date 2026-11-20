// 303: живая проверка потолочных закладных в dev-проекте (REMPLANNER_PROBE_* из env,
// схема «бэкап → запись → проверка → восстановление»): пробная комната из 4 стен
// (создаётся и удаляется по захваченным site_id; метки резолвятся из свежего
// model_get перед каждым удалением — инцидент 240), закладная, zone_ceiling с концом
// на грани закладной, update ширины, перенос/удаление стены пробной комнаты,
// restore в finally. Контрольный проект (только GET) — REMPLANNER_PROBE_READONLY_ID
// по реальному plan_id REMPLANNER_PROBE_READONLY_PLAN_ID.
// node scripts/probes/303-live-check.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, assertUnchangedRef, newGuardRef, readonlyGuard, readonlyRefPath } from "./probe-guard.ts";

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

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "303-live-check", version: "0.0.0" });
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
const snap = async (objectId: string, planId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, planId);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`${OUT}/303-get-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

const created: Array<{ kind: "wall" | "rigel" | "delimiter" | "ceiling"; siteId?: string; roomRef?: string }> = [];
let opened = false;
let before: LoadedModel | null = null;
const freshLabel = async (coll: "walls", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {});
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};

// M7 ревью 304: восстановление ТОЛЬКО по захваченным site_id (метки резолвятся
// из свежего model_get) — не по метке R<n> и не «всё в комнате»: после wall_delete
// метка R<n> может указывать на комнату пользователя. Вызывается и из основного
// потока, и из finally (раньше восстановление было только в catch).
let restored = false;
async function restoreByCaptured(): Promise<void> {
  if (restored || !opened) return;
  restored = true;
  const mg = await call("model_get", {});
  // закладные и разделители — только захваченные site_id
  const crs = (mg["ceiling_rigels"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "rigel" && x.siteId)) {
    if (!crs.some((r) => r.site_id === c.siteId)) {
      console.log(`restore: пропуск закладной ${c.siteId} — на сервере нет (уже удалена?)`);
      continue;
    }
    try { await call("ceiling_rigel_delete", { rigel_id: c.siteId! }); } catch { /* уже нет */ }
  }
  const zds = (mg["zone_delimiters"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "delimiter" && x.siteId)) {
    if (!zds.some((z) => z.site_id === c.siteId)) {
      console.log(`restore: пропуск разделителя ${c.siteId} — на сервере нет`);
      continue;
    }
    try { await call("zone_ceiling_remove", { delimiter_id: c.siteId! }); } catch { /* уже нет */ }
  }
  const mg2 = await call("model_get", {});
  const walls = (mg2["walls"] ?? []) as Array<{ id: string; site_id: string }>;
  const want = new Set(created.filter((x) => x.kind === "wall" && x.siteId).map((x) => x.siteId!));
  for (let guard = 0; guard < 40 && want.size > 0; guard++) {
    const hit = walls.find((wl) => want.has(wl.site_id));
    if (!hit) break;
    want.delete(hit.site_id);
    try { await call("wall_delete", { wall_id: hit.id }); } catch { /* уже нет */ }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  await assertUnchangedRef(roRef, "{tag}");
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"] }));
  if (!saveRes["verified"]) throw new Error("restore save не verified");
  created.length = 0; // восстановлено
  opened = false;
}

/** Семантическая сигнатура модели (как в 260): служебные поля исключены,
 *  регенерируемые id — в канонические формы; закладные — по геометрии+width. */
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
        // закладные: каноническая форма по геометрии/width/ceiling_type
        if (rec["rigels"] && typeof rec["rigels"] === "object") {
          const canon: Record<string, unknown> = {};
          for (const r of Object.values(rec["rigels"] as Record<string, Record<string, unknown>>)) {
            const p1 = r["p1"] as { x: number; y: number } | undefined;
            const p2 = r["p2"] as { x: number; y: number } | undefined;
            const key = p1 && p2
              ? `${Math.round(p1.x * 10) / 10},${Math.round(p1.y * 10) / 10};${Math.round(p2.x * 10) / 10},${Math.round(p2.y * 10) / 10}|${r["width"]}|${r["ceiling_type"]}`
              : String(r["id"] ?? "?");
            canon[key] = { width: r["width"], ceiling_type: r["ceiling_type"], polygon: (r["polygon"] as Array<{ x: number; y: number }> | undefined)?.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) };
          }
          rec["rigels"] = canon;
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
  // 0. контрольный проект до (только GET, реальный plan_id)
  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, readonlyRefPath(READONLY_ID, READONLY_PLAN_ID));
  roRef.current = roGuard;
  await roGuard.assertUnchanged("перед записями");
  const roBefore = await snap(READONLY_ID, READONLY_PLAN_ID, "readonly-before");

  // 1. бэкап dev-проекта
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-303.json`;
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
  // N2 ревью 306: plan_id в editor_status убран (публичный контракт без расширения);
  // гард «план в редакторе == серверу» — in-process из compat открытого редактора
  // (как 303-ceiling-rigel.ts:61); при ПУСТОМ plan_id — стоп (не молча)
  const editor = ctx.workspaceOrNull?.editorOrNull() ?? null;
  const compat = editor ? await editor.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) {
    throw new Error("compat.plan_id пуст — не могу сверить план редактора с сервером — стоп");
  }
  if (planInEditor !== String(PLAN_ID)) {
    throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  }
  console.log("гард «план в редакторе == серверу» (compat, in-process): OK");

  // 2. пробная комната: правее всей геометрии, 4 стены 200×150 см, толщина 100 мм
  const rawWalls = (before.model["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>;
  const maxX = Math.max(...Object.values(rawWalls).flatMap((w) => [w.p1.x, w.p2.x]));
  const ox = Math.ceil(maxX) + 300;
  const oy = 0;
  const w = 200, h = 150;
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
  console.log("пробная комната:", trialRoomId, "метка:", roomRef);
  created.push({ kind: "ceiling", roomRef });

  // 2. закладная «от стены до стены» (ось вертикально, x = ox+100)
  const rgAdd = await call("ceiling_rigel_add", {
    room_id: roomRef,
    start: { x: Math.round((ox + 100) * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round((ox + 100) * 10), y: Math.round((oy + h - 6) * 10) },
  });
  console.log("ceiling_rigel_add:", JSON.stringify({ id: rgAdd["id"], site_id: rgAdd["site_id"] }));
  const rgSite = String(rgAdd["site_id"] ?? "");
  if (!rgSite) throw new Error("ceiling_rigel_add не вернул site_id");
  created.push({ kind: "rigel", siteId: rgSite });
  await assertUnchangedRef(roRef, "{tag}");
  const saveRigel = await call("project_save", {});
  console.log("save закладной:", JSON.stringify({ verified: saveRigel["verified"], rounds: saveRigel["rounds"], warnings: saveRigel["warnings"] }));
  if (!saveRigel["verified"]) throw new Error("save закладной не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const finRigel = await call("finish_get", { room_id: roomRef });
  const finArr = finRigel as unknown as Array<Record<string, unknown>>;
  const crs = (finArr[0]?.["ceiling_rigels"] ?? []) as Array<Record<string, unknown>>;
  if (crs.length !== 1) throw new Error(`после reopen закладных ${crs.length}, ожидалась 1`);
  console.log("после reopen: закладная на месте:", JSON.stringify(crs[0]));
  writeFileSync(`${OUT}/303-live-finish-get.json`, JSON.stringify(finRigel, null, 1));

  // 3. разделитель зон потолка с концом на грани закладной (магнит 100 мм в UI,
  //    в MCP конец ставится точно на грань x = ox+105)
  const zdAdd = await call("zone_ceiling_add", {
    room_id: roomRef,
    from_mm: { x: Math.round((ox + w - 10) * 10), y: Math.round((oy + h / 2) * 10) },
    to_mm: { x: Math.round((ox + 105) * 10), y: Math.round((oy + h / 2) * 10) },
  });
  console.log("zone_ceiling_add:", JSON.stringify({ id: zdAdd["id"], site_id: zdAdd["site_id"], length_mm: zdAdd["length_mm"] }));
  created.push({ kind: "delimiter", siteId: String(zdAdd["site_id"] ?? "") });
  await assertUnchangedRef(roRef, "{tag}");
  const saveZone = await call("project_save", {});
  console.log("save зоны:", JSON.stringify({ verified: saveZone["verified"], rounds: saveZone["rounds"], warnings: saveZone["warnings"] }));
  if (!saveZone["verified"]) throw new Error("save зоны не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const finZone = await call("finish_get", { room_id: roomRef });
  const finZoneArr = finZone as unknown as Array<Record<string, unknown>>;
  const zd = (finZoneArr[0]?.["zone_delimiters"] ?? []) as Array<Record<string, unknown>>;
  const crsZone = (finZoneArr[0]?.["ceiling_rigels"] ?? []) as Array<Record<string, unknown>>;
  if (!zd || zd.length !== 1) throw new Error(`после reopen разделителей ${zd?.length ?? 0}, ожидался 1`);
  if (crsZone.length !== 1) throw new Error(`после reopen закладных ${crsZone.length}, ожидалась 1`);
  console.log("после reopen: делитель и закладная на месте");

  // 4. update ширины (контекстное меню) → save → reopen
  const upd = await call("ceiling_rigel_update", { rigel_id: crsZone[0]!["id"], width_mm: 300 });
  console.log("ceiling_rigel_update:", JSON.stringify({ width_mm: upd["width_mm"] }));
  await assertUnchangedRef(roRef, "{tag}");
  const saveUpd = await call("project_save", {});
  console.log("save update:", JSON.stringify({ verified: saveUpd["verified"], rounds: saveUpd["rounds"], warnings: saveUpd["warnings"] }));
  if (!saveUpd["verified"]) throw new Error("save update не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const finUpd = await call("finish_get", { room_id: roomRef });
  const crsUpd = (((finUpd as unknown as Array<Record<string, unknown>>)[0]?.["ceiling_rigels"] ?? []) as Array<Record<string, unknown>>);
  if (Number(crsUpd[0]?.["width_mm"]) !== 300) throw new Error(`ширина после reopen ${JSON.stringify(crsUpd[0])}, ожидалась 300`);
  console.log("после reopen: ширина 300 мм OK");

  // 5. перенос стены пробной комнаты (правая, не связана с закладной): закладная и
  //    делитель должны пережить (затронутость по грани)
  const rightSite = created.find((c) => c.kind === "wall" && c.siteId)?.siteId;
  const rightLabel = rightSite ? await freshLabel("walls", rightSite) : null;
  if (rightLabel) {
    await call("wall_move", { wall_id: rightLabel, offset_mm: 30 });
    await assertUnchangedRef(roRef, "{tag}");
    const saveMove = await call("project_save", {});
    console.log("wall_move:", JSON.stringify({ verified: saveMove["verified"], rounds: saveMove["rounds"], warnings: saveMove["warnings"] }));
    if (!saveMove["verified"]) throw new Error("save wall_move не verified");
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const finMove = await call("finish_get", { room_id: roomRef });
    const finMoveArr = finMove as unknown as Array<Record<string, unknown>>;
    console.log("после wall_move: закладных", ((finMoveArr[0]?.["ceiling_rigels"] ?? []) as unknown[]).length,
      "делителей", ((finMoveArr[0]?.["zone_delimiters"] ?? []) as unknown[]).length);
  }

  // 6. удаление стены, к которой привязана закладная (поведение редактора — фиксируем)
  const topSite = created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!)[1];
  const topLabel = topSite ? await freshLabel("walls", topSite) : null;
  if (topLabel) {
    await call("wall_delete", { wall_id: topLabel });
    try {
      await assertUnchangedRef(roRef, "{tag}");
      const saveDel = await call("project_save", {});
      console.log("save wall_delete:", JSON.stringify({ verified: saveDel["verified"], rounds: saveDel["rounds"], warnings: saveDel["warnings"] }));
      await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
      const finDel = await call("finish_get", { room_id: roomRef });
      const finDelArr = finDel as unknown as Array<Record<string, unknown>>;
      console.log("после wall_delete: закладных", ((finDelArr[0]?.["ceiling_rigels"] ?? []) as unknown[]).length,
        "делителей", ((finDelArr[0]?.["zone_delimiters"] ?? []) as unknown[]).length);
    } catch (delErr) {
      console.log("wall_delete save: отказ (зафиксировано):", String((delErr as Error).message).slice(0, 400));
    }
  }

  // 7. восстановление — ТОЛЬКО по захваченным site_id (M7 ревью 304)
  await restoreByCaptured();

  // 8. полная семантическая сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/303-get-own-after.json`, JSON.stringify(finalModel, null, 1));

  // 9. render PNG
  const png = await call("render_plan", {});
  console.log("render_plan:", JSON.stringify(Object.keys(png)).slice(0, 200));

  // 10. контрольный проект после — ревью 319 №4: с фиксированным эталоном (канон + save_id)
  const roOk = !(await roGuard.checkFinal("в конце"));
  console.log("контрольный проект:", roOk ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
  if (!roOk) throw new Error("контрольный проект изменился");
  if (!same) throw new Error("dev-проект не совпал с бэкапом");
  console.log("303-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 900));
  process.exitCode = 1;
} finally {
  // M7 ревью 304: восстановление в finally (раньше — только в catch; аварийная
  // ветка не удаляла закладную и делитель по ID) — и по захваченным site_id
  try {
    await restoreByCaptured();
  } catch (ce) {
    console.error("RESTORE FAIL:", String((ce as Error).message ?? ce).slice(0, 400));
    process.exitCode = 1;
  }
  // N5 ревью 306: на аварийном пути после restore — семантическая сверка с бэкапом;
  // расхождение после восстановления — громкая ошибка (exitCode 1), не молчание
  if (before) {
    try {
      const final = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
      const same = sig(final.model) === sig(before.model);
      if (same) console.log("finally: семантическая сверка с бэкапом — OK");
      else {
        console.error("РАСХОЖДЕНИЕ после restore: модель не совпала с бэкапом — требуется ручной разбор");
        process.exitCode = 1;
      }
    } catch (ve) {
      console.error("VERIFY FAIL:", String((ve as Error).message ?? ve).slice(0, 400));
      process.exitCode = 1;
    }
  }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
