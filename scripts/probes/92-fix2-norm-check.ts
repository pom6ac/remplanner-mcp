// 92: синтетическая проверка R1a через НАСТОЯЩИЙ нормализатор редактора (без save,
// по согласованию с координатором): анонимный проект → база «коридор + 3 комнаты»
// (tests/fixtures/editor-corridor-3rooms.json) → выключатель у стены + светильник +
// cable_add → wall_move этой стены (applyWalls → живой normalize редактора) →
// фиксация: какие производные поля под-розеток редактор пересчитал и что новая сверка
// (состав/пользовательские свойства до save, производные после) не блокирует.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";
import { moveWall } from "../../src/model/walls.ts";

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 900)}`);
  return JSON.parse(text(res as never));
}
const pace = () => new Promise((r) => setTimeout(r, 400));

/** Пользовательские свойства под-розеток для отчёта. */
const subSig = (it: any) => (it.socket_group ?? []).map((s: any) => ({
  id: s.id, name: s.name, center: s.center, real_center: s.real_center,
  cables: s.cables === undefined ? undefined : JSON.stringify(s.cables),
}));
const itemSig = (it: any) => ({
  pc: it.pc, angle: it.angle, id_wall: it.id_wall, id_room: it.id_room,
  over_floor: it.over_floor, subs: subSig(it),
});
const cableSig = (c: any) => ({
  vertexes: c.vertexes.map((v: any) => ({ id: v.id, type: v.type, point: v.point, id_room: v.id_room })),
  length: c.length,
});

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "92-norm-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  // 1. анонимный проект + база «коридор + 3 комнаты» из фикстуры
  const created = await call(client, "project_create", {});
  const objectId = created.object_id ?? created.id;
  const planId = created.plan_id ?? "1";
  console.log("анонимный проект создан");
  await pace();
  const fx = JSON.parse(readFileSync("tests/fixtures/editor-corridor-3rooms.json", "utf8")).model;
  const ws = ctx.workspace();
  ws!.apply("92-fixture", (m) => {
    (m as any).walls = structuredClone(fx.walls);
    for (const w of Object.values<any>((m as any).walls)) w.holes ??= {};
    (m as any).rooms2 = structuredClone(fx.rooms2);
    (m as any).rooms1 = structuredClone(fx.rooms1 ?? {});
    return true;
  });
  const saved = await ws!.save();
  console.log(`база записана: verified=${saved.verified}, rounds=${saved.rounds}`);

  // 2. выключатель у стены (перебор стен-кандидатов), светильник, связь
  const walls = Object.values<any>(ws!.model.walls);
  const items = Object.values<any>(ws!.model.rooms2 ?? {});
  console.log("стен:", walls.length, "комнат:", Object.keys(ws!.model.rooms2 ?? {}).length);
  let swId: string | null = null;
  let wallId: string | null = null;
  for (const w of walls) {
    const len = Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y);
    if (len < 150) continue;
    try {
      await call(client, "item_add", { name: "light_switch", position: { against_wall: { wall_id: w.id, offset_mm: 1000 } } });
      swId = Object.keys(ws!.model.items).slice(-1)[0]!;
      wallId = w.id;
      break;
    } catch (e) {
      console.log(`  стена ${w.id} отклонена:`, String((e as Error).message).replace(/\s+/g, " ").slice(0, 120));
    }
    await pace();
  }
  if (!swId) throw new Error("выключатель не поставился");
  await pace();
  const sw0 = ws!.model.items[swId!] as any;
  if (sw0.id_wall !== wallId) throw new Error(`выключатель у другой стены: ${sw0.id_wall} != ${wallId}`);
  console.log("выключатель поставлен:", JSON.stringify({ id: swId, wall: wallId, ...itemSig(sw0) }));

  // светильник: центр комнаты с максимальной площадью
  const room = Object.values<any>(ws!.model.rooms2).sort((r1: any, r2: any) => (r2.area ?? 0) - (r1.area ?? 0))[0]!;
  const poly: { x: number; y: number }[] = room.polygon ?? room.points ?? [];
  const cx = Math.round(poly.reduce((s, p) => s + p.x, 0) / poly.length * 10);
  const cy = Math.round(poly.reduce((s, p) => s + p.y, 0) / poly.length * 10);
  await call(client, "item_add", { name: "chandelier", position: { center: { x: cx, y: cy } } });
  const lampId = Object.keys(ws!.model.items).slice(-1)[0]!;
  await pace();
  const c1 = await call(client, "cable_add", { switch_item_id: swId, lamp_item_id: lampId });
  const cableId = c1.entity?.site_id ?? Object.keys(ws!.model.cables ?? {}).slice(-1)[0]!;
  await pace();
  console.log("cable_add:", JSON.stringify(c1.entity));

  // 3. снимок ДО переноса стены (под-розетки/кабель в состоянии после cable_add)
  const wallOf = () => structuredClone(ws!.model.walls[wallId!]);
  const beforeMove = {
    wall: { p1: wallOf().p1, p2: wallOf().p2 },
    sw: itemSig(structuredClone(ws!.model.items[swId!]) as any),
    cable: cableSig(structuredClone(ws!.model.cables![cableId]) as any),
  };

  // 4. wall_move стены с группой — НАСТОЯЩИЙ normalize редактора (без save)
  const t0 = Date.now();
  const mv = await call(client, "wall_move", { wall_id: wallId, offset_mm: 100 });
  console.log("wall_move ok in", Date.now() - t0, "ms");
  await pace();
  const wallAfter = wallOf();
  console.log("стена ДО:", JSON.stringify({ p1: beforeMove.wall.p1, p2: beforeMove.wall.p2 }), "→ ПОСЛЕ:", JSON.stringify({ p1: wallAfter.p1, p2: wallAfter.p2 }));
  const afterMove = {
    sw: itemSig(structuredClone(ws!.model.items[swId!]) as any),
    cable: cableSig(structuredClone(ws!.model.cables![cableId]) as any),
  };
  console.log("ДО  wall_move:", JSON.stringify(beforeMove, null, 1));
  console.log("ПОСЛЕ wall_move (модель после живого normalize):", JSON.stringify(afterMove, null, 1));

  // 5б. перенос самой группы вдоль стены (item_update) — второй производный сценарий:
  // текущая pc выключателя + 30 см вдоль оси стены
  const swMid = ws!.model.items[swId!] as any;
  const w = ws!.model.walls[wallId!];
  const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
  const wl = Math.hypot(dx, dy) || 1;
  const centerMm = { x: Math.round((swMid.pc.x + (dx / wl) * 30) * 10), y: Math.round((swMid.pc.y + (dy / wl) * 30) * 10) };
  await call(client, "item_update", { item_id: swId, position: { center: centerMm } });
  await pace();
  const swMoved = ws!.model.items[swId!] as any;
  console.log("после item_update:", JSON.stringify(itemSig(swMoved)));
  console.log("кабель после item_update:", JSON.stringify(cableSig(structuredClone(ws!.model.cables![cableId]) as any)));

  // 5. повторный прогон нормализатора по уже нормализованной модели —
  //    стабильность сверки (пользовательские свойства и производные)
  const editor = await (ws as any).ensureEditor();
  const prepared = structuredClone(ws!.model);
  const { prepareForRestore } = await import("../../src/model/walls.ts");
  prepareForRestore(prepared);
  const norm2 = await editor.normalize(prepared);
  const { socketGroupSubsUserMismatches, socketGroupSubsDerivedMismatches } = await import("../../src/workspace.ts");
  const itemsA = ws!.model.items as Record<string, unknown>;
  const itemsB = (norm2.model as { items?: Record<string, unknown> }).items ?? {};
  console.log("повторный normalize: user-mismatches:", JSON.stringify(socketGroupSubsUserMismatches(itemsA as never, itemsB)));
  console.log("повторный normalize: derived-mismatches:", JSON.stringify(socketGroupSubsDerivedMismatches(itemsA as never, itemsB)));

  // 6. обратный перенос (без save) — симметрия
  await call(client, "wall_move", { wall_id: wallId, offset_mm: -100 });
  const swBack = ws!.model.items[swId!] as any;
  console.log("после обратного wall_move:", JSON.stringify(itemSig(swBack)));

  await client.close();
  console.log("OK — живой normalize с wall_move не заблокирован сверкой под-розеток");
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", (e && e.stack) || String(e)); process.exit(1); });
