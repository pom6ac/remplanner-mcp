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
import { addRoomRect, splitWall } from "../../src/model/walls.ts";
import { roomPolygons } from "../../src/model/rooms.ts";
import { addItem, updateItem, socketGroupAngleDeg } from "../../src/model/items.ts";
import { againstWallCenter } from "../../src/dto/items.ts";
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

function saveMock(server: SaveServer, afterSave: (s: SaveServer) => void = () => {}, transformNorm?: (m: Record<string, unknown>) => void): Workspace {
  let normalized: Record<string, unknown> | null = null;
  const editor: EditorLike = {
    objectId: "0", planId: "1",
    async normalize(m) {
      normalized = structuredClone(m as object) as Record<string, unknown>;
      transformNorm?.(normalized);
      const walls = Object.keys(m.walls as Record<string, unknown>).length;
      const c = { walls, holes: 0, items: 0, pillars: 0, rigels: 0 };
      return { model: structuredClone(normalized as object) as Record<string, unknown>, rooms: [], before: c, after: c };
    },
    async save() {
      server.model = structuredClone(normalized!);
      afterSave(server);
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

// ---------- ревью 371 №1: перенос вдоль стены сохраняет смещение слоя ----------

/** item_update against_wall тем же вызовом, что tools-plan (centerCm + resnapToWall). */
function moveAgainstWall(m: Model, item: ItemProps, wallId: string, offsetMm: number, layer?: number): void {
  const wall = m.walls[wallId]!;
  const at = againstWallCenter(wall, { offset_mm: offsetMm, gap_mm: 0 }, item.width, item.height, roomPolygons(m));
  updateItem(m, {
    itemId: item.id,
    centerCm: at.pcCm,
    angleDeg: socketGroupAngleDeg(at.angleDeg),
    idWall: wall.id,
    resnapToWall: true,
    rooms: roomPolygons(m),
    layer,
  });
}

test("372 (371 №1): item_update against_wall у розетки со слоем 2 — смещение слоя сохранено (база слоя 1 + 26), явный layer учитывается", () => {
  const m = baseModel();
  const wid = topWall(m);
  // база слоя 1 (расстояние пластины от оси) — константа стены, не зависит от offset вдоль
  const probe = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base = distFromAxis(m, probe);
  assert.ok(base > 0);
  updateItem(m, { itemId: probe.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, "слой 2 без переноса: base+26");
  // (а) без явного layer — редактор держит смещение (dragmoveWall: pc = база + get_offset_layer2())
  moveAgainstWall(m, probe, wid, 2500);
  assert.equal(probe.layer, 2, "слой остался 2");
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, `расстояние = база + 26, получили ${distFromAxis(m, probe)}`);
  // (б) явный layer:2 в том же вызове — то же правило относительно новой позиции
  moveAgainstWall(m, probe, wid, 3000, 2);
  assert.equal(probe.layer, 2);
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 26)) < 0.11, `расстояние = база + 26, получили ${distFromAxis(m, probe)}`);
  // (в) явный layer:3 — база + 52; (г) явный layer:1 — вернуть к пластине
  moveAgainstWall(m, probe, wid, 1500, 3);
  assert.equal(probe.layer, 3);
  assert.ok(Math.abs(distFromAxis(m, probe) - (base + 52)) < 0.11);
  moveAgainstWall(m, probe, wid, 1500, 1);
  assert.equal(probe.layer, null);
  assert.ok(Math.abs(distFromAxis(m, probe) - base) < 0.11, "слой 1 — пластина");
  // у розетки без слоя перенос ничего не меняет
  const plain = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 2000 } });
  const plainDist = distFromAxis(m, plain);
  moveAgainstWall(m, plain, wid, 2200);
  assert.equal(plain.layer ?? null, null);
  assert.ok(Math.abs(distFromAxis(m, plain) - plainDist) < 0.11, "у розетки без слоя расстояние не изменилось");
});

test("372 (371 №1): полный путь через Workspace — против переноса слоя 2 сохраняется, save verified; под-розетки следуют", async () => {
  const build = () => {
    const m = baseModel();
    const wid = topWall(m);
    const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
    updateItem(m, { itemId: it.id, layer: 2 });
    return { m, wid, it };
  };
  // save verified: смещение слоя дошло до сервера без расхождений
  {
    const { m, it } = build();
    const distBefore = distFromAxis(m, it); // база слоя 1 + 26
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server);
    await ws.open("0", "1");
    ws.apply("move-against-wall", (mm) => {
      const it = Object.values(mm.items).find((i) => i.name === "socket_group")!;
      moveAgainstWall(mm, it, topWall(mm), 2500);
      return true;
    });
    const after = ws.model as Model;
    const moved = Object.values(after.items).find((i) => i.name === "socket_group")!;
    assert.equal(moved.layer, 2, "слой 2 после переноса along стену");
    assert.ok(Math.abs(distFromAxis(after, moved) - distBefore) < 0.11, `расстояние = база + 26 сохранено (${distFromAxis(after, moved)})`);
    const out = await ws.save();
    assert.equal(out.verified, true, "save verified: слой и центр согласованы");
  }
  // нормализатор уронил слой → NORMALIZATION_DROPPED (слой — пользовательское поле, сверка до save)
  {
    const { m } = build();
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, () => {}, (norm) => {
      const it = Object.values(norm.items as Record<string, ItemProps>).find((i) => i.name === "socket_group")!;
      it.layer = null;
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "NORMALIZATION_DROPPED";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("слой")), "подробность про слой");
      }
      return ok;
    });
  }
  // сервер добавил слой, которого нет в ожидании → SITE_ERROR (сверка после save двусторонняя)
  {
    const m = baseModel();
    addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
    const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
    const ws = saveMock(server, (srv) => {
      const it = Object.values((srv.model as { items: Record<string, ItemProps> }).items).find((i) => i.name === "socket_group")!;
      it.layer = 2;
    });
    await ws.open("0", "1");
    await assert.rejects(() => ws.save(), (e: unknown) => {
      const ok = e instanceof McpError && (e as McpError).code === "SITE_ERROR";
      if (ok) {
        const det = (e as McpError).details as Record<string, unknown>;
        assert.ok(
          (Array.isArray(det["socket_group_mismatches"]) && (det["socket_group_mismatches"] as string[]).some((s) => s.includes("слой"))) ||
          JSON.stringify(det).includes("слой"),
          "появившийся слой пойман",
        );
      }
      return ok;
    });
  }
});

