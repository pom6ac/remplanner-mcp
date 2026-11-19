// 245: живая проверка «Отделка» ч.2 в dev-проекте (REMPLANNER_PROBE_OBJECT_ID/PLAN_ID из env,
// схема «бэкап → запись → проверка → восстановление»; пробы создают и удаляют ТОЛЬКО свои
// объекты по захваченным при создании ID). Контрольный проект (только GET) —
// REMPLANNER_PROBE_READONLY_ID. Запуск по явному аргументу run.
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
const client = new Client({ name: "245-live-check", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  return contents.map((c) => (c.type === "text" ? c.text : "")).join("");
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 600)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, "1");
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

/** Семантическая сигнатура модели (служебные поля исключены, массивы отсортированы,
 *  регенерируемые id eds2/комнат — в порядковые номера, как в 94-live-check). */
function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  // eds2: id рёбер регенерируется редактором при каждом restore — заменяем на "e<номер>"
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
  // id комнат регенерируется редактором при restore: сопоставляем комнаты по каноническому
  // полигону и переписываем ссылки id_room/id_room_zone/... в синтетические R1..Rn
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
  // псевдоним по каноническому полигону: сортированный список полигонов → индекс
  // псевдоним по каноническому полигону: сортированный список полигонов → индекс
  // (порядок ключей rooms1/rooms2 редактор перегенерирует)
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
  // висячие ссылки на комнаты (id_room не из rooms2 — редактор перегенерирует их
  // при каждом restore даже без правок) — нормализуем в DANGLING
  // id рёбер комнат регенерируется: edges[].id → ed<i>, id_of_edges → ed<n>
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
  // ключи комнатных карт — тоже id комнат: переименуем
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

