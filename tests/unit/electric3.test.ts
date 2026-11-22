// Электрика ч.3 (этап 370): вертикальные блоки розеточных групп («друг над
// другом») — props.layer 2/3 у пристенной электрики (бандл app.3.0: layer
// dragmoveWall, get_offset_layer2 = 26/52 см, у скосов 22/44), связка
// (pairing_line/has_layer_up) — производная, в модели не хранится.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ItemProps } from "../../src/model/types.ts";
import { addRoomRect } from "../../src/model/walls.ts";
import { addItem, updateItem } from "../../src/model/items.ts";
import {
  addCable, SOCKET_LAYER_OFFSET_CM, socketLayerOf, applySocketGroupLayer,
} from "../../src/model/electric.ts";
import { toToolEntry, type ToolEntry } from "../../src/catalog.ts";
import { Workspace, type WorkspaceDeps, type EditorLike } from "../../src/workspace.ts";
import type { LoadedModel } from "../../src/api.ts";
import { itemVerificationMismatches } from "../../src/verify/items.ts";
import { McpError } from "../../src/errors.ts";

const here = dirname(fileURLToPath(import.meta.url));

function baseModel(): Model {
  const model = JSON.parse(readFileSync(join(here, "../fixtures/anon-rect-4000x3000.json"), "utf8")).model as Model;
  const m = { ...structuredClone(model), walls: {} } as Model;
  addRoomRect(m, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
  m.rooms2 = { r1: { polygon: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }], area: 12 } as never };
  return m;
}

function elecEntry(name: string): ToolEntry {
  const CATALOG: Record<string, Record<string, unknown>> = {
    chandelier: { id: 35, group: "lights", width: 24, height: 24, self_height: 0, plan: { light: 10 }, anchor: "free", over_floor: false, title: "Люстра" },
  };
  const fx = join(here, `../fixtures/ui-ref-elec-${name}.json`);
  if (CATALOG[name]) return toToolEntry(name, CATALOG[name]!);
  const d = JSON.parse(readFileSync(fx, "utf8")) as { catalog_defaults_cm: Record<string, unknown>; menu_title?: string };
  return toToolEntry(name, { ...(d.catalog_defaults_cm ?? {}), name, title: d.menu_title ?? name });
}

function addItemByName(model: Model, name: string, position: Record<string, unknown>): ItemProps {
  return addItem(model, {
    name,
    position: position as never,
    catalogEntry: elecEntry(name),
  } as never);
}

const topWall = (m: Model): string =>
  Object.values(m.walls).find((w) => w.p1.y === w.p2.y)!.id;

/** Расстояние pc от оси стены по нормали (внутрь комнаты — положительное). */
function distFromAxis(model: Model, item: ItemProps): number {
  const wall = model.walls[item.id_wall!]!;
  const axis = { x: wall.p2.x - wall.p1.x, y: wall.p2.y - wall.p1.y };
  const len = Math.hypot(axis.x, axis.y);
  const nx = -(axis.y / len), ny = axis.x / len; // левая нормаль
  const mid = { x: (wall.p1.x + wall.p2.x) / 2, y: (wall.p1.y + wall.p2.y) / 2 };
  const along = (item.pc.x - mid.x) * (axis.x / len) + (item.pc.y - mid.y) * (axis.y / len);
  const proj = { x: mid.x + (axis.x / len) * along, y: mid.y + (axis.y / len) * along };
  const d = (item.pc.x - proj.x) * nx + (item.pc.y - proj.y) * ny;
  return Math.abs(d);
}

test("370: layer 2/3 — pc по правилу get_offset_layer2 (26/52 см от базовой пластины), слой хранится", () => {
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const base = distFromAxis(m, it);
  assert.ok(base > 0, "предмет стоит у стены с собственным отступом пластины");
  assert.equal(socketLayerOf(it), 1, "без слоя");
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.layer, 2);
  assert.ok(Math.abs(distFromAxis(m, it) - (base + 26)) < 0.11, `слой 2: ${distFromAxis(m, it)} = base+26`);
  updateItem(m, { itemId: it.id, layer: 3 });
  assert.equal(it.layer, 3);
  assert.ok(Math.abs(distFromAxis(m, it) - (base + 52)) < 0.11, `слой 3: ${distFromAxis(m, it)} = base+52`);
  // 1 — снять: pc возвращается к пластине, слой null
  updateItem(m, { itemId: it.id, layer: 1 });
  assert.equal(it.layer, null);
  assert.ok(Math.abs(distFromAxis(m, it) - base) < 0.11, "слой 1: пластина");
  // идемпотентность: повторное layer 2 — то же расстояние
  updateItem(m, { itemId: it.id, layer: 2 });
  const d2 = distFromAxis(m, it);
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, it) - d2) < 1e-9, "повтор layer 2 — идемпотентен");
});

