// 310 (a, m11 ревью 304): живой цикл отделки потолка с закладными в dev-проекте
// (REMPLANNER_PROBE_* из env, схема «бэкап → запись → проверка → восстановление»):
// пробная комната с ИМЕНЕМ и покрытием потолка → ceiling_rigel_add (закладная делит
// потолок на зоны: updateZones("ceiling"), ребро rigel_ceiling) → zone_ceiling-делитель
// с концом на грани закладной → save verified → reopen → сверка отделки ВСЕХ ceilings
// комнаты и имени → ceiling_rigel_update → save → reopen → сверка → ceiling_rigel_delete
// → save → reopen → сверка. Эталон — то же действие руками через UI-обработчики
// редактора (serialize ДО delete, как в #cm-ceiling-rigel--remove). Гарды (ревью 285 №3):
// ID только из env, OBJECT_ID != READONLY_ID, план в редакторе == серверу, контрольный
// GET по реальному plan_id (непустой) до/после — канон + save_id, finally с browser.close
// и восстановлением по захваченным site_id. node scripts/probes/310-m11-live.ts run
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

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
if (OBJECT_ID === READONLY_ID) {
  console.error("REMPLANNER_PROBE_OBJECT_ID совпадает с READONLY_ID — стоп");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(90); }, 14 * 60_000).unref();

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "310-m11-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 5000)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const snap = async (objectId: string, planId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, planId);
  if (m.data_empty) throw new Error(`контрольный GET ${tag} пустой (data_empty) — отказ`);
  writeFileSync(`${OUT}/310-get-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

let created: Array<{ kind: "wall" | "rigel" | "delimiter" | "ceiling"; siteId?: string; roomRef?: string }> = [];
let opened = false;
let before: LoadedModel | null = null;
const freshLabel = async (coll: "walls", siteId: string): Promise<string | null> => {
  const mg = await call("model_get", {});
  const list = (mg[coll] ?? []) as Array<{ id: string; site_id: string }>;
  return list.find((w) => w.site_id === siteId)?.id ?? null;
};

let restored = false;
async function restoreByCaptured(): Promise<void> {
  if (restored || !opened) return;
  restored = true;
  // отделка пробной комнаты блокирует wall_delete (потеря покрытия в исчезающей
  // комнате — находка 310) — снимаем её перед удалением стен
  const roomRefCap = created.find((c) => c.kind === "ceiling")?.roomRef;
  if (roomRefCap) {
    try { await call("finish_ceiling_remove", { room_id: roomRefCap }); } catch { /* уже снята */ }
    try { await call("project_save", {}); } catch { /* продолжаем зачистку */ }
  }
  const mg = await call("model_get", {});
  const crs = (mg["ceiling_rigels"] ?? []) as Array<{ id?: string; site_id?: string }>;
  for (const c of created.filter((x) => x.kind === "rigel" && x.siteId)) {
    if (!crs.some((r) => r.site_id === c.siteId)) {
      console.log(`restore: пропуск закладной ${c.siteId} — на сервере нет`);
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
    try { await call("wall_delete", { wall_id: hit.id }); } catch (e) { console.log(`restore: wall_delete ${hit.id}:`, String((e as Error).message).slice(0, 300)); }
    const fresh = await call("model_get", {});
    const fw = (fresh["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    walls.length = 0;
    walls.push(...fw);
  }
  const saveRes = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"] }));
  if (!saveRes["verified"]) throw new Error("restore save не verified");
  created.length = 0;
  opened = false;
}

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
          // производные (перестраиваются редактором при каждом save: полигоны/рёбра
          // зон, precision, edges_ceiling) — в каноническую форму: exist + отделка
          rec["ceilings"] = (rec["ceilings"] as Array<Record<string, unknown>>)
            .map((ce) => ({
              exist: ce["exist"],
              material: ce["material"] ?? null,
              level: ce["level"] ?? null,
              profile: ce["profile"] ?? null,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        // edges_ceiling / demolines_ceiling_moldings — производные демолайны
        // потолочного плинтуса, перестраиваются при каждом пересчёте комнат
        for (const dk of ["edges_ceiling", "demolines_ceiling_moldings"]) {
          delete rec[dk];
        }
        // moldings: состав exist:true частей (длина массива следует за рёбрами комнаты)
        for (const mk of ["floorMoldings", "ceilingMoldings"]) {
          if (Array.isArray(rec[mk])) {
            const parts: string[] = [];
            for (const side of rec[mk] as Array<Record<string, unknown>>) {
              const p = (side?.["parts"] ?? {}) as Record<string, Record<string, unknown>>;
              for (const q of Object.values(p)) parts.push(JSON.stringify(q, Object.keys(q).sort()));
            }
            rec[mk] = parts.sort();
          }
        }
        // зоны (plan c): пользовательское — имя/микро; полигоны/рёбра — производные
        if (Array.isArray(rec["zones"])) {
          rec["zones"] = (rec["zones"] as Array<Record<string, unknown>>)
            .map((z) => ({ name: z["name"] ?? null, micro: Boolean(z["is_micro_zone"]), area: typeof z["area"] === "number" ? Math.round(z["area"] * 10) / 10 : null }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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

/** Отделка ВСЕХ потолков комнаты + имя (m11): мультимножество {material, level, profile}
 *  по записям exist===true; имя — rooms2[rid].name и zones[*].name. */
type CeilState = { name: string | null; zoneNames: string[]; ceils: string[]; rigels: number; delims: number };
const roomStateOf = (model: Record<string, unknown>, findTrial: (room: Record<string, unknown>) => boolean): CeilState | null => {
  const rooms = (model["rooms2"] ?? {}) as Record<string, Record<string, unknown>>;
  const hit = Object.entries(rooms).find(([, r]) => findTrial(r));
  if (!hit) return null;
  const r = hit[1]!;
  const ceils = (Array.isArray(r["ceilings"]) ? r["ceilings"] : []) as Array<Record<string, unknown>>;
  const zones = (Array.isArray(r["zones"]) ? r["zones"] : []) as Array<Record<string, unknown>>;
  return {
    name: typeof r["name"] === "string" ? r["name"] : null,
    zoneNames: zones.map((z) => String(z["name"] ?? "")).sort(),
    ceils: ceils
      .filter((c) => c["exist"] === true && typeof c["material"] === "string")
      .map((c) => JSON.stringify({ material: c["material"], level: c["level"] ?? 0, profile: c["profile"] ?? "" }))
      .sort(),
    rigels: Object.keys((r["rigels"] ?? {}) as Record<string, unknown>).length,
    delims: Object.keys((r["delimiters"] ?? {}) as Record<string, unknown>).length,
  } as CeilState;
};
const cmpState = (label: string, exp: CeilState | null, got: CeilState | null): boolean => {
  if (!exp || !got) { console.log(`${label}: состояние не снято`); return false; }
  const parts: string[] = [];
  if (exp.name !== got.name) parts.push(`name ${JSON.stringify(exp.name)} → ${JSON.stringify(got.name)}`);
  if (JSON.stringify(exp.ceils) !== JSON.stringify(got.ceils)) parts.push(`ceilings ${exp.ceils.join("|")} → ${got.ceils.join("|")}`);
  if (exp.rigels !== got.rigels) parts.push(`rigels ${exp.rigels} → ${got.rigels}`);
  if (exp.delims !== got.delims) parts.push(`delims ${exp.delims} → ${got.delims}`);
  if (parts.length === 0) { console.log(`${label}: OK (${got.ceils.length} потолочных зон, имя ${JSON.stringify(got.name)})`); return true; }
  console.log(`${label}: РАСХОЖДЕНИЕ — ${parts.join("; ")}`);
  return false;
};

let trialFinder: ((room: Record<string, unknown>) => boolean) | null = null;

try {
  // 0. контрольный проект до (только GET, реальный plan_id)
  const roBefore = await snap(READONLY_ID, READONLY_PLAN_ID, "readonly-before");

  // 1. бэкап dev-проекта (имя из задания: backup-<OBJECT_ID>-310.json)
  before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-310.json`;
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
  // редактор создаётся лениво (первая нормализация/рендер) — render_plan запускает
  // его без изменения модели, после чего гард снимается из compat
  await call("render_plan", {});
  const editor = (ctx.workspaceOrNull?.editorOrNull() ?? null) as unknown as { page?: import("playwright-core").Page; compatInfo(): Promise<{ plan_id?: unknown }> } | null;
  const compat = editor ? await editor.compatInfo() : null;
  const planInEditor = compat?.plan_id == null ? "" : String(compat.plan_id);
  if (!planInEditor) throw new Error("compat.plan_id пуст — стоп");
  if (planInEditor !== String(PLAN_ID)) throw new Error(`план в редакторе ${planInEditor} != серверу ${PLAN_ID}`);
  console.log("гард «план в редакторе == серверу» (compat, in-process): OK");

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
  trialFinder = (room) => {
    const p = (room["polygon"] ?? []) as Array<{ x: number; y: number }>;
    return p.length >= 3 && p.every((q) => q.x >= ox - 1 && q.x <= ox + w + 1);
  };
  const stateOf = async (): Promise<CeilState | null> => {
    const m = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    writeFileSync(`${OUT}/310-state-last.json`, JSON.stringify(m.model, null, 1));
    if (!trialFinder) return null;
    const st = roomStateOf(m.model as Record<string, unknown>, trialFinder);
    if (st) {
      // делители — верхнеуровневое zone_delimiters (per-room delimiters — legacy)
      const zd = (m.model as Record<string, unknown>)["zone_delimiters"] as Record<string, { id_room?: string }> | undefined;
      st.delims = Object.values(zd ?? {}).filter((d) => d?.id_room === trialRoomId).length;
    }
    return st;
  };

  // 3. имя комнаты (как UI: name комнаты + зоны; проба 43) — через редактор
  const page = editor?.page ?? null;
  if (!page) throw new Error("страница редактора недоступна");
  const nameSet = await page.evaluate(async (rid) => {
    const w: any = window as any;
    const rr: any = w.ROOMS2?.[rid];
    if (!rr) return { ok: false };
    rr.name = "Проб 310";
    if (Array.isArray(rr.zones) && rr.zones[0]) rr.zones[0].name = "Проб 310";
    // как руками: сохранить страницу (project.save), затем перечитать сервер
    const ret = await Promise.race([
      Promise.resolve(w.project.save(false, true)).then((r: unknown) => String(r).slice(0, 80)),
      new Promise((res) => setTimeout(() => res("timeout"), 8000)),
    ]);
    return { ok: true, save: ret };
  }, trialRoomId);
  console.log("имя комнаты:", JSON.stringify(nameSet));
  await new Promise((r) => setTimeout(r, 2500));
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const roomsNamed = ((await loadModel(ctx.session(), OBJECT_ID, PLAN_ID)).model["rooms2"] ?? {}) as Record<string, { polygon?: Array<{ x: number; y: number }>; name?: unknown }>;
  const namedEntry = Object.entries(roomsNamed).find(([rid, r]) => rid === trialRoomId || (r.polygon ?? []).every((q) => q.x >= ox - 1 && q.x <= ox + w + 1));
  if (!namedEntry) throw new Error("пробная комната пропала после сохранения имени");
  const roomRef2 = `R${Object.keys(roomsNamed).indexOf(namedEntry[0]!) + 1}`;
  console.log("комната после имени:", namedEntry[0], "метка:", roomRef2, "name:", JSON.stringify(namedEntry[1]!.name));

  // 4. покрытие потолка (MCP-инструмент, проверен ранее) → save → reopen
  await call("finish_ceiling_set", { room_id: roomRef2, material: "gypsum_ceiling", profile: "standard" });
  const saveFin = await call("project_save", {});
  console.log("save отделки:", JSON.stringify({ verified: saveFin["verified"], rounds: saveFin["rounds"] }));
  if (!saveFin["verified"]) throw new Error("save отделки не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const s0 = await stateOf();
  if (!s0) throw new Error("состояние S0 не снято");
  console.log("S0 (имя + отделка):", JSON.stringify(s0));
  if (s0.name !== "Проб 310") throw new Error(`имя после reopen ${JSON.stringify(s0.name)} — стоп`);
  if (s0.ceils.length !== 1) throw new Error(`потолочных зон в S0 ${s0.ceils.length}, ожидалась 1`);

  // 5. закладная (MCP) → validate → save БЕЗ NORMALIZATION_DROPPED (перепроверка 305/307)
  await call("model_validate", {});
  const rgAdd = await call("ceiling_rigel_add", {
    room_id: roomRef2,
    start: { x: Math.round((ox + 110) * 10), y: Math.round((oy + 6) * 10) },
    end: { x: Math.round((ox + 110) * 10), y: Math.round((oy + h - 6) * 10) },
  });
  console.log("ceiling_rigel_add:", JSON.stringify({ id: rgAdd["id"], site_id: rgAdd["site_id"] }));
  const rgSite = String(rgAdd["site_id"] ?? "");
  if (!rgSite) throw new Error("ceiling_rigel_add не вернул site_id");
  created.push({ kind: "rigel", siteId: rgSite });
  const saveRigel = await call("project_save", {});
  console.log("save закладной:", JSON.stringify({ verified: saveRigel["verified"], rounds: saveRigel["rounds"], warnings: saveRigel["warnings"] }));
  if (!saveRigel["verified"]) throw new Error("save закладной не verified (NORMALIZATION_DROPPED?)");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const s1 = await stateOf();
  console.log("S1 (после закладной):", JSON.stringify(s1));
  if (!s1 || s1.rigels !== 1) throw new Error("закладная не дожила до reopen");
  if (JSON.stringify(s1.ceils) !== JSON.stringify(s0.ceils)) throw new Error(`отделка потолка изменилась после закладной: ${s0.ceils.join("|")} → ${s1.ceils.join("|")}`);
  if (s1.name !== s0.name) throw new Error(`имя изменилось после закладной: ${JSON.stringify(s0.name)} → ${JSON.stringify(s1.name)}`);

  // 5б. делитель зон потолка с концом на грани закладной (ширина 100 мм → грань на 50 мм от оси)
  const zdAdd = await call("zone_ceiling_add", {
    room_id: roomRef2,
    from_mm: { x: Math.round((ox + w - 10) * 10), y: Math.round((oy + h / 2) * 10) },
    to_mm: { x: Math.round((ox + 115) * 10), y: Math.round((oy + h / 2) * 10) },
  });
  console.log("zone_ceiling_add:", JSON.stringify({ id: zdAdd["id"], site_id: zdAdd["site_id"], length_mm: zdAdd["length_mm"] }));
  created.push({ kind: "delimiter", siteId: String(zdAdd["site_id"] ?? "") });
  const saveZone = await call("project_save", {});
  console.log("save зоны:", JSON.stringify({ verified: saveZone["verified"], rounds: saveZone["rounds"], warnings: saveZone["warnings"] }));
  if (!saveZone["verified"]) throw new Error("save зоны не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const s1z = await stateOf();
  console.log("S1z (после делителя):", JSON.stringify(s1z));
  if (!s1z || s1z.delims !== 1) throw new Error("делитель не дожил до reopen");
  if (JSON.stringify(s1z.ceils) !== JSON.stringify(s1.ceils)) throw new Error(`отделка изменилась после делителя: ${s1.ceils.join("|")} → ${s1z.ceils.join("|")}`);
  // живой эталон для фикстуры: комната с закладной, делителем и зонами потолка
  {
    const mZ = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
    writeFileSync(`${OUT}/310-state-rigel-delimiter.json`, JSON.stringify(mZ.model, null, 1));
  }

  // 5в. update ширины при делителе с концом на грани закладной — консервативный
  // отказ MCP (этап 310): save-пайплайн редактора теряет отделку зон в этом
  // сочетании; в редакторе делитель проводится заново под новую ширину
  let refused = "";
  try {
    await call("ceiling_rigel_update", { rigel_id: rgSite, width_mm: 300 });
    console.log("ceiling_rigel_update при делителе: ПРОШЁЛ (ожидался отказ) — зафиксировано");
  } catch (e) {
    refused = String((e as Error).message);
    console.log("ceiling_rigel_update при делителе — отказ (ожидаемо):", refused.slice(0, 300).replace(/\n/g, " "));
  }
  if (!refused) throw new Error("ожидался отказ update при делителе с концом на грани закладной");

  // 5г. делитель снимается (подсказка отказа), ширина меняется уже без него
  const zdDel = await call("zone_ceiling_remove", { delimiter_id: String(zdAdd["site_id"]) });
  console.log("zone_ceiling_remove:", JSON.stringify(zdDel).slice(0, 160));
  const saveZd = await call("project_save", {});
  console.log("save снятия делителя:", JSON.stringify({ verified: saveZd["verified"], rounds: saveZd["rounds"] }));
  if (!saveZd["verified"]) throw new Error("save снятия делителя не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  created = created.filter((c) => c.siteId !== String(zdAdd["site_id"]));

  // 6. ЭТАЛОН update руками (UI-обработчик ширины: serialize ДО, restoreCeilingsAfterChangeRigel).
  // Класс-экземпляры закладных появляются при отрисовке листа «Потолки» (drawCeilings)
  const toCeilingSheet = async (): Promise<void> => {
    await page.evaluate(() => {
      const el: any = document.querySelector(".groups_navi_item.plan_ceiling") ??
        Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_ceiling"));
      if (el) el.click();
    });
    await page.waitForTimeout(2500);
  };
  await toCeilingSheet();
  const eUpd = await page.evaluate((rid) => {
    const w: any = window as any;
    const rr: any = w.ROOMS2?.[rid];
    const rgId: string = Object.keys(rr.rigels)[0] as string;
    const e = rr.serialize();
    const rg: any = rr.rigels[rgId];
    rg.width = 30;
    rg.draw();
    rr.draw();
    rr.restorer.restoreCeilingsAfterChangeRigel(e);
    const m: any = w.project.copy("server").rooms2[rid];
    return {
      ceils: (m.ceilings ?? []).filter((c: any) => c.exist === true && typeof c.material === "string")
        .map((c: any) => JSON.stringify({ material: c.material, level: c.level ?? 0, profile: c.profile ?? "" })).sort(),
      name: m.name ?? null,
    };
  }, trialRoomId);
  console.log("эталон update (UI):", JSON.stringify(eUpd));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // 7. MCP update ширины → save → reopen → сверка всех ceilings и имени с эталоном
  const upd = await call("ceiling_rigel_update", { rigel_id: rgSite, width_mm: 300 });
  console.log("ceiling_rigel_update:", JSON.stringify({ width_mm: upd["width_mm"] }));
  const saveUpd = await call("project_save", {});
  console.log("save update:", JSON.stringify({ verified: saveUpd["verified"], rounds: saveUpd["rounds"], warnings: saveUpd["warnings"] }));
  if (!saveUpd["verified"]) throw new Error("save update не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const s2 = await stateOf();
  console.log("S2 (после update):", JSON.stringify(s2));
  if (!s2cmp("MCP update vs UI-эталон", eUpd, s2)) throw new Error("update: MCP расходится с редактором");

  // 8. ЭТАЛОН delete руками (UI-обработчик #cm-ceiling-rigel--remove: serialize ДО delete)
  await toCeilingSheet();
  const eDel = await page.evaluate((rid) => {
    const w: any = window as any;
    const rr: any = w.ROOMS2?.[rid];
    const rgId: string = Object.keys(rr.rigels)[0] as string;
    const e = rr.serialize();
    rr.rigels[rgId].delete();
    rr.draw();
    rr.restorer.restoreCeilingsAfterChangeRigel(e);
    const m: any = w.project.copy("server").rooms2[rid];
    return {
      ceils: (m.ceilings ?? []).filter((c: any) => c.exist === true && typeof c.material === "string")
        .map((c: any) => JSON.stringify({ material: c.material, level: c.level ?? 0, profile: c.profile ?? "" })).sort(),
      name: m.name ?? null,
      rigels: Object.keys(m.rigels ?? {}).length,
    };
  }, trialRoomId);
  console.log("эталон delete (UI):", JSON.stringify(eDel));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // 9. MCP delete → save → reopen → сверка с эталоном (делитель остаётся — стандарт)
  const delRes = await call("ceiling_rigel_delete", { rigel_id: rgSite });
  console.log("ceiling_rigel_delete:", JSON.stringify(delRes).slice(0, 200));
  const saveDel = await call("project_save", {});
  console.log("save delete:", JSON.stringify({ verified: saveDel["verified"], rounds: saveDel["rounds"], warnings: saveDel["warnings"] }));
  if (!saveDel["verified"]) throw new Error("save delete не verified");
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const sDel = await stateOf();
  console.log("S3 (после delete):", JSON.stringify(sDel));
  {
    const got = sDel;
    const parts: string[] = [];
    if (!got) throw new Error("состояние после delete не снято");
    if (eDel.name !== got.name) parts.push(`name ${JSON.stringify(eDel.name)} → ${JSON.stringify(got.name)}`);
    if (JSON.stringify(eDel.ceils) !== JSON.stringify(got.ceils)) parts.push(`ceilings ${eDel.ceils.join("|")} → ${got.ceils.join("|")}`);
    if (got.rigels !== 0) parts.push(`rigels ${got.rigels}`);
    if (parts.length) throw new Error(`delete: MCP расходится с редактором — ${parts.join("; ")}`);
    console.log("MCP delete vs UI-эталон: OK");
  }

  // 10. восстановление по захваченным site_id
  await restoreByCaptured();

  // 11. полная семантическая сверка data с бэкапом
  const finalModel = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(finalModel.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/310-get-own-after.json`, JSON.stringify(finalModel, null, 1));

  // 12. render PNG (страницу возвращаем на общий чертёж — эталонные шаги водили
  // по листу «Потолки»; одна повторная попытка)
  if (page) {
    await page.evaluate(() => {
      const el: any = document.querySelector(".groups_navi_item.plan_init") ??
        Array.from(document.querySelectorAll(".groups_navi_item")).find((e: any) => String(e.className).includes("plan_init"));
      if (el) el.click();
    });
    await page.waitForTimeout(2500);
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  let png: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      png = await call("render_plan", {});
      break;
    } catch (e) {
      if (attempt === 1) throw e;
      console.log("render_plan попытка 1:", String((e as Error).message).slice(0, 120) + " — повтор");
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  console.log("render_plan:", JSON.stringify(Object.keys(png ?? {})).slice(0, 200));

  // 13. контрольный проект после
  const roAfter = await snap(READONLY_ID, READONLY_PLAN_ID, "readonly-after");
  const roOk = sig(roAfter.model) === sig(roBefore.model) && roAfter.save_id === roBefore.save_id;
  console.log("контрольный проект:", roOk ? "не изменился (канон + save_id)" : "ИЗМЕНИЛСЯ — СТОП");
  if (!roOk) throw new Error("контрольный проект изменился");
  if (!same) throw new Error("dev-проект не совпал с бэкапом");
  console.log("310-m11-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 6000));
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
        writeFileSync(`${OUT}/310-get-own-after.json`, JSON.stringify(final, null, 1));
        console.error("РАСХОЖДЕНИЕ после restore: модель не совпала с бэкапом — требуется ручной разбор (дамп в 310-get-own-after.json)");
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

function s2cmp(label: string, exp: { ceils: string[]; name: string | null }, got: CeilState | null): boolean {
  const parts: string[] = [];
  if (!got) { console.log(`${label}: состояние не снято`); return false; }
  if (exp.name !== got.name) parts.push(`name ${JSON.stringify(exp.name)} → ${JSON.stringify(got.name)}`);
  if (JSON.stringify(exp.ceils) !== JSON.stringify(got.ceils)) parts.push(`ceilings ${exp.ceils.join("|")} → ${got.ceils.join("|")}`);
  if (parts.length === 0) { console.log(`${label}: OK (${got.ceils.length} потолочных зон)`); return true; }
  console.log(`${label}: РАСХОЖДЕНИЕ — ${parts.join("; ")}`);
  return false;
}
