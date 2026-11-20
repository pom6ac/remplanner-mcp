// 242: живая проверка ревью 241 №2 в dev-проекте (env: REMPLANNER_PROBE_OBJECT_ID,
// REMPLANNER_PROBE_PLAN_ID; рабочий проект только на чтение — REMPLANNER_PROBE_READONLY_ID
// с планом REMPLANNER_PROBE_READONLY_PLAN_ID; совпадение OBJECT_ID и READONLY_ID — отказ).
// Сценарий: пробная комната → щиток у стены + коробка → wiring_add box→shield →
// item_update щитка (перенос вдоль стены, against_wall) → save без
// NORMALIZATION_DROPPED/INVALID_GEOMETRY → reopen → вершина кабеля = pc щитка →
// очистка созданных объектов по захваченным ID → save → сверка плана с бэкапом.
// Бэкап до прогона: .orca-reports/backup-<OBJECT_ID>-242.json; GET readonly до/после —
// только чтение (файлы .orca-reports/tmp/get-readonly-242-{before,after}.json).
// Запуск: node --experimental-strip-types scripts/probes/242-elec2-live.ts run
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadModel, type LoadedModel } from "../../src/api.ts";
import { closeBrowser } from "../../src/browser.ts";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { assertNoReadonlyCollision, assertTargetPair, readonlyGuard } from "./probe-guard.ts";

if (process.argv[2] !== "run") {
  console.error("запуск по явному аргументу: … " + process.argv[1] + " run (REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID, REMPLANNER_PROBE_READONLY_PLAN_ID из env)");
  process.exit(0);
}

const OBJECT_ID = process.env["REMPLANNER_PROBE_OBJECT_ID"];
const PLAN_ID = process.env["REMPLANNER_PROBE_PLAN_ID"];
const READONLY_ID = process.env["REMPLANNER_PROBE_READONLY_ID"];
const READONLY_PLAN_ID = process.env["REMPLANNER_PROBE_READONLY_PLAN_ID"];
if (!OBJECT_ID || !PLAN_ID || !READONLY_ID || !READONLY_PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID, REMPLANNER_PROBE_PLAN_ID, REMPLANNER_PROBE_READONLY_ID и REMPLANNER_PROBE_READONLY_PLAN_ID");
  process.exit(1);
}
// ревью 243 N3 + ревью 319 №3: запись идёт в OBJECT_ID, READONLY_ID только
// читается — ошибка в env не должна направить save в рабочий проект (отказ до
// запуска браузера), включая коллизию PLAN_ID с планом контрольного проекта
assertNoReadonlyCollision(OBJECT_ID, PLAN_ID, READONLY_ID, READONLY_PLAN_ID);
const OUT = ".orca-reports/tmp";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "242-elec2-live", version: "0.0.0" });
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

type Compact = {
  walls: { id: string; from: [number, number]; to: [number, number] }[];
};
const mg = async (): Promise<Compact> => (await call("model_get", {})) as unknown as Compact;

type FullModel = {
  items: Record<string, { name: string; pc: { x: number; y: number } }>;
  cables_socket?: Record<string, { type: string; vertexes: { id: string; point: { x: number; y: number }; type: string }[] }>;
};
const full = async (): Promise<FullModel> => (await call("model_get", { detail: "full" })) as unknown as FullModel;
/** Щиток и его вершина в кабеле по сырой модели (id коррелируются сами, без меток). */
const shieldVertex = (m: FullModel, wiringSiteId: string): { itemId: string; pc: { x: number; y: number }; vertex: { x: number; y: number } } => {
  const entry = Object.entries(m.items).find(([, it]) => it.name === "electric_shield");
  if (!entry) throw new Error("щиток не найден в полной модели");
  const [itemId, item] = entry;
  const cable = (m.cables_socket ?? {})[wiringSiteId];
  if (!cable) throw new Error(`кабель ${wiringSiteId} не найден в cables_socket`);
  const v = cable.vertexes.find((x) => x.id === itemId);
  if (!v) throw new Error(`в кабеле нет вершины щитка ${itemId}`);
  return { itemId, pc: item.pc, vertex: v.point };
};

