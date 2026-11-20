// 43-fix-pillars, №4: живая проверка сохранности данных комнаты в dev-проекте.
// Сценарий: имя+отделка комнаты → pillar_add → save → reopen → сверка → pillar_delete
// → save → reopen → снова; в конце — восстановление исходного состояния по бэкапу.
// ID только из env. Запуск:
//   REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… REMPLANNER_PROBE_ROOM_ID=…
//   node scripts/probes/43-live-rooms.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";
import { assertTargetPair } from "./probe-guard.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
const ROOM_ID = process.env.REMPLANNER_PROBE_ROOM_ID ?? "";
if (!OBJECT_ID || !PLAN_ID) {
  console.error("Задайте REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => {
  const t = text(r);
  try { return JSON.parse(t); } catch { return t; }
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if ((r as Res).isError) throw new Error(`${name}: ${text(r)}`);
  return json(r);
};

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "43-live-rooms", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const roomState = async (label: string): Promise<void> => {
  const full = await call("model_get", { detail: "full" });
  const rooms = full.rooms2 ?? {};
  for (const [id, r] of Object.entries<any>(rooms)) {
    if (ROOM_ID && id !== ROOM_ID) continue;
    const zones = (r.zones ?? []).map((z: any) => z.name);
    console.log(`[${label}] room ${id}: name=${r.name} zones=${JSON.stringify(zones)} floorsExist=${JSON.stringify((r.floors ?? []).map((f: any) => f.exist))} covers=${JSON.stringify((r.floors ?? []).map((f: any) => f.cover ?? null))} area=${r.area} walls=${Object.keys(full.walls ?? {}).length} pillars=${Object.keys(full.pillars ?? {}).length}`);
  }
};

// ревью 319 №3: пара объект/план из env до первой записи
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
console.log("== open ==", JSON.stringify(await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID })).slice(0, 200));

// 1. имя и отделка в канонической модели
const full1 = await call("model_get", { detail: "full" });
const targetId = ROOM_ID || Object.keys(full1.rooms2 ?? {})[0]!;
const room = full1.rooms2[targetId];
const zones = room.zones ?? [];
if (zones.length === 0) throw new Error("у комнаты нет зон");
const poly: { x: number; y: number }[] = zones[0].polygon;
const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
console.log("== комната", targetId, "центр:", Math.round(cx * 10), Math.round(cy * 10));

await ctx.workspace().apply("43-room-userdata", (m) => {
  const roomsMap = (m.rooms2 ??= {}) as Record<string, any>;
  const room = (roomsMap[targetId] ??= {}) as Record<string, any>;
  room.name = "Гостиная";
  for (const z of room.zones ?? []) z.name = "Гостиная";
  // отделка пола: сериализация Floor редактора (src-24: exist → cover, angle, pc, width/height, type_laying)
  for (const f of room.floors ?? []) {
    f.exist = true;
    f.cover = "floor_tile";
    f.type_laying = "tile";
    f.angle = 0;
    f.custom_angle = 0;
    f.width = 40;
    f.height = 40;
    f.f0offset = 0;
    f.pc = structuredClone(room.pc ?? { x: 0, y: 0 });
  }
  return true;
});

console.log("== save #1 ==", JSON.stringify(await call("project_save", {})));
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
await roomState("после save+reopen");

// 2. колонна внутри комнаты
const full2 = await call("model_get", { detail: "full" });
const room2 = full2.rooms2[targetId];
const zp: { x: number; y: number }[] = (room2.zones ?? [])[0]?.polygon ?? [];
const px = (p: { x: number; y: number }) => Math.round(p.x * 10);
const py = (p: { x: number; y: number }) => Math.round(p.y * 10);
let placed: unknown = null;
const xs2 = zp.map((p) => p.x), ys2 = zp.map((p) => p.y);
const ccx = (Math.min(...xs2) + Math.max(...xs2)) / 2, ccy = (Math.min(...ys2) + Math.max(...ys2)) / 2;
for (const [dx, dy] of [[0, 0], [15, 0], [-15, 0], [0, 15], [0, -15], [30, 0], [-30, 0], [0, 30], [0, -30]] as const) {
  try {
    placed = await call("pillar_add", { center: { x: px({ x: ccx + dx, y: ccy + dy }), y: py({ x: ccx + dx, y: ccy + dy }) } });
    console.log("== pillar_add ok:", JSON.stringify(placed).slice(0, 200));
    break;
  } catch (e) {
    console.log("pillar_add попытка:", (e as Error).message.slice(0, 140));
  }
}
if (!placed) throw new Error("не удалось поставить колонну в комнате");

console.log("== save #2 (с колонной) ==", JSON.stringify(await call("project_save", {})));
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
await roomState("после pillar_add+save+reopen");

// 3. удалить колонну (наша 20×20; у колонн проб другие габариты)
const full3 = await call("model_get", { detail: "full" });
const mineFromModel = Object.keys(full3.pillars ?? {}).find((id) => full3.pillars[id].width === 20 && full3.pillars[id].height === 20);
const pillarId = (placed as { site_id?: string })?.site_id ?? mineFromModel;
console.log("== удаляем колонну:", pillarId);
await call("pillar_delete", { pillar_id: pillarId });
console.log("== save #3 ==", JSON.stringify(await call("project_save", {})));
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
await roomState("после pillar_delete+save+reopen");

await ctx.workspaceOrNull?.close().catch(() => {});
process.exit(0);
