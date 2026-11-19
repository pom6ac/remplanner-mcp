/**
 * Golden-кейсы для верификаторов сущностей (этап 184, C2): чистые функции сверок
 * после save. Модуль общий для теста и генератора снапшота: верификаторы
 * передаются объектом, чтобы снапшот можно было снять ДО рефакторинга (из
 * src/workspace.ts) и сверить ПОСЛЕ (из src/verify/) побайтно.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wallAxisSegments } from "../../src/model/walls.ts";

export type GoldenVerifiers = {
  missingIds(server: Set<string>, local: Set<string>): string[];
  openingIds(model: Record<string, unknown>): Set<string>;
  wallAxisCoveredBy(wall: { p1?: { x: number; y: number }; p2?: { x: number; y: number } } | undefined, localSegments: unknown[]): boolean;
  borderMismatchesOf(model: Record<string, unknown>, got: Record<string, unknown>): string[];
  checkBordersAfterNormalize(local: Record<string, unknown>, norm: Record<string, unknown>): string[];
  checkLevelHolesAfterNormalize(local: Record<string, unknown>, norm: Record<string, unknown>): string[];
  stripVertexIdRoom<T>(lines: T): T;
  gasLineGraphMismatches(
    expected: Record<string, unknown>,
    got: Record<string, unknown>,
    entityLabel?: string,
    lenientItemVertices?: boolean,
    itemGeom?: Record<string, unknown>,
  ): string[];
  pipeConnectionMismatches(
    expectedPipes: Record<string, unknown>,
    expectedItems: Record<string, unknown>,
    gotPipes: Record<string, unknown>,
    gotItems: Record<string, unknown>,
    opts?: { onlyKeys?: Set<string> },
  ): string[];
  cableConnectionMismatches(
    expectedCables: Record<string, unknown>,
    expectedItems: Record<string, unknown>,
    gotCables: Record<string, unknown>,
    gotItems: Record<string, unknown>,
    expectedLines?: Record<string, unknown>,
    gotLines?: Record<string, unknown>,
  ): string[];
  cableLinkFormMismatches(expectedItems: Record<string, unknown>, gotItems: Record<string, unknown>): string[];
  socketGroupSubsUserMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  socketGroupSubsDerivedMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  pillarVerificationMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  rigelVerificationMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  itemVerificationMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  wallRoleMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  balconyWallPropertyMismatches(expected: Record<string, unknown>, got: Record<string, unknown>): string[];
  climateGraphMismatches(
    local: Record<string, unknown>,
    norm: Record<string, unknown>,
    opts?: {
      mode?: "normalize" | "save";
      roomsExpected?: Record<string, unknown>;
      roomsGot?: Record<string, unknown>;
      itemsExpected?: Record<string, unknown>;
      itemsGot?: Record<string, unknown>;
    },
  ): string[];
};

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8")) as Record<string, unknown>;

/** Клоны коллекций-эталонов из существующих фикстур. */
const clone = <T>(v: T): T => structuredClone(v);