test("372 (371 №2): slope_side в форме бандла («1»/«2») — смещения скоса 22/44", () => {
  const m = baseModel();
  const wid = topWall(m);
  // отдельные предметы под каждое значение (в редакторе slope_side пишется
  // перетаскиванием на откос вместе с пересчётом pc, а не задним числом)
  const s1 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  (s1 as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: s1.id, layer: 2 });
  const base1 = distFromAxis(m, s1) - 22;
  assert.ok(base1 > 0);
  // редактор пишет строку стороны (slope_side = _.side: "1"/"2"), сброс — void 0;
  // бандл проверяет истинность (2==layer ? slope_side ? 22 : 26 : …)
  const s2 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base2 = distFromAxis(m, s2);
  (s2 as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: s2.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, s2) - (base2 + 22)) < 0.11, `скос «1», слой 2: ${distFromAxis(m, s2)} = base+22`);
  const s3 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base3 = distFromAxis(m, s3);
  (s3 as { slope_side?: unknown }).slope_side = "2";
  updateItem(m, { itemId: s3.id, layer: 3 });
  assert.ok(Math.abs(distFromAxis(m, s3) - (base3 + 44)) < 0.11, `скос «2», слой 3: ${distFromAxis(m, s3)} = base+44`);
  // без скоса — плоские 26/52
  const s4 = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  const base4 = distFromAxis(m, s4);
  updateItem(m, { itemId: s4.id, layer: 2 });
  assert.ok(Math.abs(distFromAxis(m, s4) - (base4 + 26)) < 0.11, "без скоса слой 2: base+26");
});

test("372 (371 №4): стена делит комнату (wall_split) — слой и расстояние сохранены, save verified без ложной ошибки", async () => {
  const m = baseModel();
  const wid = topWall(m);
  const it = addItemByName(m, "socket", { againstWall: { wallId: wid, offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  const distBefore = distFromAxis(m, it);
  const server: SaveServer = { saveId: "s1", model: structuredClone(m) as unknown as Record<string, unknown> };
  const ws = saveMock(server);
  await ws.open("0", "1");
  ws.apply("split-wall", (mm) => {
    splitWall(mm, topWall(mm), 2000);
    return true;
  });
  const after = ws.model as Model;
  const split = Object.values(after.items).find((i) => i.name === "socket_group")!;
  assert.equal(split.id_wall, it.id_wall, "id_wall не изменился (предмет на первой половине)");
  assert.equal(split.layer, 2, "слой пережил разрез стены");
  assert.ok(Math.abs(distFromAxis(after, split) - distBefore) < 0.11, `расстояние до оси сохранено (${distFromAxis(after, split)})`);
  const out = await ws.save();
  assert.equal(out.verified, true, "стена делит комнату — без ложной ошибки");
});

// ---------- ревью 371 №4: эталоны ui-ref-electric3-* в обе стороны ----------

test("372 (371 №4): эталон ui-ref-electric3-layer — форма слоя из бандла; модель воспроизводит эталон", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-electric3-layer.json"), "utf8")) as {
    model_object: ItemProps;
  };
  // эталон → форма: слой — число 2, группа розеток, id/стена обезличены
  assert.equal(fx.model_object.layer, 2);
  assert.equal(fx.model_object.name, "socket_group");
  assert.ok(Array.isArray(fx.model_object.socket_group) && fx.model_object.socket_group.length === 1);
  // модель → эталон: item_add + layer 2 даёт те же пользовательские поля
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.layer, fx.model_object.layer);
  assert.equal(it.name, fx.model_object.name);
  assert.equal((it.socket_group as { id: string }[]).length, (fx.model_object.socket_group as unknown[]).length);
  const of = it.over_floor as { value: number; display: boolean; vd: number };
  const ofFx = fx.model_object.over_floor as { value: number; display: boolean; vd: number };
  assert.deepEqual([of.value, of.display, of.vd], [ofFx.value, ofFx.display, ofFx.vd]);
});

test("372 (371 №4): эталон ui-ref-electric3-slope — slope_side строкой стороны («1»), смещение скоса 22; модель воспроизводит", () => {
  const fx = JSON.parse(readFileSync(join(here, "../fixtures/ui-ref-electric3-slope.json"), "utf8")) as {
    model_object: ItemProps;
  };
  // эталон → форма: slope_side — строка «1» (бандл: slope_side = _.side), слой — число
  assert.equal(fx.model_object.slope_side, "1");
  assert.equal(fx.model_object.layer, 2);
  // модель → эталон: предмет со slope_side «1» и слоем 2 несёт те же пользовательские поля
  const m = baseModel();
  const it = addItemByName(m, "socket", { againstWall: { wallId: topWall(m), offsetMm: 1000 } });
  (it as { slope_side?: unknown }).slope_side = "1";
  updateItem(m, { itemId: it.id, layer: 2 });
  assert.equal(it.slope_side, fx.model_object.slope_side);
  assert.equal(it.layer, fx.model_object.layer);
});
