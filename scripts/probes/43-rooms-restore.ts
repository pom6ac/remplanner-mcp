// 43-fix-pillars, №4 финал: вернуть dev-проект к состоянию бэкапа (имя=none, отделка off,
// без тестовой колонны), затем сверить стены/колонны/комнаты с бэкапом
// .orca-reports/backup-<object_id>-43.json (путь строится из env).
// Запуск: REMPLANNER_PROBE_OBJECT_ID=… REMPLANNER_PROBE_PLAN_ID=… REMPLANNER_PROBE_ROOM_ID=…
import { readFileSync } from "node:fs";
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
const json = (r: unknown): any => JSON.parse(text(r));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if ((r as Res).isError) throw new Error(`${name}: ${text(r)}`);
  return json(r);
};

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "43-rooms-restore", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

// ревью 319 №3: пара объект/план из env до первой записи
await assertTargetPair(ctx.session(), OBJECT_ID, PLAN_ID);
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
const targetId = ROOM_ID || Object.keys(json(await call("model_get", { detail: "full" })).rooms2 ?? {})[0]!;
await ctx.workspace().apply("43-restore-room", (m) => {
  const roomsMap = (m.rooms2 ??= {}) as Record<string, any>;
  const room = (roomsMap[targetId] ??= {}) as Record<string, any>;
  room.name = "none";
  for (const z of room.zones ?? []) z.name = "none";
  for (const f of room.floors ?? []) {
    f.exist = false;
    delete f.cover;
    delete f.type_laying;
    delete f.angle;
    delete f.custom_angle;
    delete f.width;
    delete f.height;
    delete f.pc;
  }
  return true;
});
console.log("restore save:", JSON.stringify(await call("project_save", {})));

// сверка с бэкапом
await call("project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
const now = await call("model_get", { detail: "full" });
const backup = JSON.parse(readFileSync(`.orca-reports/backup-${OBJECT_ID}-43.json`, "utf8")).model;
const diff: string[] = [];
const cmpWalls = (a: Record<string, any>, b: Record<string, any>): void => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) { diff.push(`walls count ${ka.length} != ${kb.length}`); return; }
  for (const id of ka) {
    const wa = a[id], wb = b[id];
    if (JSON.stringify(wa.p1) !== JSON.stringify(wb.p1) || JSON.stringify(wa.p2) !== JSON.stringify(wb.p2) || wa.depth !== wb.depth) {
      diff.push(`wall ${id} изменилась`);
    }
  }
};
cmpWalls(now.walls ?? {}, backup.walls ?? {});
const pk = Object.keys(now.pillars ?? {}).sort(), bk = Object.keys(backup.pillars ?? {}).sort();
if (JSON.stringify(pk) !== JSON.stringify(bk)) diff.push(`pillars: ${JSON.stringify(pk)} != ${JSON.stringify(bk)}`);
for (const id of pk) {
  const pa = now.pillars[id], pb = (backup.pillars ?? {})[id];
  if (!pb) continue;
  if (JSON.stringify(pa.pc) !== JSON.stringify(pb.pc) || pa.width !== pb.width || pa.height !== pb.height || pa.angle !== pb.angle) {
    diff.push(`pillar ${id} геометрия изменилась`);
  }
}
const rn = now.rooms2?.[targetId], rb = backup.rooms2?.[targetId];
if (rn?.name !== rb?.name) diff.push(`room name ${rn?.name} != ${rb?.name}`);
if (JSON.stringify((rn?.floors ?? []).map((f: any) => f.exist)) !== JSON.stringify((rb?.floors ?? []).map((f: any) => f.exist))) diff.push("room floors exist отличаются");
console.log("сверка с бэкапом:", diff.length === 0 ? "OK — модель совпадает" : JSON.stringify(diff, null, 1));
console.log("итоговое save_id:", now.project?.saveId ?? "(в model_get нет)");
await ctx.workspaceOrNull?.close().catch(() => {});
process.exit(diff.length === 0 ? 0 : 1);