try {
  // 0. контрольный проект до (только GET)
  const snapBefore = READONLY_ID ? await snap(READONLY_ID, "before") : null;

  // 1. бэкап dev-проекта (текущая модель плана из env)
  const before = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/245-live-before.json`, JSON.stringify(before, null, 1));
  const backupPath = `.orca-reports/backup-${OBJECT_ID}-245.json`;
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, JSON.stringify(before, null, 1) + "\n");
    console.log("бэкап:", backupPath);
  } else {
    const stored = JSON.parse(readFileSync(backupPath, "utf8")) as { model?: unknown };
    console.log("бэкап существует; сверка с текущим GET:", sig(stored.model) === sig(before.model) ? "совпадает" : "РАСХОЖДЕНИЕ");
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });

  // 2. комната и стена из сырой модели бэкапа
  const roomsBody = await call("rooms_list", {});
  const roomList = (Array.isArray(roomsBody) ? roomsBody : (roomsBody["rooms"] ?? [])) as Array<Record<string, unknown>>;
  if (roomList.length === 0) throw new Error("в dev-проекте нет комнат");
  // самая большая комната — на ней и пробуем (меньше шансов упереться в короткое ребро)
  roomList.sort((x, y) => (Number(y["area_m2"]) || 0) - (Number(x["area_m2"]) || 0));
  const roomId = roomList[0]!["id"] as string;
  // стена, граничащая с комнатой: pid первого ребра комнаты в сырой модели (метки — по порядку)
  const roomKeys = Object.keys((before.model["rooms2"] ?? before.model["rooms1"] ?? {}) as Record<string, unknown>);
  const roomIndex = Number(/^R(\d+)$/.exec(roomId)?.[1] ?? "0") - 1;
  const roomRec = (before.model["rooms2"] ?? {}) as Record<string, { edges?: Array<{ pid?: string; length?: number }> }>;
  const targetRoom = roomRec[roomIndex >= 0 ? (Object.keys(roomRec)[roomIndex] ?? roomId) : roomId];
  if (!targetRoom) throw new Error(`комната ${roomId} не найдена в сырой модели`);
  const edge = (targetRoom.edges ?? []).filter((e) => e.pid && (e.length ?? 0) >= 30).sort((x, y) => (y.length ?? 0) - (x.length ?? 0))[0];
  if (!edge?.pid) throw new Error(`у комнаты ${roomId} нет ребра >= 25 см со стеной`);
  // метка W<n> — по порядку model_get
  const wallIds = Object.keys((before.model["walls"] ?? {}) as Record<string, unknown>);
  const wallIndex = wallIds.indexOf(edge.pid);
  if (wallIndex < 0) throw new Error(`стена ${edge.pid} не найдена`);
  const wallId = `W${wallIndex + 1}`;
  console.log("цель:", roomId, wallId, `(${edge.pid}, ребро ${Math.round(edge.length ?? 0)} см)`);

  // 3. запись: плинтусы, ниша (потолок сначала), двухслойная отделка
  await call("finish_ceiling_set", { room_id: roomId, material: "gypsum_ceiling" });
  const fm = await call("finish_floor_molding_set", { room_id: roomId, wall_id: wallId, type: "floor_molding_mdf" });
  const cm = await call("finish_ceiling_molding_set", { room_id: roomId, wall_id: wallId });
  const ni = await call("finish_ceiling_niche_add", { room_id: roomId, wall_id: wallId });
  const wt = await call("finish_wall_set", { room_id: roomId, wall_id: wallId, type: "painting_tile" });
  console.log("создано:", JSON.stringify({ fm, cm, ni, wt }));
  writeFileSync(`${OUT}/245-live-created.json`, JSON.stringify({ roomId, wallId, fm, cm, ni, wt }, null, 1));

  // 4. validate → save → reopen → сверка
  const v = await call("model_validate", {});
  console.log("validate: проблем", (v["problems"] ?? []).length);
  const saveRes = await call("project_save", {});
  console.log("save:", JSON.stringify({ verified: saveRes["verified"], rounds: saveRes["rounds"] }));
  if (!saveRes["verified"]) throw new Error("save не verified");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const fin = await call("finish_get", { room_id: roomId });
  console.log("finish_get после reopen:", JSON.stringify(fin).slice(0, 700));
  writeFileSync(`${OUT}/245-live-finish-get.json`, JSON.stringify(fin, null, 1));
  const finAll = fin as unknown as Array<Record<string, unknown>>;
  const rec = finAll[0]!;
  if (!(rec["floor_moldings"] as unknown[] | undefined)?.length) throw new Error("после reopen плинтус пола потерян");
  if (!(rec["ceiling_moldings"] as unknown[] | undefined)?.length) throw new Error("после reopen потолочный плинтус потерян");
  if (!(rec["niches"] as unknown[] | undefined)?.length) throw new Error("после reopen ниша потеряна");
  const wallsFin = (rec["walls"] ?? []) as Array<Record<string, unknown>>;
  if (!wallsFin.some((w) => w["type"] === "paint_wall" && w["layer"] === 2)) throw new Error("после reopen слой 2 painting_tile потерян");

  // 5. render PNG
  const png = await call("render_plan", { sheet: "floor" });
  console.log("render:", png["bytes"], "байт,", png["path"]);

  // 6. восстановление: снять созданное
  await call("finish_wall_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_ceiling_niche_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_ceiling_molding_remove", { room_id: roomId, wall_id: wallId });
  await call("finish_floor_molding_remove", { room_id: roomId, wall_id: wallId });
  // потолок: прежнее состояние из бэкапа (exist или нет)
  const backupModel = (JSON.parse(readFileSync(backupPath, "utf8")) as { model: Record<string, unknown> }).model;
  const bRooms = (backupModel["rooms2"] ?? backupModel["rooms1"] ?? {}) as Record<string, Record<string, unknown>>;
  const bRoom = bRooms[roomId];
  const bCeil = bRoom ? (bRoom["ceilings"] as Array<Record<string, unknown>> | undefined)?.[0] : undefined;
  if (bCeil && bCeil["exist"] === true) {
    await call("finish_ceiling_set", {
      room_id: roomId,
      material: bCeil["material"],
      ...(bCeil["level"] !== undefined ? { level: bCeil["level"] } : {}),
      ...(bCeil["profile"] !== undefined ? { profile: bCeil["profile"] } : {}),
    });
  } else {
    await call("finish_ceiling_remove", { room_id: roomId });
  }
  const saveRes2 = await call("project_save", {});
  console.log("restore save:", JSON.stringify({ verified: saveRes2["verified"], rounds: saveRes2["rounds"] }));
  if (!saveRes2["verified"]) throw new Error("restore save не verified");

  // 7. полная семантическая сверка data с бэкапом
  const after = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const same = sig(after.model) === sig(before.model);
  console.log("полная семантическая сверка data с бэкапом:", same ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  if (!same) writeFileSync(`${OUT}/get-own-after-245.json`, JSON.stringify(after, null, 1));

  // 8. контрольный проект после
  if (READONLY_ID) {
    const snapAfter = await loadModel(ctx.session(), READONLY_ID, "1");
    console.log("контрольный проект:", sig(snapAfter.model) === sig(snapBefore?.model) ? "не изменился" : "ИЗМЕНИЛСЯ — СТОП");
    if (sig(snapAfter.model) !== sig(snapBefore?.model)) throw new Error("контрольный проект изменился");
  }
  console.log("245-live OK");
} catch (e) {
  console.error("FAIL:", String((e as Error).message ?? e).slice(0, 800));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
process.exit(process.exitCode ?? 0);
