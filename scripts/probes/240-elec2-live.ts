// 240: живая проверка электрики ч.2 в dev-проекте из env (REMPLANNER_PROBE_OBJECT_ID,
// REMPLANNER_PROBE_READONLY_ID). Полная цепочка MCP: room_add_rect → item_add
// (щиток/коробка/вывод/розетка/термостат/выключатель) → led_strip_add → wiring_add
// (cables_socket ×2, cables_warm_floor) → cable_add (выключатель → лента) →
// model_validate → project_save (verified, без NORMALIZATION_DROPPED) → reopen →
// model_get сверка → render_plan PNG → очистка созданных объектов по ID → save.
// GET рабочего проекта (env) — только чтение до и после, сверка.
// Запуск: node --experimental-strip-types scripts/probes/240-elec2-live.ts run
import { mkdirSync, writeFileSync } from "node:fs";
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
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "240-elec2-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

type TextContent = { content: { type: string; text?: string }[] };
const text = (r: unknown): string => {
  const contents = (r as TextContent).content ?? [];
  const first = contents.find((c) => c.type === "text");
  return first?.text ?? JSON.stringify(contents);
};
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await client.callTool({ name, arguments: args });
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text(res).slice(0, 800)}`);
  return JSON.parse(text(res)) as Record<string, unknown>;
};
const entityId = (res: Record<string, unknown>): string => {
  const e = res["entity"] as { id?: string } | undefined;
  if (!e?.id) throw new Error(`в ответе нет entity.id: ${JSON.stringify(res).slice(0, 200)}`);
  return e.id;
};

const snap = async (objectId: string, tag: string): Promise<LoadedModel> => {
  const m = await loadModel(ctx.session(), objectId, "1");
  writeFileSync(`${OUT}/get-${objectId}-${tag}.json`, JSON.stringify(m, null, 1));
  return m;
};

type Compact = {
  walls: { id: string; from: [number, number]; to: [number, number] }[];
  items: { id: string; name: string }[];
  cables_socket?: { id: string; type: string }[];
  cables_warm_floor?: { id: string; type: string }[];
  cables?: { id: string }[];
};
const mg = async (): Promise<Compact> => (await call("model_get", {})) as unknown as Compact;

const created: Record<string, string[]> = { walls: [], items: [], led_strips: [], cables: [], wiring: [] };
let readonlyBefore: LoadedModel | null = null;
let verified = false;
try {
  readonlyBefore = await snap(READONLY_ID, "before");
  // свой план dev-проекта до прогона (после очистки должен совпасть)
  const ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/get-own-live-before.json`, JSON.stringify(ownBefore, null, 1));

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsBefore = new Set((await mg()).walls.map((w) => w.id));

  // 1. пробная комната правее существующей геометрии (координаты model_get — мм);
  // пустой dev-проект — комната строится с нуля (5×5 м от начала координат)
  const ws0 = (await mg()).walls;
  const maxX = ws0.length > 0 ? Math.max(...ws0.flatMap((w) => [w.from[0], w.to[0]])) : 3000;
  const minY = ws0.length > 0 ? Math.min(...ws0.flatMap((w) => [w.from[1], w.to[1]])) : 3000;
  const ox = maxX + 1500;
  const oy = minY;
  const roomRes = await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  const roomEntity = roomRes["entity"] as { walls?: { id: string }[] } | undefined;
  if (!roomEntity?.walls?.length) throw new Error(`room_add_rect: в ответе нет стен: ${JSON.stringify(roomRes).slice(0, 200)}`);
  console.log("room walls:", roomEntity.walls.map((w) => w.id).join(" "), "origin:", ox, oy);

  // стены пробы: верхняя (горизонтальная с минимальным y из новых)
  const m1 = await mg();
  const newWalls = m1.walls.filter((w) => !wallsBefore.has(w.id));
  created.walls = newWalls.map((w) => w.id);
  const top = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0];
  if (!top) throw new Error("верхняя стена пробной комнаты не найдена");
  console.log("walls:", created.walls.join(" "), "top:", top.id);

  // 2. предметы электрики ч.2 в пробной комнате
  const aw = (offsetMm: number) => ({ against_wall: { wall_id: top.id, offset_mm: offsetMm } });
  const shield = entityId(await call("item_add", { name: "electric_shield", position: aw(3000) }));
  const box = entityId(await call("item_add", { name: "electric_box", position: { center: { x: ox + 2000, y: oy + 1500 } } }));
  const wire = entityId(await call("item_add", { name: "wire", position: aw(500) }));
  const socket = entityId(await call("item_add", { name: "socket", position: aw(1000) }));
  const thermo = entityId(await call("item_add", { name: "socket_thermo", position: aw(1500) }));
  const sw = entityId(await call("item_add", { name: "light_switch", position: aw(2500) }));
  const strip = entityId(await call("led_strip_add", { path: [{ x: ox + 1500, y: oy + 2000 }, { x: ox + 3500, y: oy + 2000 }] }));
  created.items = [shield, box, wire, socket, thermo, sw];
  created.led_strips = [strip];
  console.log("items:", created.items.join(" "), "strip:", strip);

  // 3. кабели-проводка и связь выключатель → лента
  created.wiring.push(entityId(await call("wiring_add", { kind: "wire_3_25", path: [{ item_id: box }, { item_id: shield }] })));
  created.wiring.push(entityId(await call("wiring_add", { kind: "wire_tv", path: [{ item_id: box }, { item_id: socket }] })));
  created.wiring.push(entityId(await call("wiring_add", { kind: "warm_floor_wire", path: [{ item_id: box }, { item_id: thermo }] })));
  created.cables.push(entityId(await call("cable_add", { switch_item_id: sw, lamp_item_id: strip })));
  console.log("wiring:", created.wiring.join(" "), "cable:", created.cables.join(" "));

  // 4. validate → save
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
  const save = await call("project_save", {});
  writeFileSync(`${OUT}/240-save-result.json`, JSON.stringify(save, null, 1));
  verified = (save as { verified?: boolean }).verified === true;
  console.log("save verified:", verified);

  // 5. reopen + сверка
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await mg();
  const checks: [string, boolean][] = [
    ["cables_socket: 2 (wire_3_25, wire_tv)", after.cables_socket?.length === 2],
    ["cables_warm_floor: 1 (warm_floor_wire)", after.cables_warm_floor?.length === 1 && after.cables_warm_floor[0]?.type === "warm_floor_wire"],
    ["связь выключатель→лента: есть", (after.cables?.length ?? 0) > 0],
    ["щиток на месте", after.items.some((i) => i.name === "electric_shield")],
    ["вывод провода на месте", after.items.some((i) => i.name === "wire")],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(ok ? "OK   " : "FAIL ", label);
    if (!ok) allOk = false;
  }

  // 6. render PNG (пишется в ~/.remplanner-mcp/renders, копия в tmp)
  const png = await call("render_plan", {});
  const pngPath = png["path"] as string | undefined;
  console.log("render:", pngPath ?? "нет path в ответе");
  if (!pngPath) allOk = false;
  else {
    const { copyFileSync } = await import("node:fs");
    copyFileSync(pngPath, `${OUT}/240-render.png`);
  }

  // 7. очистка созданных объектов (только свои, по ID) + save — выполняется всегда
  // после успешного save, чтобы не оставлять объекты пробы в dev-проекте
  if (verified) {
    // в обратном порядке: метки I<n>/W<n>/CS<n> позиционные и сдвигаются после удаления;
    // стены — по одной с save после каждой (восстановление исходного состояния проекта)
    for (const id of [...created.cables].reverse()) await call("cable_delete", { cable_id: id });
    for (const id of [...created.wiring].reverse()) await call("wiring_delete", { wiring_id: id });
    for (const id of [...created.led_strips].reverse()) await call("led_strip_delete", { led_strip_id: id });
    for (const id of [...created.items].reverse()) await call("item_delete", { item_id: id });
    let cleanupOk = true;
    for (const id of [...created.walls].reverse()) {
      try {
        await call("wall_delete", { wall_id: id });
        const sv = (await call("project_save", {})) as { verified?: boolean };
        if (sv.verified !== true) {
          // ретрай: перечитать проект и удалить стену заново (NORMALIZATION_DROPPED бывает
          //flaky при удалении стен — редактор пересобирает отрезки)
          await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
          await call("wall_delete", { wall_id: id });
          const sv2 = (await call("project_save", {})) as { verified?: boolean };
          if (sv2.verified !== true) cleanupOk = false;
        }
      } catch (e) {
        console.log("cleanup wall", id, "FAILED:", (e as Error).message.slice(0, 160));
        cleanupOk = false;
        break;
      }
    }
    await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
    const wallsClean = (await mg()).walls.length === wallsBefore.size;
    console.log("cleanup ok:", cleanupOk, "walls back:", wallsClean);
    allOk = cleanupOk && wallsClean;
  }

  // 8. GET рабочего проекта (env) после прогона — не изменился;
  // свой план dev-проекта после очистки — как до прогона
  const readonlyAfter = await snap(READONLY_ID, "after");
  const sameReadonly = JSON.stringify(readonlyBefore.model) === JSON.stringify(readonlyAfter.model);
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");
  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`${OUT}/get-own-live-after.json`, JSON.stringify(ownAfter, null, 1));
  // семантическая сверка (служебные поля session/version меняются при каждом входе):
  // осевые отрезки стен, проёмы, предметы и состав коллекций
  const ownSig = (m: Record<string, unknown>): string => {
    const walls = Object.values((m["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number }; holes?: Record<string, unknown> }>);
    const wallSig = walls.map((w) => [w.p1.x, w.p1.y, w.p2.x, w.p2.y, Object.keys(w.holes ?? {}).length].join(":")).sort().join("|");
    const colls = ["items", "pillars", "rigels", "cables", "cables_socket", "cables_warm_floor", "cables_conditioner", "led_strips", "stripes_light", "line_strips", "rulers", "comments", "warm_floors"]
      .map((k) => `${k}=${Object.keys((m[k] ?? {}) as Record<string, unknown>).length}`).join(",");
    return `${wallSig}#${colls}#rooms2=${Object.keys((m["rooms2"] ?? {}) as Record<string, unknown>).length}`;
  };
  const sameOwn = ownSig(ownBefore.model) === ownSig(ownAfter.model);
  if (!sameOwn) {
    console.log("own before sig:", ownSig(ownBefore.model).slice(0, 300));
    console.log("own after  sig:", ownSig(ownAfter.model).slice(0, 300));
  }
  console.log(sameOwn ? "OWN PLAN OK (после очистки как до прогона)" : "OWN PLAN CHANGED");

  console.log("RESULT:", allOk && verified && sameReadonly && sameOwn ? "LIVE_OK" : "LIVE_FAIL");
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  console.log("RESULT: LIVE_FAIL");
} finally {
  await closeBrowser().catch(() => {});
}
process.exit(0);