export function runGoldenCases(V: GoldenVerifiers): Record<string, string[]> {
  const cases: Record<string, string[]> = {};

  // --- идентичности и id-разности (плановые фикстуры) ---
  const planModel = load("broken-item-outside.json")["model"] as Record<string, unknown>;
  const corridorModel = load("editor-corridor-3rooms.json")["model"] as Record<string, unknown>;
  const planWalls = planModel["walls"] as Record<string, unknown>;
  const corridorWalls = corridorModel["walls"] as Record<string, unknown>;
  cases["missingIds/plan-vs-corridor"] = V.missingIds(new Set(Object.keys(planWalls)), new Set(Object.keys(corridorWalls)));
  cases["missingIds/empty"] = V.missingIds(new Set(), new Set());
  cases["openingIds/broken-item"] = [...V.openingIds(planModel)].sort();
  cases["openingIds/corridor-empty-holes"] = [...V.openingIds(corridorModel)].sort();

  // --- границы террас/участка ---
  const terraceBorder = load("ui-ref-terrace-border.json")["entity"] as Record<string, unknown>;
  const territoryBorder = load("ui-ref-terrace-territory.json")["entity"] as Record<string, unknown>;
  const bordersLocal: Record<string, unknown> = {
    terrace_borders: { "0": terraceBorder },
    territory_borders: { "0": territoryBorder },
  };
  cases["borders/identity"] = V.checkBordersAfterNormalize(clone(bordersLocal), clone(bordersLocal));
  const bordersLost = clone(bordersLocal);
  (bordersLost["terrace_borders"] as Record<string, unknown>) = {};
  cases["borders/terrace-lost"] = V.checkBordersAfterNormalize(clone(bordersLocal), bordersLost);
  const bordersExtra = clone(bordersLocal);
  (bordersExtra["territory_borders"] as Record<string, unknown>)["9"] = { ...clone(territoryBorder), id: "9" };
  cases["borders/territory-extra"] = V.checkBordersAfterNormalize(clone(bordersLocal), bordersExtra);
  const bordersShifted = clone(bordersLocal);
  const shiftedBorder = clone(terraceBorder) as { p1: { x: number }; p2: { x: number } };
  shiftedBorder.p2.x += 5;
  (bordersShifted["terrace_borders"] as Record<string, unknown>)["0"] = shiftedBorder;
  cases["borders/terrace-shifted"] = V.checkBordersAfterNormalize(clone(bordersLocal), bordersShifted);
  cases["borders/borderMismatchesOf-shifted"] = V.borderMismatchesOf(
    { terrace_borders: { "0": terraceBorder }, territory_borders: {} },
    { terrace_borders: { "0": shiftedBorder }, territory_borders: {} },
  );

  // --- проёмы в полу ---
  const hole = load("ui-ref-floorhole-floor_hole.json")["entity"] as Record<string, unknown>;
  const holesLocal: Record<string, unknown> = { level_holes: { "0": clone(hole) } };
  cases["level-holes/identity"] = V.checkLevelHolesAfterNormalize(clone(holesLocal) as never, clone(holesLocal) as never);
  const holesLost = clone(holesLocal);
  holesLost["level_holes"] = {};
  cases["level-holes/lost"] = V.checkLevelHolesAfterNormalize(clone(holesLocal) as never, holesLost as never);
  const holesShifted = clone(holesLocal);
  (((holesShifted["level_holes"] as Record<string, unknown>)["0"] as Record<string, unknown>)["polygon"] as { x: number }[])[0]!.x += 3;
  cases["level-holes/polygon-shifted"] = V.checkLevelHolesAfterNormalize(clone(holesLocal) as never, holesShifted as never);

  // --- газовые линии-графы ---
  const gasLine = clone(load("ui-ref-comm-gas_line.json")["model_object"]) as Record<string, unknown>;
  const gas = { "0": gasLine };
  cases["gas-graph/identity"] = V.gasLineGraphMismatches(clone(gas), clone(gas));
  cases["gas-graph/missing"] = V.gasLineGraphMismatches(clone(gas), {});
  const gasExtra = { "0": clone(gasLine), "9": { ...clone(gasLine), id: "9" } };
  cases["gas-graph/extra"] = V.gasLineGraphMismatches(clone(gas), gasExtra);
  const gasVertexShift = clone(gas);
  (((gasVertexShift["0"] as Record<string, unknown>)["vertexes"] as Record<string, unknown>[])[1]!["point"] as Record<string, number>)["x"]! += 5;
  cases["gas-graph/vertex-shifted"] = V.gasLineGraphMismatches(clone(gas), gasVertexShift);
  const gasMatrixLost = clone(gas);
  ((gasMatrixLost["0"] as Record<string, unknown>)["matrix"] as unknown[][])[0]![1] = null;
  cases["gas-graph/matrix-edge-lost"] = V.gasLineGraphMismatches(clone(gas), gasMatrixLost);
  const gasMatrixLen = clone(gas);
  ((gasMatrixLen["0"] as Record<string, unknown>)["matrix"] as unknown[][])[0]![1] = { length: 9 };
  cases["gas-graph/matrix-length-changed"] = V.gasLineGraphMismatches(clone(gas), gasMatrixLen);
  const gasLoop = clone(gas);
  ((gasLoop["0"] as Record<string, unknown>)["matrix"] as unknown[][])[0]![0] = { length: 1 };
  cases["gas-graph/loop-added"] = V.gasLineGraphMismatches(clone(gas), gasLoop);
  // ревью 185 №1: type-changed мутирует СВОЮ копию gasType (раньше — уже испорченный
  // gasVertexShift, кейс смешивал две ошибки), мёртвая переменная удалена
  const gasType = clone(gas);
  ((gasType["0"] as Record<string, unknown>)["type"] = "water_pipe");
  cases["gas-graph/type-changed"] = V.gasLineGraphMismatches(clone(gas), gasType);
  const gasPlan = clone(gas);
  (gasPlan["0"] as Record<string, unknown>)["plan"] = "b";
  cases["gas-graph/plan-changed"] = V.gasLineGraphMismatches(clone(gas), gasPlan);
  const gasItems = clone(gas);
  ((gasItems["0"] as Record<string, unknown>)["items"] as Record<string, unknown>)["2"] = "other";
  cases["gas-graph/items-value-changed"] = V.gasLineGraphMismatches(clone(gas), gasItems);
  const gasCount = clone(gas);
  ((gasCount["0"] as Record<string, unknown>)["vertexes"] as unknown[]).pop();
  cases["gas-graph/vertex-count-mismatch"] = V.gasLineGraphMismatches(clone(gas), gasCount);
  // переименование свободного узла: id нет на другой стороне — сопоставление по геометрии
  const gasRenamed = clone(gas);
  const renamedLine = gasRenamed["0"] as Record<string, unknown>;
  ((renamedLine["vertexes"] as Record<string, unknown>[])[1]!)["id"] = "77";
  const renamedItems = (renamedLine["items"] as Record<string, unknown>);
  renamedItems["77"] = renamedItems["2"];
  delete renamedItems["2"];
  cases["gas-graph/node-id-renamed-geom-match"] = V.gasLineGraphMismatches(clone(gas), gasRenamed);

  // --- световые линии и stripVertexIdRoom ---
  const ledColl = { "0": clone(load("ui-ref-light-led_strip.json")["model_object"]) as Record<string, unknown> };
  const ledStripped = clone(V.stripVertexIdRoom(clone(ledColl))) as Record<string, unknown>;
  cases["led-graph/identity"] = V.gasLineGraphMismatches(clone(V.stripVertexIdRoom(clone(ledColl))) as Record<string, unknown>, clone(ledStripped), "светодиодная лента");
  cases["led-graph/id-room-not-stripped"] = V.gasLineGraphMismatches(clone(ledColl) as Record<string, unknown>, ledStripped, "светодиодная лента");

  // --- трубы водоснабжения: мягкие вершины-предметы и диапазон длины ---
  const waterPipe = clone(load("ui-ref-plumb-pipe.json")["model_object"]) as Record<string, unknown>;
  const water = { "0": waterPipe };
  const waterItemGeom = {
    i1: { pc: { x: 100, y: 100 }, width: 16, height: 9, angle: 0 },
    i2: { pc: { x: 300, y: 100 }, width: 16, height: 9, angle: 0 },
  };
  cases["water-pipe/identity"] = V.gasLineGraphMismatches(clone(water), clone(water), "труба");
  const waterShiftSmall = clone(water);
  (((waterShiftSmall["0"] as Record<string, unknown>)["vertexes"] as Record<string, unknown>[])[0]!["point"] as Record<string, number>)["x"]! += 0.05;
  // ревью 185 №2: названия кейсов соответствуют смыслу — lenient вершину-предмет
  // не сверяет по точке вообще (обе пустые), strict при сдвиге в допуске тоже пуст
  cases["water-pipe/lenient-vertex-item-ignored"] = V.gasLineGraphMismatches(clone(water), waterShiftSmall, "труба", true, clone(waterItemGeom));
  const waterShiftBig = clone(water);
  (((waterShiftBig["0"] as Record<string, unknown>)["vertexes"] as Record<string, unknown>[])[0]!["point"] as Record<string, number>)["x"]! += 25;
  cases["water-pipe/lenient-vertex-item-ignored-big-shift"] = V.gasLineGraphMismatches(clone(water), waterShiftBig, "труба", true, clone(waterItemGeom));
  cases["water-pipe/strict-vertex-within-tol"] = V.gasLineGraphMismatches(clone(water), waterShiftSmall, "труба");
  // положительный кейс «строгий сдвиг трубы больше допуска» (ревью 185 №2)
  cases["water-pipe/strict-vertex-beyond-tol"] = V.gasLineGraphMismatches(clone(water), waterShiftBig, "труба");
  // ревью 185 №3: lenient-длина ВНУТРИ диапазона точек подключения — пусто
  const waterLenInRange = clone(water);
  (waterLenInRange["0"] as Record<string, unknown>)["length"] = 2.05;
  cases["water-pipe/lenient-length-within-range"] = V.gasLineGraphMismatches(clone(water), waterLenInRange, "труба", true, clone(waterItemGeom));
  const waterLong = clone(water);
  (waterLong["0"] as Record<string, unknown>)["length"] = 5;
  cases["water-pipe/lenient-length-out-of-range"] = V.gasLineGraphMismatches(clone(water), waterLong, "труба", true, clone(waterItemGeom));

  // --- подключения труба↔предмет ---
  const waterspot = clone(load("ui-ref-plumb-waterspot.json")["model_object"]) as Record<string, unknown>;
  waterspot["id"] = "i2";
  waterspot["pipes"] = { water_pipe_id: "0" };
  const multiItem = { name: "waterspot_collector", pipes: { water_pipe_id: ["0"] } };
  const connExpItems = { i1: clone(multiItem), i2: clone(waterspot) };
  cases["pipe-conn/identity"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), clone(connExpItems));
  const connLost = clone(connExpItems);
  (connLost["i2"] as Record<string, unknown>)["pipes"] = {};
  cases["pipe-conn/back-ref-lost"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), connLost);
  const connExtra = clone(connExpItems);
  (connExtra["i1"] as Record<string, unknown>)["pipes"] = { water_pipe_id: ["0"] };
  (connExtra["i2"] as Record<string, unknown>)["pipes"] = { water_pipe_id: ["0"], water_hot_pipe_id: "0" };
  cases["pipe-conn/extra-links"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), connExtra);
  const connWrongKind = clone(connExpItems);
  (connWrongKind["i2"] as Record<string, unknown>)["pipes"] = { warm_floor_pipe_id: "0" };
  cases["pipe-conn/wrong-kind-link"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), connWrongKind);
  const connMultiScalar = clone(connExpItems);
  (connMultiScalar["i1"] as Record<string, unknown>)["pipes"] = { water_pipe_id: "0" };
  cases["pipe-conn/multi-scalar-violation"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), connMultiScalar);
  const connScalarArray = clone(connExpItems);
  (connScalarArray["i2"] as Record<string, unknown>)["pipes"] = { water_pipe_id: ["0"] };
  cases["pipe-conn/scalar-array-violation"] = V.pipeConnectionMismatches(clone(water), clone(connExpItems), clone(water), connScalarArray);
  cases["pipe-conn/climate-only-keys"] = V.pipeConnectionMismatches(
    clone(water), clone(connExpItems), clone(water), clone(connExpItems),
    { onlyKeys: new Set(["warm_floor_pipe_id"]) },
  );

  // --- под-розетки socket_group ---
  const switchItem = clone(load("ui-ref-elec-light_switch.json")["model_object"]) as Record<string, unknown>;
  const socketItem = clone(load("ui-ref-elec-socket.json")["model_object"]) as Record<string, unknown>;
  const subs = { "0": switchItem };
  cases["subs-user/identity"] = V.socketGroupSubsUserMismatches(clone(subs), clone(subs));
  const subsLost = clone(subs);
  delete (subsLost["0"] as Record<string, unknown>)["socket_group"];
  cases["subs-user/group-lost"] = V.socketGroupSubsUserMismatches(clone(subs), subsLost);
  const subsCount = clone(subs);
  ((subsCount["0"] as Record<string, unknown>)["socket_group"] as unknown[]).pop();
  cases["subs-user/count-changed"] = V.socketGroupSubsUserMismatches(clone(subs), subsCount);
  const subsType = clone(subs);
  (((subsType["0"] as Record<string, unknown>)["socket_group"] as Record<string, unknown>[])[0]!)["name"] = "socket";
  cases["subs-user/type-changed"] = V.socketGroupSubsUserMismatches(clone(subs), subsType);
  const subsOverLost = clone(subs);
  ((subsOverLost["0"] as Record<string, unknown>)["over_floor"] = {});
  cases["subs-user/over-floor-lost"] = V.socketGroupSubsUserMismatches(clone(subs), subsOverLost);
  const subsOverChanged = clone(subs);
  (((subsOverChanged["0"] as Record<string, unknown>)["over_floor"] as Record<string, unknown>)["value"] = 95);
  cases["subs-user/over-floor-changed"] = V.socketGroupSubsUserMismatches(clone(subs), subsOverChanged);
  cases["subs-derived/identity"] = V.socketGroupSubsDerivedMismatches(clone(subs), clone(subs));
  const subsCenter = clone(subs);
  (((subsCenter["0"] as Record<string, unknown>)["socket_group"] as Record<string, unknown>[])[0]!)["center"] = { x: 210, y: -283 };
  cases["subs-derived/center-shifted"] = V.socketGroupSubsDerivedMismatches(clone(subs), subsCenter);
  const subsVd = clone(subs);
  (((subsVd["0"] as Record<string, unknown>)["over_floor"] as Record<string, unknown>)["vd"] = 100);
  cases["subs-derived/vd-changed"] = V.socketGroupSubsDerivedMismatches(clone(subs), subsVd);
  cases["subs-user/socket-item"] = V.socketGroupSubsUserMismatches({ s: socketItem }, { s: clone(socketItem) });

  // --- связи «выключатель → светильник» ---
  const cableFixture = load("ui-ref-elec-cable.json");
  const cable = clone(cableFixture["model_cable"]) as Record<string, unknown>;
  const cableSwitch = clone(cableFixture["switch_item"]) as Record<string, unknown>;
  const cableLamp = clone(cableFixture["lamp_item"]) as Record<string, unknown>;
  const cables = { id1: cable };
  const cableItems = { id2: cableSwitch, id4: cableLamp };
  cases["cables-conn/identity"] = V.cableConnectionMismatches(clone(cables), clone(cableItems), clone(cables), clone(cableItems));
  cases["cables-conn/cable-missing"] = V.cableConnectionMismatches(clone(cables), clone(cableItems), {}, clone(cableItems));
  const cableLampNoRef = clone(cableItems);
  delete (cableLampNoRef["id4"] as Record<string, unknown>)["cables"];
  cases["cables-conn/lamp-ref-lost"] = V.cableConnectionMismatches(clone(cables), clone(cableItems), clone(cables), cableLampNoRef);
  const cableExtraHolder = clone(cableItems) as Record<string, Record<string, unknown>>;
  (cableExtraHolder["id9"] as Record<string, unknown>) = { name: "lamp", id: "id9", cables: { cable_id: "id1" } };
  cases["cables-conn/extra-holder"] = V.cableConnectionMismatches(clone(cables), clone(cableItems), clone(cables), cableExtraHolder);
  const cableSubLink = clone(cableItems);
  ((cableSubLink["id2"] as Record<string, unknown>)["socket_group"] as Record<string, unknown>[]).push({
    name: "socket", id: "id5", cables: { cable_id: ["id1"] },
  });
  cases["cables-conn/sub-not-switch"] = V.cableConnectionMismatches(clone(cables), clone(cableItems), clone(cables), cableSubLink);
  cases["cables-form/identity"] = V.cableLinkFormMismatches(clone(cableItems), clone(cableItems));
  const cableFormArray = clone(cableItems);
  (cableFormArray["id4"] as Record<string, unknown>)["cables"] = { cable_id: ["id1"] };
  cases["cables-form/lamp-form-changed"] = V.cableLinkFormMismatches(clone(cableItems), cableFormArray);
  const cableFormScalar = clone(cableItems);
  (((cableFormScalar["id2"] as Record<string, unknown>)["socket_group"] as Record<string, unknown>[])[0]!)["cables"] = { cable_id: "id1" };
  cases["cables-form/sub-form-changed"] = V.cableLinkFormMismatches(clone(cableItems), cableFormScalar);
  // ревью 185 №3: вершина-линия разрешается по коллекциям световых линий
  // (expectedLines/gotLines, ревью 90 R2) — identity и пропуск линии
  const cableLine = clone(cable) as Record<string, unknown>;
  (cableLine["vertexes"] as unknown[]).push({ id: "l1", point: { x: 220, y: 100 }, type: "led_strip" });
  const cableLineItems = clone(cableItems);
  const cableLines = { led_strips: { l1: { id: "l1", name: "led" } } };
  cases["cables-conn/line-vertex-found"] = V.cableConnectionMismatches(
    { id1: clone(cableLine) }, clone(cableLineItems), { id1: clone(cableLine) }, clone(cableLineItems),
    clone(cableLines), clone(cableLines),
  );
  cases["cables-conn/line-not-found"] = V.cableConnectionMismatches(
    { id1: clone(cableLine) }, clone(cableLineItems), { id1: clone(cableLine) }, clone(cableLineItems),
    clone(cableLines), { led_strips: {} },
  );

  // --- колонны ---
  const pillar = clone(load("ui-ref-pillar-wall.json")["model_object"]) as Record<string, unknown>;
  const pillars = { "0": pillar };
  cases["pillars/identity"] = V.pillarVerificationMismatches(clone(pillars), clone(pillars));
  cases["pillars/missing"] = V.pillarVerificationMismatches(clone(pillars), {});
  const pillarShifted = clone(pillars);
  ((pillarShifted["0"] as Record<string, unknown>)["pc"] as Record<string, number>)["x"]! += 5;
  cases["pillars/pc-shifted"] = V.pillarVerificationMismatches(clone(pillars), pillarShifted);
  // ревью 185 №1: мёртвая переменная pillarAngle удалена (кейс пользуется pillarAngleChanged)
  cases["pillars/angle-changed"] = V.pillarVerificationMismatches(clone(pillars), pillarAngleChanged(pillars));
  const pillarRole = clone(pillars);
  (pillarRole["0"] as Record<string, unknown>)["role"] = "wall";
  cases["pillars/role-changed"] = V.pillarVerificationMismatches(clone(pillars), pillarRole);

  // --- ригели ---
  const rigel = clone(load("ui-ref-rigel-wall.json")["model_object"]) as Record<string, unknown>;
  const rigels = { "0": rigel };
  cases["rigels/identity"] = V.rigelVerificationMismatches(clone(rigels), clone(rigels));
  cases["rigels/missing"] = V.rigelVerificationMismatches(clone(rigels), {});
  const rigelDepth = clone(rigels);
  (rigelDepth["0"] as Record<string, unknown>)["depth"] = 31;
  cases["rigels/depth-changed"] = V.rigelVerificationMismatches(clone(rigels), rigelDepth);
  const rigelCeil = clone(rigels);
  (rigelCeil["0"] as Record<string, unknown>)["ceiling_type"] = "stretch";
  cases["rigels/ceiling-type-changed"] = V.rigelVerificationMismatches(clone(rigels), rigelCeil);

  // --- предметы ---
  const item = clone(Object.values(planModel["items"] as Record<string, unknown>)[0]) as Record<string, unknown>;
  const items = { iout1: item };
  cases["items/identity"] = V.itemVerificationMismatches(clone(items), clone(items));
  cases["items/missing"] = V.itemVerificationMismatches(clone(items), {});
  const itemsType = clone(items);
  (itemsType["iout1"] as Record<string, unknown>)["name"] = "bed";
  cases["items/type-changed"] = V.itemVerificationMismatches(clone(items), itemsType);
  const itemsPc = clone(items);
  ((itemsPc["iout1"] as Record<string, unknown>)["pc"] as Record<string, number>)["x"]! += 5;
  cases["items/pc-shifted"] = V.itemVerificationMismatches(clone(items), itemsPc);
  const itemsAngle = clone(items);
  (itemsAngle["iout1"] as Record<string, unknown>)["angle"] = 90;
  cases["items/angle-changed"] = V.itemVerificationMismatches(clone(items), itemsAngle);

  // --- роли стен и свойства ограждений ---
  cases["wall-roles/identity"] = V.wallRoleMismatches(clone(planWalls), clone(planWalls));
  const wallRoleChanged = clone(planWalls);
  (Object.values(wallRoleChanged)[0] as Record<string, unknown>)["role"] = "partition";
  cases["wall-roles/role-changed"] = V.wallRoleMismatches(clone(planWalls), wallRoleChanged);
  const wallRenamed = clone(planWalls) as Record<string, Record<string, unknown>>;
  const firstId = Object.keys(wallRenamed)[0]!;
  wallRenamed["renamed-1"] = { ...wallRenamed[firstId]!, id: "renamed-1" };
  delete wallRenamed[firstId];
  cases["wall-roles/renamed-same-role"] = V.wallRoleMismatches(clone(planWalls), wallRenamed);
  const wallRenamedRole = clone(wallRenamed);
  (wallRenamedRole["renamed-1"] as Record<string, unknown>)["role"] = "partition";
  cases["wall-roles/renamed-role-changed"] = V.wallRoleMismatches(clone(planWalls), wallRenamedRole);

  const balconyWalls = clone(load("ui-ref-balcony.json")["balcony_walls"]) as Record<string, unknown>;
  cases["balcony-props/identity"] = V.balconyWallPropertyMismatches(clone(balconyWalls), clone(balconyWalls));
  const balconyHeight = clone(balconyWalls);
  (Object.values(balconyHeight)[0] as Record<string, unknown>)["height"] = 120;
  cases["balcony-props/height-changed"] = V.balconyWallPropertyMismatches(clone(balconyWalls), balconyHeight);
  const balconyMaterial = clone(balconyWalls);
  (Object.values(balconyMaterial)[0] as Record<string, unknown>)["material"] = "brick";
  cases["balcony-props/material-changed"] = V.balconyWallPropertyMismatches(clone(balconyWalls), balconyMaterial);
  const balconyMoved = clone(balconyWalls);
  const movedWall = Object.values(balconyMoved)[0] as Record<string, unknown>;
  movedWall["p1"] = { x: 900, y: 900 };
  movedWall["p2"] = { x: 950, y: 950 };
  cases["balcony-props/not-covered"] = V.balconyWallPropertyMismatches(clone(balconyWalls), balconyMoved);

  // --- покрытие оси стены (помощник save-сверки стен) ---
  const planSegments = wallAxisSegments(planWalls as never);
  const corridorSegments = wallAxisSegments(corridorWalls as never);
  cases["wall-axis-covered/same"] = [String(V.wallAxisCoveredBy(planWalls[Object.keys(planWalls)[0]!] as never, planSegments))];
  cases["wall-axis-covered/foreign"] = [String(V.wallAxisCoveredBy(planWalls[Object.keys(planWalls)[0]!] as never, corridorSegments))];
  cases["wall-axis-covered/undefined"] = [String(V.wallAxisCoveredBy(undefined, planSegments))];

  // --- климат: контуры тёплого пола и трубы климата ---
  const warmFloor = clone(load("ui-ref-climate-wf-warm_floor.json")["model_object"]) as Record<string, unknown>;
  const climatePipe = clone(load("ui-ref-pipe-warm_floor_pipe.json")["model_object"]) as Record<string, unknown>;
  const climateLocal: Record<string, unknown> = {
    warm_floors: { "0": warmFloor },
    pipes_warm_floor: { "0": climatePipe },
  };
  cases["climate/identity"] = V.climateGraphMismatches(clone(climateLocal), clone(climateLocal));
  const climateWfChanged = clone(climateLocal);
  (((climateWfChanged["warm_floors"] as Record<string, unknown>)["0"] as Record<string, unknown>)["polygon"] as { x: number }[])[0]!.x += 5;
  cases["climate/warm-floor-polygon-changed"] = V.climateGraphMismatches(clone(climateLocal), climateWfChanged);
  const climatePipeLost = clone(climateLocal);
  climatePipeLost["pipes_warm_floor"] = {};
  cases["climate/pipe-lost"] = V.climateGraphMismatches(clone(climateLocal), climatePipeLost);
  const climatePipeLen = clone(climateLocal);
  ((climatePipeLen["pipes_warm_floor"] as Record<string, unknown>)["0"] as Record<string, unknown>)["length"] = 9;
  cases["climate/pipe-length-changed"] = V.climateGraphMismatches(clone(climateLocal), climatePipeLen);
  const climateItemsExp = { n1: { name: "radiator", pipes: { warm_floor_pipe_id: "0" } } };
  cases["climate/item-refs-identity"] = V.climateGraphMismatches(clone(climateLocal), clone(climateLocal), {
    itemsExpected: clone(climateItemsExp),
    itemsGot: clone(climateItemsExp),
  });
  cases["climate/item-refs-lost"] = V.climateGraphMismatches(clone(climateLocal), clone(climateLocal), {
    itemsExpected: clone(climateItemsExp),
    itemsGot: { n1: { name: "radiator", pipes: {} } },
  });
  // ревью 185 №3: режим normalize (ревью 124 R1) — привязка контура к комнате
  // по геометрии, ID комнат штатно регенерируются: id_room сменился на новую
  // комнату с тем же полигоном — штатно; комнаты нет — расхождение
  const climateNormGot = clone(climateLocal);
  (((climateNormGot["warm_floors"] as Record<string, unknown>)["0"] as Record<string, unknown>)["id_room"] = "room_regenerated_1");
  const wfPolygon = (((climateLocal["warm_floors"] as Record<string, unknown>)["0"] as Record<string, unknown>)["polygon"]);
  const climateRooms = { "0": { polygon: structuredClone(wfPolygon) } };
  cases["climate/normalize-id-room-regenerated"] = V.climateGraphMismatches(clone(climateLocal), climateNormGot, {
    mode: "normalize",
    roomsExpected: clone(climateRooms),
    roomsGot: { room_regenerated_1: { polygon: structuredClone(wfPolygon) } },
  });
  cases["climate/normalize-id-room-room-missing"] = V.climateGraphMismatches(clone(climateLocal), climateNormGot, {
    mode: "normalize",
    roomsExpected: clone(climateRooms),
    roomsGot: {},
  });

  return cases;
}

function pillarAngleChanged(p: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out = clone(p);
  out["0"]!["angle"] = 10;
  return out;
}