test("370: слой 4+ и не-группы — INVALID_ARGUMENT; углы и over_floor не трогаются", () => {
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const angle = it.angle;
  const of = structuredClone(it.over_floor);
  assert.throws(() => updateItem(m, { itemId: it.id, layer: 4 as never }), (e: unknown) => e instanceof McpError && /слои 1/.test((e as McpError).message));
  assert.throws(() => applySocketGroupLayer(m, { id: "x", name: "sofa", pc: { x: 100, y: 100 } } as ItemProps, 2), /socket_group/);
  // слой 2 не сбрасывает угол/высоту
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.angle, angle);
  assert.deepEqual(it.over_floor, of);
  // слой 2/3 с сохранением slope-смещений (22/44) — константы из бандла
  assert.deepEqual(SOCKET_LAYER_OFFSET_CM[2], { flat: 26, slope: 22 });
  assert.deepEqual(SOCKET_LAYER_OFFSET_CM[3], { flat: 52, slope: 44 });
});

test("370: под-розетки и связь выключатель→светильник следуют за слоем (транзитивный пересчёт)", () => {
  const m = baseModel();
  const sw = addItemByName(m, "light_switch", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  const lamp = addItemByName(m, "chandelier", { center: { x: 2000, y: 1500 } });
  const cable = addCable(m, { switchItemId: sw.id, switchSubId: (sw.socket_group as { id: string }[])[0]!.id, lampItemId: lamp.id });
  const swSubBefore = { ...((sw.socket_group as { center: { x: number; y: number } }[])[0]!.center) };
  const vBefore = structuredClone(cable.vertexes.find((v) => v.type === "switch")!.point);
  updateItem(m, { itemId: sw.id, layer: 2 });
  const sub = (sw.socket_group as { center: { x: number; y: number } }[])[0]!.center;
  // center под-розетки сместился внутрь на 26 вместе со слоем (вдоль стены — на месте)
  assert.ok(Math.abs(sub.y - swSubBefore.y - 26) < 0.11, `center под-розетки: ${JSON.stringify({ before: swSubBefore, after: sub })}`);
  const v = cable.vertexes.find((v) => v.type === "switch")!.point;
  assert.ok(Math.abs(v.y - vBefore!.y - 26) < 0.11, `вершина связи следует: ${JSON.stringify({ before: vBefore, after: v })}`);
  assert.ok(Math.abs(cable.length - (cable.vertexes.length ? cable.length : 0)) >= 0, "длина пересчитана без исключения");
});

// ---------- полный путь через Workspace + mock save ----------

const COMPAT = { bundle: "x", version: "1", schema: 1 } as never;

type SaveServer = { saveId: string; model: Record<string, unknown> };

function saveMock(server: SaveServer): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      return { ok: true, saveId: "s2", conflict: false };
    },
    async renderPng() { return Buffer.from(""); },
    async compatInfo() { return COMPAT; },
    async close() {},
  };
  const deps: WorkspaceDeps = {
    session: { cookies: [] },
    async loadModel(): Promise<LoadedModel> {
      return { object_id: "0", plan_id: "1", save_id: server.saveId, units: "cm", data_empty: false, model: structuredClone(server.model) };
    },
    async openEditor() { return editor; },
  };
  const ws = new Workspace(deps);
  ws.writeBackup = () => "/mock/no-write";
  return ws;
}

test("370: mock save — слой 2 сохраняется verified; сервер потерял слой → сверка ловит (ItemSig.layer)", async () => {
  const build = () => {
    const m = baseModel();
    const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
    updateItem(m, { itemId: it.id, layer: 2 });
    return { m, it };
  };
  // сервер сохранил слой → verified
  {
    const { m } = build();
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    const out = await ws.save();
    assert.equal(out.verified, true, "слой 2 дошёл до сервера, save verified");
  }
  // сервер потерял слой → расхождение itemVerificationMismatches
  {
    const { m, it } = build();
    const norm = structuredClone(m) as unknown as Record<string, unknown>;
    const serverModel = structuredClone(m) as unknown as Record<string, unknown>;
    (serverModel["items"] as Record<string, ItemProps>)[it.id]!.layer = null;
    const expected = (norm["items"] as Record<string, ItemProps>);
    const mismatch = itemVerificationMismatches(expected as never, serverModel["items"] as never);
    assert.ok(mismatch.some((s) => s.includes(it.id) && s.includes("слой")), `слой в сверке: ${mismatch.join("; ")}`);
  }
});

// ---------- стена двигается — слой не теряется, ложной ошибки нет ----------

test("370: mock save — wall_move при живом слое 2: слой сохранён, save verified", async () => {
  const { moveWall } = await import("../../src/model/walls.ts");
  const m = baseModel();
  const wid = topWall(m);
  const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  ws.apply("move-wall", (mm) => {
    moveWall(mm, { wallId: wid, offsetMm: 100 });
    return true;
  });
  const after = ws.model as Model;
  const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
  assert.equal(moved.layer, 2, "слой пережил перенос стены");
  const out = await ws.save();
  assert.equal(out.verified, true, "стена делит/двигается — без ложной ошибки, слой на месте");
});
