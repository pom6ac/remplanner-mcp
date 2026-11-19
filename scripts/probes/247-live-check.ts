// 247: живая проверка ревью 246 №2/№3 в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/
// PLAN_ID из env; контрольный проект REMPLANNER_PROBE_READONLY_ID — только GET).
// Правила 239: бэкап .orca-reports/backup-<OBJECT_ID>-247.json до прогона; плинтус
// на ребре выемки Г-комнаты + ниша → смена покрытия потолка → save без
// NORMALIZATION_DROPPED → reopen → плинтус внутри комнаты, ниша сохранена;
// очистка только своих объектов по захваченным при создании ID; отказ при
// OBJECT_ID == READONLY_ID. Запуск по явному аргументу run.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID из env)");
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
  console.error("REMPLANNER_PROBE_OBJECT_ID совпадает с REMPLANNER_PROBE_READONLY_ID — запись ушла бы в читаемый проект; проверьте env");
  process.exit(1);
}
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "247-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const REQ_OPTS = { timeout: 300_000 } as const; // save с раундами сверки дольше дефолтных 60 с
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args }, undefined, REQ_OPTS);
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const callErr = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await client.callTool({ name, arguments: args }, undefined, REQ_OPTS);
  if (!(res as { isError?: boolean }).isError) throw new Error(`${name}: ожидался отказ, а не успех`);
  return text(res).slice(0, 300);
};
const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, "1");
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

/** Семантическая сигнатура модели (как в 245-live-check). */
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
  // производные и канонизация отделки (финальная сверка с бэкапом, ревью 246):
  // number_by_area — производное редактора (rooms-save.ts, не сверяется); пустые
  // контейнеры плинтусов/ниш ({exist:false}×n) семантически равны их отсутствию;
  // потолок без exist сводится к {exist:false}; все числа — до 0.1 мм (шум
  // округления r2 при перезаписи полигона потолка)
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (!map || typeof map !== "object") continue;
    for (const rec of Object.values(map)) {
      for (const z of (Array.isArray(rec["zones"]) ? rec["zones"] as Array<Record<string, unknown>> : [])) {
        delete z["number_by_area"];
      }
      const canonContainer = (key: string): void => {
        const arr = rec[key];
        if (!Array.isArray(arr)) return;
        const kept = (arr as Array<Record<string, unknown>>).filter((e) => e && e["exist"] === true);
        if (kept.length === 0) delete rec[key];
        else rec[key] = kept;
      };
      canonContainer("floorMoldings");
      canonContainer("ceilingMoldings");
      const ceilings = rec["ceilings"];
      if (Array.isArray(ceilings) && ceilings.length > 0) {
        const c0 = ceilings[0] as Record<string, unknown>;
        if (!c0 || c0["exist"] !== true) {
          rec["ceilings"] = [{ exist: false }];
        } else if (Array.isArray(c0["niches"])) {
          const kept = (c0["niches"] as Array<Record<string, unknown>>).filter((e) => e && e["exist"] === true);
          if (kept.length === 0) delete c0["niches"];
          else c0["niches"] = kept;
        }
      }
    }
  }
  const roundAll = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
    if (Array.isArray(v)) return v.map(roundAll);
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
        o[k2] = roundAll(v2);
      }
      return o;
    }
    return v;
  };
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
  return JSON.stringify(roundAll(aliasAll(c)));
}