const created: Record<string, string[]> = { walls: [], items: [], wiring: [] };
let allOk = true;
try {
  // 0. бэкап своего плана до прогона (полная копия модели, вне git)
  const ownBefore = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  writeFileSync(`.orca-reports/backup-${OBJECT_ID}-242.json`, JSON.stringify(ownBefore, null, 1));
  console.log("backup written:", `backup-${OBJECT_ID}-242.json`, "walls:", Object.keys(ownBefore.model.walls ?? {}).length);

  // ревью 319 №3/№4: пара объект/план из env; эталон контрольного проекта фиксированный
  await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
  const roGuard = await readonlyGuard(ctx.session(), READONLY_ID, READONLY_PLAN_ID, `${OUT}/242-readonly-ref.json`);
  await roGuard.assertUnchanged("перед записями");

  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsBefore = new Set((await mg()).walls.map((w) => w.id));

  // 1. пробная комната правее существующей геометрии
  const ws0 = (await mg()).walls;
  const maxX = ws0.length > 0 ? Math.max(...ws0.flatMap((w) => [w.from[0], w.to[0]])) : 3000;
  const minY = ws0.length > 0 ? Math.min(...ws0.flatMap((w) => [w.from[1], w.to[1]])) : 3000;
  const ox = maxX + 1500;
  const oy = minY;
  const roomRes = await call("room_add_rect", { origin: { x: ox, y: oy }, width: 4000, depth: 3000, wall_thickness: 200 });
  const roomEntity = roomRes["entity"] as { walls?: { id: string }[] } | undefined;
  if (!roomEntity?.walls?.length) throw new Error(`room_add_rect: нет стен в ответе`);
  created.walls = roomEntity.walls.map((w) => w.id);
  const m1 = await mg();
  const newWalls = m1.walls.filter((w) => !wallsBefore.has(w.id));
  const top = newWalls.filter((w) => w.from[1] === w.to[1]).sort((x, y) => x.from[1] - y.from[1])[0];
  if (!top) throw new Error("верхняя стена пробной комнаты не найдена");
  console.log("room:", created.walls.join(" "), "top:", top.id);

  // 2. щиток у стены + коробка; кабель box→shield
  const aw = (offsetMm: number) => ({ against_wall: { wall_id: top.id, offset_mm: offsetMm } });
  const shield = entityId(await call("item_add", { name: "electric_shield", position: aw(3000) }));
  const box = entityId(await call("item_add", { name: "electric_box", position: { center: { x: ox + 2000, y: oy + 1500 } } }));
  created.items = [shield, box];
  const wiringRes = (await call("wiring_add", { kind: "wire_3_25", path: [{ item_id: box }, { item_id: shield }] }))["entity"] as { id?: string; site_id?: string };
  if (!wiringRes?.site_id) throw new Error("wiring_add: в ответе нет site_id");
  const wiringSiteId = wiringRes.site_id;
  created.wiring = [wiringRes.site_id];
  console.log("items:", created.items.join(" "), "wiring:", wiringRes.id, "site:", wiringSiteId);

  // до переноса: вершина = pc щитка (сырая модель, mm→см)
  const before = await full();
  const vBefore = shieldVertex(before, wiringSiteId);
  console.log("before: shield pc", vBefore.pc, "vertex", vBefore.vertex);
  const vertexIsPc = vBefore.vertex.x === vBefore.pc.x && vBefore.vertex.y === vBefore.pc.y;
  console.log(vertexIsPc ? "OK   вершина = pc до переноса" : "FAIL вершина ≠ pc до переноса");
  allOk = allOk && vertexIsPc;

  // 3. перенос щитка вдоль стены → save
  const newOffset = 1500;
  await call("item_update", { item_id: shield, position: aw(newOffset) });
  console.log("item_update: перенос вдоль стены на offset", newOffset);
  const validation = (await call("model_validate", {})) as { ok?: boolean; problems?: unknown[] };
  console.log("validate ok:", validation.ok, validation.problems?.length ?? 0);
  const save = await call("project_save", {});
  writeFileSync(`${OUT}/242-save-result.json`, JSON.stringify(save, null, 1));
  const verified = (save as { verified?: boolean }).verified === true;
  console.log("save verified:", verified);
  allOk = allOk && verified;
  await sleep(5000); // лимит частоты сохранений

  // 4. reopen → вершина кабеля = pc щитка
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await full();
  const vAfter = shieldVertex(after, wiringSiteId);
  console.log("after reopen: shield pc", vAfter.pc, "vertex", vAfter.vertex);
  const moved = vAfter.pc.x !== vBefore.pc.x || vAfter.pc.y !== vBefore.pc.y;
  const vertexFollows = vAfter.vertex.x === vAfter.pc.x && vAfter.vertex.y === vAfter.pc.y;
  console.log(moved ? "OK   щиток перенесён" : "FAIL щиток не перенёсся");
  console.log(vertexFollows ? "OK   вершина = новый pc щитка (ревью 241 №2)" : "FAIL вершина ≠ новый pc — «7 см от грани»?");
  allOk = allOk && moved && vertexFollows;

  // 5. очистка созданных объектов по захваченным ID + save
  for (const id of [...created.wiring].reverse()) await call("wiring_delete", { wiring_id: id });
  for (const id of [...created.items].reverse()) await call("item_delete", { item_id: id });
  const sv0 = (await call("project_save", {})) as { verified?: boolean };
  console.log("cleanup items save verified:", sv0.verified === true);
  allOk = allOk && sv0.verified === true;
  await sleep(5000);
  let cleanupWalls = true;
  for (const id of [...created.walls].reverse()) {
    try {
      await call("wall_delete", { wall_id: id });
      const sv = (await call("project_save", {})) as { verified?: boolean };
      if (sv.verified !== true) {
        await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        await call("wall_delete", { wall_id: id });
        const sv2 = (await call("project_save", {})) as { verified?: boolean };
        if (sv2.verified !== true) cleanupWalls = false;
      }
    } catch (e) {
      console.log("cleanup wall", id, "FAILED:", (e as Error).message.slice(0, 160));
      cleanupWalls = false;
      break;
    }
    await sleep(5000);
  }
  await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const wallsClean = (await mg()).walls.length === wallsBefore.size;
  console.log("cleanup walls ok:", cleanupWalls, "walls back:", wallsClean);
  allOk = allOk && cleanupWalls && wallsClean;

  // 6. ревью 319 №4: контрольный проект сверяется с фиксированным эталоном; свой план после очистки — как бэкап
  const sameReadonly = !(await roGuard.checkFinal("в конце"));
  console.log(sameReadonly ? "READONLY OK" : "READONLY CHANGED — СТОП");
  const ownAfter = await loadModel(ctx.session(), OBJECT_ID, PLAN_ID);
  const sig = (m: Record<string, unknown>): string => {
    const walls = Object.values((m["walls"] ?? {}) as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number }; holes?: Record<string, unknown> }>);
    const wallSig = walls.map((w) => [w.p1.x, w.p1.y, w.p2.x, w.p2.y, Object.keys(w.holes ?? {}).length].join(":")).sort().join("|");
    const colls = ["items", "pillars", "rigels", "cables", "cables_socket", "cables_warm_floor", "cables_conditioner", "led_strips", "stripes_light", "line_strips", "rulers", "comments", "warm_floors"]
      .map((k) => `${k}=${Object.keys((m[k] ?? {}) as Record<string, unknown>).length}`).join(",");
    return `${wallSig}#${colls}#rooms2=${Object.keys((m["rooms2"] ?? {}) as Record<string, unknown>).length}`;
  };
  const sameOwn = sig(ownBefore.model) === sig(ownAfter.model);
  if (!sameOwn) {
    console.log("before sig:", sig(ownBefore.model).slice(0, 300));
    console.log("after  sig:", sig(ownAfter.model).slice(0, 300));
  }
  console.log(sameOwn ? "OWN PLAN OK (после очистки как до прогона)" : "OWN PLAN CHANGED");
  allOk = allOk && sameReadonly && sameOwn;

  console.log("RESULT:", allOk ? "LIVE_OK" : "LIVE_FAIL");
} catch (e) {
  console.error("PROBE_ERROR:", (e as Error).message);
  console.log("RESULT: LIVE_FAIL");
} finally {
  await closeBrowser().catch(() => {});
}
process.exit(0);