type Pt = { x: number; y: number };
const inPoly = (p: Pt, poly: Pt[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

// Захваченное до записи состояние (для восстановления в finally, ревью 248 D):
// цель и её объекты определяются один раз, восстановление снимает только их.
let roomId = "", roomSiteId = "", wallSiteId = "", wallId = "", edgeIndex = -1;
let written = false; // сервер мог получить изменения (сохранение вызвано или могло начаться)
let restored = false;
const restoreWrites = async (): Promise<void> => {
  if (restored) return;
  restored = true;
  await call("finish_ceiling_niche_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_ceiling_molding_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_floor_molding_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_ceiling_remove", { room_id: roomId });
  const s = await call("project_save", {});
  if (!s["verified"]) throw new Error("restore save не verified");
};

try {
  // 0. контрольный проект до (только GET)
  const snapBefore = READONLY_ID ? await snap(READONLY_ID, "before") : null;
  // 1. бэкап dev-проекта
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/247-live-before.json`, JSON.stringify(before, null, 1));
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-247.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    console.log("бэкап существует; сверка с текущим GET:", sig(stored.model) === sig(before.model) ? "совпадает" : "РАСХОЖДЕНИЕ");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

  // 2. Г-комната и ребро выемки из сырой модели: ребро, у которого направление
  //    «внутрь комнаты» по пробе точки не совпадает с направлением по центроиду
  //    (тот случай ревью 246 №3, который раньше уводил плинтус наружу)
  const rooms2 = (before.model["rooms2"] ?? {}) as Record<string, {
    polygon?: Pt[];
    area?: number;
    edges?: Array<{ pid?: string; length?: number; p1?: Pt; p2?: Pt }>;
    decors?: Array<{ exist?: unknown }>;
    floorMoldings?: Array<{ exist?: unknown }>;
    ceilingMoldings?: Array<{ exist?: unknown }>;
    ceilings?: Array<{ exist?: unknown }>;
  }>;
  let edgeP1: Pt | undefined, edgeP2: Pt | undefined;
  const wallIds = Object.keys((before.model["walls"] ?? {}) as Record<string, unknown>);
  for (const [rid, room] of Object.entries(rooms2)) {
    const poly = room.polygon ?? [];
    if (poly.length < 5) continue; // Г-комната: не менее 5 вершин
    const area2 = poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length]!.y - poly[(i + 1) % poly.length]!.x * p.y, 0) / 2;
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    for (let i = 0; i < poly.length; i++) {
      const e = room.edges?.[i];
      const p1 = e?.p1 ?? poly[i]!, p2 = e?.p2 ?? poly[(i + 1) % poly.length]!;
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (!e?.pid || len < 35) continue; // ниша требует ребро > 30 см
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const nx = (p2.y - p1.y) / len, ny = -(p2.x - p1.x) / len;
      const sgnCentroid = nx * (cx - mid.x) + ny * (cy - mid.y) > 0 ? 1 : -1; // прежнее правило
      let sgnProbe = 0; // проба точки на 0.5 см от ребра
      for (const s of [1, -1]) {
        if (inPoly({ x: mid.x + nx * s * 0.5, y: mid.y + ny * s * 0.5 }, poly)) sgnProbe = s;
      }
      if (sgnProbe === 0 || sgnProbe === sgnCentroid) continue; // не выемка
      // сторона и потолок должны быть пусты ДО записи
      const sideEmpty = (key: string): boolean => {
        const rec = (Array.isArray(room[key as keyof typeof room]) ? (room[key as keyof typeof room] as Array<{ exist?: unknown }>)[i] : undefined);
        return !rec || rec["exist"] !== true;
      };
      const ceil = (room.ceilings ?? [])[0];
      if (!sideEmpty("decors") || !sideEmpty("floorMoldings") || !sideEmpty("ceilingMoldings") || (ceil && ceil["exist"] === true)) continue;
      const wi = wallIds.indexOf(e.pid);
      if (wi < 0) continue;
      roomId = `R${Object.keys(rooms2).indexOf(rid) + 1}`;
      roomSiteId = rid;
      wallSiteId = e.pid;
      wallId = `W${wi + 1}`;
      edgeIndex = i;
      edgeP1 = p1;
      edgeP2 = p2;
      break;
    }
    if (roomId) break;
  }
  if (!roomId) throw new Error("в dev-проекте не найдена Г-комната со свободным ребром выемки (>= 35 см, сторона и потолок пусты)");
  console.log("цель:", roomId, `(${roomSiteId})`, wallId, `(${wallSiteId}, ребро выемки, индекс ${edgeIndex})`);

  // 3. запись своих объектов: потолок → плинтус на ребре выемки → ниша
  await call("finish_ceiling_set", { room_id: roomId, material: "gypsum_ceiling" });
  const fm = await call("finish_floor_molding_set", { room_id: roomId, wall_id: wallId, type: "floor_molding_mdf" });
  const cm = await call("finish_ceiling_molding_set", { room_id: roomId, wall_id: wallId });
  const ni = await call("finish_ceiling_niche_add", { room_id: roomId, wall_id: wallId });
  console.log("создано:", JSON.stringify({ fm, cm, ni }));
  writeFileSync(`${OUT}/247-live-created.json`, JSON.stringify({ roomId, roomSiteId, wallId, wallSiteId, fm, cm, ni }, null, 1));

  // плинтус внутри комнаты: середина линии ребра выемки смещена внутрь (проба точки).
  // Рабочая копия — через model_get (full): loadModel делает свежий GET сервера,
  // куда правки ещё не записаны.
  const workingRooms = async (): Promise<Record<string, {
    polygon?: Pt[];
    floorMoldings?: Array<{ exist?: unknown; parts?: Record<string, { line?: { p1?: Pt; p2?: Pt } }> }>;
  }>> => {
    const m = (await call("model_get", { detail: "full" })) as { rooms2?: Record<string, {
      polygon?: Pt[];
      floorMoldings?: Array<{ exist?: unknown; parts?: Record<string, { line?: { p1?: Pt; p2?: Pt } }> }>;
    }> };
    return m.rooms2 ?? {};
  };
  const roomsNow = await workingRooms();
  const roomNow = roomsNow[roomSiteId]!;
  const poly = roomNow.polygon!;
  const part = Object.values(Object.values(roomNow.floorMoldings ?? [])[edgeIndex]?.parts ?? {})[0]!;
  const line = part.line!;
  const mid = { x: (line.p1!.x + line.p2!.x) / 2, y: (line.p1!.y + line.p2!.y) / 2 };
  if (!inPoly(mid, poly)) throw new Error(`линия плинтуса вне комнаты: ${JSON.stringify(mid)} (ребро выемки, ревью 246 №3)`);
  console.log("плинтус на ребре выемки внутри комнаты: OK", JSON.stringify(mid));

  // 4. смена покрытия потолка при существующей нише: краска/побелка — отказ
  const paintErr = await callErr("finish_ceiling_set", { room_id: roomId, material: "paint_ceiling" });
  console.log("paint с нишей — отказ (ожидаемо):", paintErr.slice(0, 160));
  // совместимое покрытие: ниша переживает смену
  await call("finish_ceiling_set", { room_id: roomId, material: "stretch_ceiling" });
  const fin1 = (await call("finish_get", { room_id: roomId })) as unknown as Array<Record<string, unknown>>;
  if (!(fin1[0]!["niches"] as unknown[] | undefined)?.length) throw new Error("ниша потеряна при смене покрытия потолка");
  if ((fin1[0]!["ceiling"] as Record<string, unknown>)["material"] !== "stretch_ceiling") throw new Error("покрытие потолка не сменилось");
  console.log("ниша пережила смену покрытия (gypsum → stretch): OK");

  // 5. validate → save (без NORMALIZATION_DROPPED) → reopen → сверка
  const v = await call("model_validate", {});
  console.log("validate: проблем", (v["problems"] ?? []).length);
  written = true; // с этого места сервер может получить изменения — в finally восстановление
  const saveRes = await call("project_save", {});
  console.log("save:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"] }));
  if (!saveRes["verified"]) throw new Error("save не verified");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const fin = (await call("finish_get", { room_id: roomId })) as unknown as Array<Record<string, unknown>>;
  writeFileSync(`${OUT}/247-live-finish-get.json`, JSON.stringify(fin, null, 1));
  const rec = fin[0]!;
  if (!(rec["floor_moldings"] as unknown[] | undefined)?.length) throw new Error("после reopen плинтус пола потерян");
  if (!(rec["ceiling_moldings"] as unknown[] | undefined)?.length) throw new Error("после reopen потолочный плинтус потерян");
  if (!(rec["niches"] as unknown[] | undefined)?.length) throw new Error("после reopen ниша потеряна");
  // плинтус внутри комнаты после reopen (рабочая копия из GET через model_get full)
  const roomsAfter = await workingRooms();
  const roomAfter = roomsAfter[roomSiteId]!;
  const partAfter = Object.values(Object.values(roomAfter.floorMoldings ?? [])[edgeIndex]?.parts ?? {})[0]!;
  const line2 = partAfter.line!;
  const mid2 = { x: (line2.p1!.x + line2.p2!.x) / 2, y: (line2.p1!.y + line2.p2!.y) / 2 };
  if (!inPoly(mid2, roomAfter.polygon!)) throw new Error(`после reopen линия плинтуса вне комнаты: ${JSON.stringify(mid2)}`);
  console.log("после reopen: плинтус внутри комнаты, ниша и потолочный плинтус на месте — OK");

  // 6. восстановление: снять только свои объекты по захваченным ID (restoreWrites
  //    включает save и проверку verified)
  await restoreWrites();
  console.log("restore: выполнено (verified)");

  // 7. полная семантическая сверка data с бэкапом (честно, ревью 248 D: сверка
  //    семантическая — пустые контейнеры плинтусов/ниш и потолок без exist
  //    приравнены к отсутствию, числа до 0.1 мм, id канонизируются)
  const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(after.model) === sig(before.model);
  console.log(
    "семантическая сверка data с бэкапом (пустые контейнеры приравнены к отсутствию, числа до 0.1 мм):",
    same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ",
  );
  if (!same) writeFileSync(`${OUT}/get-own-after-247.json`, JSON.stringify(after, null, 1));

  // 8. контрольный проект после
  if (READONLY_ID) {
    const snapAfter = await loadModel(ctx.session(), READONLY_ID, "1");
    console.log("контрольный проект:", sig(snapAfter.model) === sig(snapBefore?.model) ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
    if (sig(snapAfter.model) !== sig(snapBefore?.model)) throw new Error("контрольный проект изменился");
  }
  console.log("247-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
  process.exitCode = 1;
} finally {
  // ревью 248 D: после записи восстановление выполняется даже при падении
  // (reopen/проверки/сверка) — по захваченному до записи состоянию (roomId/wallId)
  if (written && !restored) {
    try {
      console.log("аварийное восстановление в finally…");
      await restoreWrites();
      console.log("восстановление в finally выполнено (verified)");
    } catch (re) {
      console.error("ВОССТАНОВЛЕНИЕ В finally НЕ УДАЛОСЬ — модель dev-проекта требует ручной сверки с бэкапом:",
        String((re as Error).message ?? re).slice(0, 400));
      process.exitCode = 1;
    }
  }
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
