// Save-оркестрация (аудит 65 C2, план п.11 «save orchestration», задача 192-c2s п.2):
// последовательность сверка save_id → will_delete/warnings → backup → normalize →
// предсохранительные сверки → save (с повтором) → верификация по GET — перенесена из
// src/workspace.ts без изменения поведения (журналы вызовов c2-save-journal — побайтно
// те же). Workspace сохраняет seam WorkspaceDeps/EditorLike и делегирует через SaveHost.
import { McpError, maskSecrets } from "../errors.ts";
import type { EditorRoom } from "../editor/adapter.ts";
import type { Model, Point } from "../model/types.ts";
import { MODEL_ENTITY_COLLECTIONS, PUBLIC_COLLECTION_KEYS, type ModelEntityCollection } from "../model/collections.ts";
import { modelCounts, modelIsContentEmpty, toModel } from "../model/canonical.ts";
import {
  prepareForRestore,
  wallAxisSegments,
  wallAxisSetsEqual,
  wallAxisCoverageCm,
} from "../model/walls.ts";
import { levelHoleMismatches } from "../model/floorhole.ts";
import { finishCompare } from "../model/finish.ts";
import { zoneDelimiterCompare, roomsWithChangedZoneCDividers, resurrectedZoneCDividers } from "../model/zone.ts";
import { ceilingRigelCompare } from "../model/ceiling-rigels.ts";
import { warmWallsCompare } from "../verify/warmwall.ts";
import { demolitionMismatches } from "../model/demolition.ts";
import { roomsSaveCompare, zoneAffectedRoomIds, type RoomsChangePolicy } from "../model/rooms-save.ts";
import { dimsMismatches } from "../model/dims.ts";
import { elecLinkHolders } from "../model/electric2.ts";
import {
  balconyWallPropertyMismatches,
  cableConnectionMismatches,
  elecCableConnectionMismatches,
  cableLinkFormMismatches,
  checkBordersAfterNormalize,
  checkLevelHolesAfterNormalize,
  climateGraphMismatches,
  gasLineGraphMismatches,
  itemVerificationMismatches,
  missingIds,
  openingIds,
  pipeConnectionMismatches,
  pillarVerificationMismatches,
  rigelVerificationMismatches,
  shieldMismatches,
  socketGroupSubsDerivedMismatches,
  socketGroupSubsUserMismatches,
  stripVertexIdRoom,
  wallAxisCoveredBy,
  wallRoleMismatches,
  WATER_PIPE_TYPES,
  type BalconyWallProps,
  type CableLinkItem,
  type ElecLinkItem,
  type ElecCableColl,
  type CableLinkLines,
  type GasLineSig,
  type ItemSig,
  type PipeLinkItem,
  type PillarSig,
  type RigelSig,
  type SubsItemSig,
} from "../verify/index.ts";
import type { EditorLike, OpenProject, WorkspaceDeps } from "../workspace.ts";

export type SaveOutcome = {
  save_id: string;
  save_id_before: string;
  backup_path: string;
  verified: boolean;
  rounds: number;
  /** Сверка с серверной версией перед записью: сколько объектов сервера будет удалено.
   *  Специальные ключи walls/openings; остальные — публичные ключи реестра
   *  MODEL_ENTITY_COLLECTIONS (PUBLIC_COLLECTION_KEYS, газовые линии — gas_lines). */
  will_delete: { walls: number; openings: number } & {
    [K in Exclude<ModelEntityCollection, "walls"> as (typeof PUBLIC_COLLECTION_KEYS)[K]]: number;
  };
  /** Предупреждения (удаления объектов сервера). */
  warnings: string[];
};

/** База сверки комнат: модель с сервера / после последнего успешного save (этап 128).
 *  С ревью 319 №1 — и снимок zone_c-делителей (комнаты с изменённым набором
 *  делителей считаются от той же базы). */
export type RoomSaveBase = {
  rooms: Record<string, unknown>;
  walls: Record<string, { p1: Point; p2: Point; depth?: number }>;
  zoneDelimiters: Record<string, unknown>;
};

/**
 * Доступ save-оркестрации к состоянию workspace. Методы writeBackup/ensureEditor/
 * onVerified/onSaved сохраняют поведение Workspace (переопределение writeBackup
 * в тестах, замена рабочей копии верифицированным ответом, база сверки комнат,
 * сброс истории undo/redo и снимок «saved»).
 */
export type SaveHost = {
  readonly deps: WorkspaceDeps;
  /** Мутабельное состояние открытого проекта (save_id, dirty); null — проект не открыт. */
  readonly project: OpenProject | null;
  /** Проект открыт с пустой моделью (дефект 3, отчёт 11) — защита от затирания. */
  openedEmpty(): boolean;
  /** Каноническая рабочая копия модели. */
  model(): Model;
  setRoomsCache(rooms: EditorRoom[]): void;
  roomSaveBase(): RoomSaveBase | null;
  roomChangePolicy(nowWalls?: Record<string, unknown>): RoomsChangePolicy;
  /** Запущен ли редактор (влияет на семантику SAVE_CONFLICT). */
  hasEditor(): boolean;
  ensureEditor(): Promise<EditorLike>;
  /** Снимок модели в backups/ перед сохранением (метод Workspace — seam для тестов). */
  writeBackup(): string;
  /** Рабочая копия заменена верифицированным ответом сервера; база сверки комнат обновлена. */
  onVerified(model: Model): void;
  /** Сброс истории undo/redo и снимок «saved» (взаимодействие dirty/undo). */
  onSaved(): void;
};

/**
 * Подписи коллекций в предупреждении об удалении объектов сервера
 * (кроме стен и проёмов, у которых свои тексты). Ключи — реестр
 * MODEL_ENTITY_COLLECTIONS без walls (C1, аудит 65).
 */
const ENTITY_DELETE_LABELS: Record<Exclude<ModelEntityCollection, "walls">, string> = {
  items: "предметы",
  pillars: "колонны",
  rigels: "ригели",
  pipes_gas: "газовые линии",
  pipes: "трубы водоснабжения",
  terrace_borders: "границы террас",
  territory_borders: "границы участка",
  level_holes: "проёмы в полу",
  led_strips: "светодиодные ленты",
  stripes_light: "трековые шины",
  line_strips: "линии линейного освещения",
  cables: "соединительные провода",
  cables_socket: "кабели-проводка",
  cables_warm_floor: "провода тёплого пола",
  cables_conditioner: "трассы кондиционеров",
  rulers: "размеры",
  comments: "текстовые комментарии",
  shields: "электрощитки (конструктор)",
  warm_floors: "контуры тёплого пола",
  pipes_warm_floor: "магистрали тёплого пола",
  pipes_conditioner: "дренажи кондиционеров",
  pipes_heat: "магистрали отопления",
  pipes_ventilation: "воздуховоды",
  zone_delimiters: "разделители зон",
};

/**
 * Сохранение: сверка save_id с сервером (SAVE_CONFLICT при расхождении, минуя force),
 * снимок в backups/, нормализация редактором, project.save, проверка по GET
 * (надёжнее save_id — отчёт 05, факт 6) с одним повтором при расхождении.
 * Принудительная запись поверх чужих правок — только при явном force: true.
 */
export async function runSave(host: SaveHost, options: { force?: boolean } = {}): Promise<SaveOutcome> {
  const p = host.project;
  if (!p) throw new McpError("INVALID_ARGUMENT", "проект не открыт");
  const saveIdBefore = p.saveId;
  const fresh = await host.deps.loadModel(host.deps.session, p.objectId, p.planId);
  // Дефект 3 (отчёт 11): защита от затирания непустого сервера пустой моделью —
  // проект, открытый с пустой моделью, сохраняется только с явным force.
  if (
    !options.force && host.openedEmpty() &&
    modelIsContentEmpty(host.model()) && !modelIsContentEmpty(fresh.model as Model)
  ) {
    throw new McpError("SAVE_CONFLICT", "проект был открыт с пустой моделью, а на сервере модель непустая — сохранение удалило бы её объекты", {
      hint: "перечитайте проект (project_open) или сохраните принудительно force: true",
      details: { server: modelCounts(fresh.model) },
    });
  }
  // ревью v0.1.1 №5: предупреждение об удалениях — разность идентичностей (id
  // объектов сервера, которых нет в рабочей копии), а не разность общих счётчиков.
  // Ревью v0.1.1 финал F-1: стена, чья ось покрыта локальными стенами, не потеряна —
  // нормализация редактора могла сменить её идентификатор; это отдельное замечание
  const serverModel = fresh.model as Model;
  const localWallSegments = wallAxisSegments(host.model().walls);
  const serverWallsMissing = missingIds(new Set(Object.keys(serverModel.walls ?? {})), new Set(Object.keys(host.model().walls)));
  const renamedWalls = serverWallsMissing.filter((id) => wallAxisCoveredBy(serverModel.walls?.[id] as { p1: Point; p2: Point } | undefined, localWallSegments));
  const deletedWalls = serverWallsMissing.filter((id) => !renamedWalls.includes(id));
  // Разность идентичностей по всем коллекциям реестра (C1, аудит 65): стены —
  // специальные ключи (renamedWalls, openings), остальные — из
  // MODEL_ENTITY_COLLECTIONS, чтобы новая сущность не выпадала из will_delete
  // (раньше вручную отставали cables/rulers/comments).
  type DeletedIds = Record<"walls" | "renamedWalls" | "openings" | Exclude<ModelEntityCollection, "walls">, string[]>;
  const deletedIds = {} as DeletedIds;
  deletedIds.walls = deletedWalls;
  deletedIds.renamedWalls = renamedWalls;
  deletedIds.openings = missingIds(openingIds(serverModel), openingIds(host.model()));
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    if (key === "walls") continue;
    deletedIds[key] = missingIds(
      new Set(Object.keys(serverModel[key] ?? {})),
      new Set(Object.keys(host.model()[key] ?? {})),
    );
  }
  const willDelete = {} as SaveOutcome["will_delete"];
  willDelete.walls = deletedIds.walls.length;
  willDelete.openings = deletedIds.openings.length;
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    if (key === "walls") continue;
    willDelete[PUBLIC_COLLECTION_KEYS[key]] = deletedIds[key].length;
  }
  const warnings: string[] = [];
  const idList = (ids: string[]): string => `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", …" : ""}`;
  if (willDelete.walls > 0) warnings.push(`будут удалены стены (${willDelete.walls}), которых нет в модели: ${idList(deletedIds.walls)}`);
  if (deletedIds.renamedWalls.length > 0) warnings.push(`идентификаторы стен изменились (${deletedIds.renamedWalls.length}) — геометрия сохранена, это нормализация, а не потеря: ${idList(deletedIds.renamedWalls)}`);
  if (willDelete.openings > 0) warnings.push(`будут удалены проёмы (${willDelete.openings}), которых нет в модели: ${idList(deletedIds.openings)}`);
  for (const key of MODEL_ENTITY_COLLECTIONS) {
    if (key === "walls") continue;
    const pub = PUBLIC_COLLECTION_KEYS[key];
    if (willDelete[pub] > 0) {
      warnings.push(`будут удалены ${ENTITY_DELETE_LABELS[key]} (${willDelete[pub]}), которых нет в модели: ${idList(deletedIds[key])}`);
    }
  }
  if (fresh.save_id !== saveIdBefore) {
    if (!host.hasEditor() && !options.force) {
      throw new McpError(
        "SAVE_CONFLICT",
        `save_id на сервере (${fresh.save_id}) новее рабочей копии (${saveIdBefore}) — проект правился в другом месте`,
        { hint: "перезапишите рабочую копию project_open или сохраните принудительно force: true" },
      );
    }
    // наш собственный редактор легитимно продвигает save_id (автосейвы при
    // инициализации/нормализации, отчёт 05 факт 6): принимаем свежий как базу —
    // реальный чужой конфликт поймает диалог редактора «Сохранить все равно»
    // (adapter.save → conflict) и сверка контента после сохранения
    p.saveId = fresh.save_id;
  }
  const backupPath = host.writeBackup();
  if (!host.hasEditor()) {
    await host.ensureEditor();
  }
  const expected = {
    walls: Object.keys(host.model().walls).length,
    holes: Object.values(host.model().walls).reduce((n, w) => n + Object.keys(w.holes).length, 0),
    // стены — канонический набор осевых отрезков (ревью v0.1.1-r2 R2-3):
    // разрез/слияние коллинеарных стен эквивалентны, сдвиг и лишние стены — нет
    segments: wallAxisSegments(host.model().walls),
    coverage: wallAxisCoverageCm(host.model().walls),
  };
  const editor = await host.ensureEditor();
  const prepared = structuredClone(host.model());
  prepareForRestore(prepared);
  const norm = await editor.normalize(prepared as unknown as Record<string, unknown>);
  if ((norm.rooms ?? []).length > 0) host.setRoomsCache(norm.rooms!);
  // ревью 139 m2: сбой пересчёта комнат в normalize перед save — диагностическое
  // предупреждение в результате save (код без данных пользователя)
  if (norm.roomsRebuild && norm.roomsRebuild !== "ok") {
    warnings.push(maskSecrets(`rooms_recalc_failed: ${norm.roomsRebuild}`));
  }
  // потеря проёмов/предметов — по id в копии редактора (ревью v0.1.1 №4)
  const localOpeningIds = openingIds(host.model());
  const localItemIds = new Set(Object.keys(host.model().items ?? {}));
  const localPillarIds = new Set(Object.keys(host.model().pillars ?? {}));
  // ревью 43 №2/№4: ожидаемые колонны и комнаты для верификации после save.
  // ревью 45 №5: потеря комнат меряется относительно результата нормализации
  // (того, что ушло на save), а не устаревших rooms2 рабочей копии: пользователь
  // мог сам разомкнуть контур — тогда исчезновение комнаты при нормализации
  // штатно. roomsBefore нужны только для предупреждения о нормализации.
  const expectedPillars = structuredClone(host.model().pillars ?? {}) as Record<string, PillarSig>;
  const roomsBefore = Object.keys(host.model().rooms2 ?? {}).length;
  const normWalls = (norm.model as { walls?: Record<string, { holes?: Record<string, { id?: string }> }> }).walls ?? {};
  const gotOpeningIds = new Set<string>();
  for (const [wid, w] of Object.entries(normWalls)) {
    for (const [hid, h] of Object.entries(w.holes ?? {})) gotOpeningIds.add(h.id ?? `${wid}/${hid}`);
  }
  const gotItemIds = new Set(Object.keys((norm.model as { items?: Record<string, unknown> }).items ?? {}));
  const gotPillarIds = new Set(Object.keys((norm.model as { pillars?: Record<string, unknown> }).pillars ?? {}));
  // этап 47: ожидаемые ригели — из нормализованной модели (того, что ушло на save):
  // редактор при нормализации пересчитывает polygon/l/r, сверять надо то, что реально
  // записано, а не устаревшую рабочую копию
  const expectedRigels = structuredClone((norm.model as { rigels?: Record<string, RigelSig> }).rigels ?? {});
  // этап 55, ревью №1: ожидаемые предметы для верификации после save — из
  // нормализованной модели (того, что ушло на save)
  const expectedItems = structuredClone((norm.model as { items?: Record<string, ItemSig> }).items ?? {});
  const localRigelIds = new Set(Object.keys(host.model().rigels ?? {}));
  const gotRigelIds = new Set(Object.keys((norm.model as { rigels?: Record<string, unknown> }).rigels ?? {}));
  // этап 57: газовые линии — ожидаемые (из нормализованной модели, того, что ушло
  // на save: редактор пересчитывает length) и потерянные при нормализации
  const expectedGasLines = structuredClone((norm.model as { pipes_gas?: Record<string, GasLineSig> }).pipes_gas ?? {});
  const localGasIds = new Set(Object.keys(host.model().pipes_gas ?? {}));
  const gotGasIds = new Set(Object.keys((norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {}));
  // этап 78: трубы водоснабжения — ожидаемые из нормализованной модели (точки
  // вершин-предметов редактор пересчитывает — сверка локальной копии мягкая)
  const expectedPipes = structuredClone((norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {});
  const localPipeIds = new Set(Object.keys(host.model().pipes ?? {}));
  const gotPipeIds = new Set(Object.keys((norm.model as { pipes?: Record<string, unknown> }).pipes ?? {}));
  // этап 64: ожидаемые границы террас/участка и проёмы в полу — из нормализованной модели
  const expectedBorders = {
    terrace_borders: structuredClone((norm.model as { terrace_borders?: Record<string, unknown> }).terrace_borders ?? {}),
    territory_borders: structuredClone((norm.model as { territory_borders?: Record<string, unknown> }).territory_borders ?? {}),
  };
  const expectedLevelHoles = structuredClone((norm.model as { level_holes?: Record<string, unknown> }).level_holes ?? {});
  // этап 84: световые линии листа «Освещение» — ожидаемые из нормализованной модели
  const expectedLedStrips = structuredClone((norm.model as { led_strips?: Record<string, GasLineSig> }).led_strips ?? {});
  const expectedStripesLight = structuredClone((norm.model as { stripes_light?: Record<string, GasLineSig> }).stripes_light ?? {});
  const expectedLineStrips = structuredClone((norm.model as { line_strips?: Record<string, GasLineSig> }).line_strips ?? {});
  // этап 88: ожидаемые связи «выключатель → светильник» — из нормализованной модели
  const expectedCables = structuredClone((norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {});
  // часть 2: ожидаемые кабели-проводка — из нормализованной модели (длина — производная)
  const expectedElec: Partial<Record<"cables_socket" | "cables_warm_floor" | "cables_conditioner", Record<string, GasLineSig>>> = {};
  for (const coll of ["cables_socket", "cables_warm_floor", "cables_conditioner"] as const) {
    expectedElec[coll] = structuredClone(((norm.model as Record<string, unknown>)[coll] ?? {}) as Record<string, GasLineSig>);
  }
  const localLedIds = new Set(Object.keys(host.model().led_strips ?? {}));
  const localStripeIds = new Set(Object.keys(host.model().stripes_light ?? {}));
  const localLineIds = new Set(Object.keys(host.model().line_strips ?? {}));
  const gotLedIds = new Set(Object.keys((norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {}));
  const gotStripeIds = new Set(Object.keys((norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {}));
  const gotLineIds = new Set(Object.keys((norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {}));
  const lostOpenings = missingIds(localOpeningIds, gotOpeningIds);
  const lostItems = missingIds(localItemIds, gotItemIds);
  const lostPillars = missingIds(localPillarIds, gotPillarIds);
  const lostRigels = missingIds(localRigelIds, gotRigelIds);
  const lostGasLines = missingIds(localGasIds, gotGasIds);
  const lostPipes = missingIds(localPipeIds, gotPipeIds);
  // этап 84: потери световых линий при нормализации
  const lostLedStrips = missingIds(localLedIds, gotLedIds);
  const lostStripesLight = missingIds(localStripeIds, gotStripeIds);
  const lostLineStrips = missingIds(localLineIds, gotLineIds);
  // этап 88: потери связей при нормализации
  const localCableIds = new Set(Object.keys(host.model().cables ?? {}));
  const gotCableIds = new Set(Object.keys((norm.model as { cables?: Record<string, unknown> }).cables ?? {}));
  const lostCables = missingIds(localCableIds, gotCableIds);
  // ревью 59 №1: до save сверяется семантический граф локальной и нормализованной
  // моделей (узлы, тип, рёбра matrix, длина) — normalizer, обнуливший рёбра,
  // не проходит как «verified»
  const gasGraphNorm = gasLineGraphMismatches(
    structuredClone(host.model().pipes_gas ?? {}) as Record<string, GasLineSig>,
    (norm.model as { pipes_gas?: Record<string, unknown> }).pipes_gas ?? {},
  );
  const pipesGraphNorm = gasLineGraphMismatches(
    structuredClone(host.model().pipes ?? {}) as Record<string, GasLineSig>,
    (norm.model as { pipes?: Record<string, unknown> }).pipes ?? {},
    "труба",
    true,
    structuredClone(host.model().items ?? {}) as Record<string, { pc?: Point; width?: number; height?: number; angle?: number }>,
  );
  // ревью 79 №5: подключения труба↔предмет сверяются в обе стороны до записи
  // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
  const pipesConnNorm = pipeConnectionMismatches(
    structuredClone(host.model().pipes ?? {}) as Record<string, GasLineSig>,
    host.model().items as Record<string, PipeLinkItem>,
    (norm.model as { pipes?: Record<string, GasLineSig> }).pipes ?? {},
    (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
    { onlyTypes: WATER_PIPE_TYPES },
  );
  // этап 64: потери границ и проёмов пола при нормализации
  const bordersNorm = checkBordersAfterNormalize(host.model(), norm.model as Model);
  const holesNorm = checkLevelHolesAfterNormalize(host.model(), norm.model as Model);
  // этап 84: семантическая сверка световых линий локальной и нормализованной моделей.
  // id_room вершин — производное (редактор пересчитывает принадлежность узла комнате
  // при draw/normalize), в предсохранительной сверке исключается — иначе штатный
  // допис-id_room объявлялся бы потерей (живая проба 84: узлы получили id_room комнаты).
  const ledGraphNorm = gasLineGraphMismatches(
    stripVertexIdRoom(structuredClone(host.model().led_strips ?? {})) as Record<string, GasLineSig>,
    (norm.model as { led_strips?: Record<string, unknown> }).led_strips ?? {},
    "светодиодная лента",
  );
  const stripesGraphNorm = gasLineGraphMismatches(
    stripVertexIdRoom(structuredClone(host.model().stripes_light ?? {})) as Record<string, GasLineSig>,
    (norm.model as { stripes_light?: Record<string, unknown> }).stripes_light ?? {},
    "трековая шина",
  );
  const lineStripsGraphNorm = gasLineGraphMismatches(
    stripVertexIdRoom(structuredClone(host.model().line_strips ?? {})) as Record<string, GasLineSig>,
    (norm.model as { line_strips?: Record<string, unknown> }).line_strips ?? {},
    "линейный свет",
  );
  // этап 88: связи «выключатель → светильник» — семантическая сверка локальной и
  // нормализованной моделей (id_room вершин — производное, как у световых линий)
  const cablesGraphNorm = gasLineGraphMismatches(
    stripVertexIdRoom(structuredClone(host.model().cables ?? {})) as Record<string, GasLineSig>,
    (norm.model as { cables?: Record<string, unknown> }).cables ?? {},
    "связь выключатель → светильник",
  );
  const cablesConnNorm = cableConnectionMismatches(
    (host.model().cables ?? {}) as Record<string, GasLineSig>,
    (host.model().items ?? {}) as Record<string, CableLinkItem>,
    (norm.model as { cables?: Record<string, GasLineSig> }).cables ?? {},
    (norm.model as { items?: Record<string, CableLinkItem> }).items ?? {},
    {
      led_strips: (host.model().led_strips ?? {}) as Record<string, unknown>,
      stripes_light: (host.model().stripes_light ?? {}) as Record<string, unknown>,
      line_strips: (host.model().line_strips ?? {}) as Record<string, unknown>,
    },
    {
      led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
      stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
      line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
    },
  );
  // часть 2: кабели-проводка до записи сверяются с нормализованной моделью
  // (граф + обе стороны обратных ссылок); длина — производная (опуски редактора)
  const elecCollKeys = ["cables_socket", "cables_warm_floor", "cables_conditioner"] as const;
  const elecNorm: { lost: string[]; graph: string[]; conn: string[]; coll: string }[] = [];
  for (const coll of elecCollKeys) {
    const wsElec = stripVertexIdRoom(structuredClone((host.model()[coll] ?? {}) as Record<string, GasLineSig>)) as Record<string, GasLineSig>;
    const normElec = ((norm.model as Record<string, unknown>)[coll] ?? {}) as Record<string, unknown>;
    const lostElec = missingIds(new Set(Object.keys(wsElec)), new Set(Object.keys(normElec)));
    const graphNorm = gasLineGraphMismatches(structuredClone(wsElec), normElec, "кабель-проводка", false, undefined, { skipLength: true });

    const elecAll = (src: Model, itemsOverride?: Record<string, ElecLinkItem>): [Partial<Record<ElecCableColl, Record<string, GasLineSig>>>, Record<string, ElecLinkItem>] => [
      {
        cables_socket: structuredClone((src.cables_socket ?? {}) as Record<string, GasLineSig>),
        cables_warm_floor: structuredClone((src.cables_warm_floor ?? {}) as Record<string, GasLineSig>),
        cables_conditioner: structuredClone((src.cables_conditioner ?? {}) as Record<string, GasLineSig>),
      },
      itemsOverride ?? ((src.items ?? {}) as unknown as Record<string, ElecLinkItem>),
    ];
    const [expElecAll, expElecItems] = elecAll(host.model(), elecLinkHolders(host.model()));
    const [gotElecAll, gotElecItems] = elecAll(norm.model as Model, elecLinkHolders(norm.model as Model));
    const connNorm = elecCableConnectionMismatches(expElecAll, expElecItems, gotElecAll, gotElecItems, coll); // ревью 241 №6
    elecNorm.push({ lost: lostElec, graph: graphNorm, conn: connNorm, coll });
  }
  // этап 255: конструктор щитка до записи сверяется с нормализованной моделью;
  // редактор дополняет щиток-предмет без записи записью по умолчанию
  // (SHIELDS.restore) — авто-запись без содержимого не потеря
  const shieldsNorm = shieldMismatches(
    structuredClone((host.model()["shields"] ?? {}) as Record<string, never>),
    ((norm.model as Record<string, unknown>)["shields"] ?? {}) as Record<string, never>,
    { allowAutoCreate: true },
  );
  // ревью 90 R1, 92 R1a: состав и пользовательские свойства под-розеток сверяются
  // до записи; производная геометрия — только после save против нормализованного ожидания
  const subsNorm = socketGroupSubsUserMismatches(
    host.model().items as Record<string, SubsItemSig>,
    (norm.model as { items?: Record<string, unknown> }).items ?? {},
  );
  // этап 94, ревью 95/98: отделка до записи сверяется с нормализованной моделью
  // (режим normalize — правила топологии по эталонам редактора 98)
  const finishNorm = finishCompare(
    (host.model()["rooms2"] ?? host.model()["rooms1"]) as Record<string, unknown> | undefined,
    ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
    host.model()["walls"] as Record<string, unknown> | undefined,
    (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
    "normalize",
  );
  // этап 260: разделители зон потолка до записи сверяются с нормализованной моделью
  // (режим normalize: ревью 261 №5 — комната, затронутая изменёнными стенами
  // и исчезнувшая, — предупреждение, не отказ; живой эталон 262: id комнат
  // редактор пересоздаёт, затронутость — по геометрии комнат ожидания;
  // ревью 263 N1: затронутость строже affectedRoomIds — Т-примыкание новой
  // стены к оси общей стены не делает соседа затронутым)
  const zoneWallPolicy = host.roomChangePolicy();
  const zoneAffected = zoneAffectedRoomIds(host.model() as unknown as Record<string, unknown>, zoneWallPolicy);
  const zoneNorm = zoneDelimiterCompare(
    host.model() as unknown as Record<string, unknown>,
    norm.model as unknown as Record<string, unknown>,
    "normalize",
    { affectedRooms: zoneAffected },
  );
  // ревью 319 №8: нормализация не воскрешает zone_c-делители, удалённые через MCP
  const zoneResurrected = resurrectedZoneCDividers(
    host.model() as unknown as Record<string, unknown>,
    norm.model as unknown as Record<string, unknown>,
  );
  // этап 273: тёплые стены до записи сверяются с нормализованной моделью
  // (затронутость комнат — по грани стены, zoneAffectedRoomIds; части редактор
  // мигрирует при пересчёте комнат — сверка по геометрии, не по id)
  const warmNorm = warmWallsCompare(
    host.model() as unknown as Record<string, unknown>,
    norm.model as unknown as Record<string, unknown>,
    "normalize",
    { affectedRooms: zoneAffected },
  );
  // этап 303: потолочные закладные до записи сверяются с нормализованной моделью
  // (затронутость комнат — по грани стены, zoneAffectedRoomIds; связи — по
  // геометрии граней, ревью 304 M6)
  const ceilingRigelNorm = ceilingRigelCompare(
    (host.model()["rooms2"] ?? host.model()["rooms1"]) as Record<string, unknown> | undefined,
    ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
    "normalize",
    {
      affectedRooms: zoneAffected,
      walls: { ...(host.model().walls ?? {}), ...((norm.model as Record<string, unknown>)["walls"] ?? {}) } as Record<string, unknown>,
      pillars: { ...(host.model().pillars ?? {}), ...((norm.model as Record<string, unknown>)["pillars"] ?? {}) } as Record<string, unknown>,
    },
  );
  // этап 113: размеры и комментарии до записи сверяются с нормализованной моделью
  const dimsNorm = dimsMismatches(host.model(), norm.model as Record<string, unknown>);
  // этап 122: сущности климата до записи сверяются с нормализованной моделью
  const climateNorm = climateGraphMismatches(host.model(), norm.model as Record<string, unknown>, {
    mode: "normalize",
    roomsExpected: (host.model()["rooms2"] ?? host.model()["rooms1"]) as Record<string, unknown> | undefined,
    roomsGot: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
    itemsExpected: host.model().items as unknown as Record<string, PipeLinkItem>,
    itemsGot: (norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {},
  });
  // ревью 66 №3: роли стен (ограждение террасы) не должны меняться при нормализации
  const expectedWalls = structuredClone((norm.model as { walls?: Record<string, { role?: string; p1: Point; p2: Point }> }).walls ?? {});
  const rolesNorm = wallRoleMismatches(host.model().walls as unknown as Record<string, { role?: string; p1: Point; p2: Point }>, expectedWalls);
  // этап 103: пометки демонтажа до записи сверяются с нормализованной моделью
  const demolitionNorm = demolitionMismatches(
    host.model().walls as Record<string, never>,
    (norm.model as Record<string, unknown>)["walls"] as Record<string, never>,
  );
  // ревью 73 №2: свойства ограждений (height/depth/material) не должны меняться при нормализации
  const propsNorm = balconyWallPropertyMismatches(
    host.model().walls as unknown as Record<string, BalconyWallProps>,
    expectedWalls as unknown as Record<string, BalconyWallProps>,
  );
  const gotSegments = wallAxisSegments(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
  const gotCoverage = wallAxisCoverageCm(normWalls as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
  // ревью 43 №4: комнаты с пользовательскими полями не исчезают при нормализации молча
  const normRooms = Object.keys((norm.model as { rooms2?: Record<string, unknown> }).rooms2 ?? {}).length;
  // этап 126: комнаты до записи сверяются с нормализованной моделью — присутствие
  // каждой комнаты по каноническому контуру и пользовательские поля (имя, зоны);
  // допустимы только штатные топологии редактора (split/merge — предупреждение,
  // перенос стены — строгая сверка имени). При штатном изменении стен пользователем
  // (размыкание контура, перекомпоновка) потеря комнаты объяснима — предупреждение.
  // этап 126/128: комнаты до записи сверяются с базой (модель с сервера / после
  // последнего успешного save — ревью 127 R1/R2/R4), а не с локальной моделью после
  // операции. Изменённые пользователем стены = разница «база → рабочая копия»;
  // затронутые ими комнаты базы и новые замкнутые контуры из изменённых стен —
  // предупреждения, потеря незатронутой комнаты — NORMALIZATION_DROPPED.
  // T24: если в нормализованной копии rooms2 ещё пуст, а редактор отчитался
  // списком комнат (norm.rooms), контурная сверка откладывается до записи.
  const saveNormRoomsMap = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
  const saveRoomsPending = (saveNormRoomsMap === undefined || Object.keys(saveNormRoomsMap).length === 0) && (norm.rooms?.length ?? 0) > 0;
  const roomsNormCheck = saveRoomsPending
    ? { problems: [], warnings: [] }
    : roomsSaveCompare(
        (host.roomSaveBase()?.rooms ?? ((host.model()["rooms2"] ?? host.model()["rooms1"]) as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined,
        saveNormRoomsMap,
        "normalize",
        host.roomChangePolicy(),
        // этап 318, ревью 319 №1: комнаты с изменённым набором zone_c-делителей —
        // от той же базы, что и комнаты (roomSaveBase), а не от рабочей копии:
        // добавленные И удалённые делители (деление/слияние зон редактором
        // штатно сбрасывает имена/состав зон)
        {
          zoneDivisionRooms: roomsWithChangedZoneCDividers(
            (host.roomSaveBase()
              ? ({ rooms2: host.roomSaveBase()!.rooms, zone_delimiters: host.roomSaveBase()!.zoneDelimiters } as unknown as Record<string, unknown>)
              : (host.model() as unknown as Record<string, unknown>)),
            norm.model as unknown as Record<string, unknown>,
          ),
        },
      );
  const roomsNormProblems = roomsNormCheck.problems;
  if (roomsBefore > 0 && normRooms === 0) {
    warnings.push(`редактор убрал комнаты при нормализации (${roomsBefore} → 0) — имя и отделка комнат могут быть потеряны; проверьте rooms_list после сохранения`);
  }
  if (
    !wallAxisSetsEqual(gotSegments, expected.segments) ||
    lostOpenings.length > 0 || lostItems.length > 0 || lostPillars.length > 0 || lostRigels.length > 0 || lostGasLines.length > 0 || lostPipes.length > 0 ||
    gasGraphNorm.length > 0 || pipesGraphNorm.length > 0 || pipesConnNorm.length > 0 || bordersNorm.length > 0 || holesNorm.length > 0 || rolesNorm.length > 0 || propsNorm.length > 0 ||
    lostLedStrips.length > 0 || lostStripesLight.length > 0 || lostLineStrips.length > 0 ||
    lostCables.length > 0 ||
    ledGraphNorm.length > 0 || stripesGraphNorm.length > 0 || lineStripsGraphNorm.length > 0 ||
    cablesGraphNorm.length > 0 || cablesConnNorm.length > 0 || subsNorm.length > 0 || finishNorm.problems.length > 0 || demolitionNorm.length > 0 ||
    dimsNorm.length > 0 || climateNorm.length > 0 || roomsNormProblems.length > 0 ||
    shieldsNorm.length > 0 ||
    zoneNorm.problems.length > 0 ||
    zoneResurrected.length > 0 ||
    warmNorm.problems.length > 0 ||
    ceilingRigelNorm.problems.length > 0 ||
    elecNorm.some((e) => e.lost.length > 0 || e.graph.length > 0 || e.conn.length > 0)
  ) {
    throw new McpError("NORMALIZATION_DROPPED", "редактор потерял объекты при нормализации", {
      details: {
        expected_walls: expected.walls,
        after_walls: norm.after.walls,
        coverage_before_mm: Math.round(expected.coverage * 10),
        coverage_after_mm: Math.round(gotCoverage * 10),
        axis_segments_before: expected.segments.length,
        axis_segments_after: gotSegments.length,
        wall_property_mismatches: propsNorm,
        lost_openings: lostOpenings,
        lost_items: lostItems,
        lost_pillars: lostPillars,
        lost_rigels: lostRigels,
        lost_gas_lines: lostGasLines,
        gas_line_mismatches: gasGraphNorm,
        lost_pipes: lostPipes,
        pipe_mismatches: pipesGraphNorm,
        pipe_connection_mismatches: pipesConnNorm,
        border_mismatches: bordersNorm,
        level_hole_mismatches: holesNorm,
        wall_role_mismatches: rolesNorm,
        lost_led_strips: lostLedStrips,
        lost_stripes_light: lostStripesLight,
        lost_line_strips: lostLineStrips,
        lost_cables: lostCables,
        led_strip_mismatches: ledGraphNorm,
        stripes_light_mismatches: stripesGraphNorm,
        line_strips_mismatches: lineStripsGraphNorm,
        cables_mismatches: cablesGraphNorm,
        cables_connection_mismatches: cablesConnNorm,
        socket_group_mismatches: subsNorm,
        finish_mismatches: finishNorm.problems,
        demolition_mismatches: demolitionNorm,
        dims_mismatches: dimsNorm,
        climate_mismatches: climateNorm,
        room_mismatches: roomsNormProblems,
        shield_mismatches: shieldsNorm,
        zone_mismatches: [...zoneNorm.problems, ...zoneResurrected],
        warmwall_mismatches: warmNorm.problems,
        ceiling_rigel_mismatches: ceilingRigelNorm.problems,
        ...Object.fromEntries(elecNorm.flatMap((e) => [
          [`lost_${e.coll}`, e.lost],
          [`${e.coll}_mismatches`, e.graph],
          [`${e.coll}_connection_mismatches`, e.conn],
        ])),
      },
    });
  }
  warnings.push(...finishNorm.warnings);
  warnings.push(...zoneNorm.warnings);
  warnings.push(...roomsNormCheck.warnings);
  let rounds = 0;
  let verified = false;
  let finalSaveId = p.saveId;
  for (let attempt = 0; attempt < 2 && !verified; attempt++) {
    const saveRes = await editor.save();
    rounds++;
    if (saveRes.conflict && !options.force) {
      throw new McpError("SAVE_CONFLICT", "сервер ответил диалогом «Сохранить все равно»", {
        hint: "правки в другой вкладке; принудительная запись — только force: true",
      });
    }
    if (!saveRes.ok) {
      throw new McpError("SITE_ERROR", "сохранение не прошло", { details: { save_id: saveRes.saveId } });
    }
    // верификация по GET: контент, а не только save_id (save_id не монотонен).
    // Стены — по каноническому набору осевых отрезков (ревью v0.1.1-r2 R2-3):
    // слияние при сохранении легитимно, сдвиг/лишняя стена — нет.
    // Колонны — по id и значимой геометрии (ревью 43 №2), комнаты — по числу (№4).
    const after = await host.deps.loadModel(host.deps.session, p.objectId, p.planId);
    const wallsAfter = (after.model["walls"] as Record<string, unknown> | undefined) ?? {};
    const segmentsAfter = wallAxisSegments(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>);
    const pillarsAfter = (after.model["pillars"] as Record<string, unknown> | undefined) ?? {};
    const roomsAfter = Object.keys((after.model["rooms2"] as Record<string, unknown> | undefined) ?? {}).length;
    const pillarMismatch = pillarVerificationMismatches(expectedPillars, pillarsAfter);
    const rigelsAfter = (after.model["rigels"] as Record<string, unknown> | undefined) ?? {};
    const rigelMismatch = rigelVerificationMismatches(expectedRigels, rigelsAfter);
    // этап 55, ревью №1: предметы после save сверяются по id и типу/геометрии,
    // а не только счётчиком при нормализации
    const itemsAfter = (after.model["items"] as Record<string, unknown> | undefined) ?? {};
    const itemMismatch = itemVerificationMismatches(expectedItems, itemsAfter);
    // этап 57: газовые линии после save сверяются по id, типу, узлам, рёбрам matrix
    // и длине (ревью 59 №1 — топология входит в сверку)
    const gasAfter = (after.model["pipes_gas"] as Record<string, unknown> | undefined) ?? {};
    const gasMismatch = gasLineGraphMismatches(expectedGasLines, gasAfter);
    // этап 78: трубы водоснабжения после save — по нормализованной семантике графа;
    // ревью 79 №3/№5: точки вершин-предметов и длина — строго (ожидание уже
    // нормализованное), множество труб в обе стороны, identity вершин-предметов по id
    const pipesAfter = (after.model["pipes"] as Record<string, unknown> | undefined) ?? {};
    const pipeMismatch = gasLineGraphMismatches(expectedPipes, pipesAfter, "труба");
    // ревью 79 №5a: обратные ссылки props.pipes и прямые ссылки предметов — обе стороны
    // (только водные ключи — климат сверяет climateGraphMismatches, ревью 124 R2)
    const pipeConnAfter = pipeConnectionMismatches(
      expectedPipes,
      expectedItems as Record<string, PipeLinkItem>,
      pipesAfter as Record<string, GasLineSig>,
      (itemsAfter as Record<string, PipeLinkItem>) ?? {},
      { onlyTypes: WATER_PIPE_TYPES },
    );
    // этап 64: границы террас/участка и проёмы в полу после save — по нормализованной семантике
    const bordersAfter = {
      terrace_borders: (after.model["terrace_borders"] as Record<string, unknown> | undefined) ?? {},
      territory_borders: (after.model["territory_borders"] as Record<string, unknown> | undefined) ?? {},
    };
    const borderMismatch = checkBordersAfterNormalize(
      { terrace_borders: expectedBorders.terrace_borders, territory_borders: expectedBorders.territory_borders } as Model,
      bordersAfter,
    );
    const holesAfter = (after.model["level_holes"] as Record<string, unknown> | undefined) ?? {};
    const holeMismatch = levelHoleMismatches(expectedLevelHoles as Record<string, import("../model/types.ts").LevelHole>, holesAfter);
    // этап 84: световые линии после save — по нормализованной семантике графа
    const ledAfter = (after.model["led_strips"] as Record<string, unknown> | undefined) ?? {};
    const stripesAfter = (after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {};
    const lineStripsAfter = (after.model["line_strips"] as Record<string, unknown> | undefined) ?? {};
    const ledMismatch = gasLineGraphMismatches(expectedLedStrips, ledAfter, "светодиодная лента");
    const stripesMismatch = gasLineGraphMismatches(expectedStripesLight, stripesAfter, "трековая шина");
    const lineStripsMismatch = gasLineGraphMismatches(expectedLineStrips, lineStripsAfter, "линейный свет");
    // этап 88: связи «выключатель → светильник» после save — граф и обе стороны ссылок
    const cablesAfter = (after.model["cables"] as Record<string, unknown> | undefined) ?? {};
    const cablesMismatch = gasLineGraphMismatches(expectedCables, cablesAfter, "связь выключатель → светильник");
    const cablesConnAfter = cableConnectionMismatches(
      expectedCables,
      expectedItems as Record<string, CableLinkItem>,
      cablesAfter as Record<string, GasLineSig>,
      (itemsAfter as Record<string, CableLinkItem>) ?? {},
      {
        led_strips: ((norm.model as Record<string, unknown>).led_strips ?? {}) as Record<string, unknown>,
        stripes_light: ((norm.model as Record<string, unknown>).stripes_light ?? {}) as Record<string, unknown>,
        line_strips: ((norm.model as Record<string, unknown>).line_strips ?? {}) as Record<string, unknown>,
      },
      {
        led_strips: ((after.model["led_strips"] as Record<string, unknown> | undefined) ?? {}),
        stripes_light: ((after.model["stripes_light"] as Record<string, unknown> | undefined) ?? {}),
        line_strips: ((after.model["line_strips"] as Record<string, unknown> | undefined) ?? {}),
      },
    );
    // ревью 90 R6: форма обратных ссылок (массив у под-розетки, скаляр у светильника)
    // после save сверяется с нормализованным ожиданием
    const cableFormAfter = cableLinkFormMismatches(
      expectedItems as Record<string, CableLinkItem>,
      itemsAfter,
    );
    // часть 2: кабели-проводка после save — граф и обе стороны обратных ссылок
    // по нормализованному ожиданию (длина — производная)
    const elecAfter: { graph: string[]; conn: string[]; coll: string }[] = [];
    for (const coll of ["cables_socket", "cables_warm_floor", "cables_conditioner"] as const) {
      const elecCollAfter = (after.model[coll] as Record<string, unknown> | undefined) ?? {};
      elecAfter.push({
        coll,
        graph: gasLineGraphMismatches(stripVertexIdRoom(structuredClone(expectedElec[coll] ?? {})) as Record<string, GasLineSig>, elecCollAfter, "кабель-проводка", false, undefined, { skipLength: true }),
        conn: elecCableConnectionMismatches(
          structuredClone(expectedElec),
          elecLinkHolders(norm.model as Model),
          {
            cables_socket: structuredClone(((after.model["cables_socket"] as Record<string, unknown> | undefined) ?? {}) as Record<string, GasLineSig>),
            cables_warm_floor: structuredClone(((after.model["cables_warm_floor"] as Record<string, unknown> | undefined) ?? {}) as Record<string, GasLineSig>),
            cables_conditioner: structuredClone(((after.model["cables_conditioner"] as Record<string, unknown> | undefined) ?? {}) as Record<string, GasLineSig>),
          },
          // тёплые стены (этап 273): держатели частей берутся из rooms2 after-модели
          elecLinkHolders({ items: itemsAfter, warm_floors: (after.model["warm_floors"] ?? {}) as Model["warm_floors"], rooms2: after.model["rooms2"] ?? after.model["rooms1"] } as Model),
          coll, // ревью 241 №6: только текущая коллекция — без дублей под чужими ключами
        ),
      });
    }
    // ревью 90 R1, 92 R1a/R1b: состав и пользовательские свойства под-розеток
    // после save; производная геометрия (center/real_center/vd) — против
    // нормализованного ожидания с допуском
    const subsAfter = socketGroupSubsUserMismatches(
      expectedItems as Record<string, SubsItemSig>,
      itemsAfter,
    );
    const subsDerivedAfter = socketGroupSubsDerivedMismatches(
      expectedItems as Record<string, SubsItemSig>,
      itemsAfter,
    );
    // ревью 66 №3: роли стен после save — ограждение, ставшее обычной стеной, не «verified»
    const wallsAfterTyped = wallsAfter as Record<string, { role?: string; p1: Point; p2: Point }>;
    const wallRoleMismatch = wallRoleMismatches(expectedWalls, wallsAfterTyped);
    // ревью 73 №2: свойства ограждений после save — height/depth/material сверяются,
    // подмена любого из них на сервере не «verified»
    const wallPropMismatch = balconyWallPropertyMismatches(
      expectedWalls as unknown as Record<string, BalconyWallProps>,
      wallsAfterTyped as unknown as Record<string, BalconyWallProps>,
    );
    // этап 94, ревью 95/98: отделка после save сверяется по GET — нормализованное
    // ожидание против сервера; режим save — СТРОГО (ревью 98 N1/N2): комната и каждая
    // сторона стены (ориентированно) сохраняют отделку; никаких merge/split-освобождений
    const expectedFinish = ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined;
    const gotFinish = ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {};
    const finishAfter = finishCompare(
      expectedFinish,
      gotFinish,
      (norm.model as Record<string, unknown>)["walls"] as Record<string, unknown> | undefined,
      after.model["walls"] as Record<string, unknown> | undefined,
      "save",
    ).problems;
    // этап 103: пометки демонтажа после save — нормализованное ожидание против сервера,
    // строго (участки по геометрии, флаги demount по каждой стене и проёму)
    const demolitionAfter = demolitionMismatches(
      (norm.model as Record<string, unknown>)["walls"] as Record<string, never>,
      after.model["walls"] as Record<string, never>,
    );
    // этап 113: размеры и комментарии после save сверяются по GET — нормализованное
    // ожидание против сервера (строго: текст, точки, привязки, отступ, цвет)
    const dimsAfter = dimsMismatches(norm.model as Model, after.model as Record<string, unknown>);
    // этап 122: сущности климата после save — нормализованное ожидание против сервера
    const climateExpected = {
      warm_floors: structuredClone((norm.model as Record<string, unknown>)["warm_floors"] ?? {}),
      pipes_warm_floor: structuredClone((norm.model as Record<string, unknown>)["pipes_warm_floor"] ?? {}),
      pipes_conditioner: structuredClone((norm.model as Record<string, unknown>)["pipes_conditioner"] ?? {}),
      pipes_heat: structuredClone((norm.model as Record<string, unknown>)["pipes_heat"] ?? {}),
      pipes_ventilation: structuredClone((norm.model as Record<string, unknown>)["pipes_ventilation"] ?? {}),
    };
    const climateAfter = climateGraphMismatches(
      climateExpected as unknown as Model,
      after.model as Record<string, unknown>,
      {
        mode: "save",
        itemsExpected: structuredClone((norm.model as { items?: Record<string, PipeLinkItem> }).items ?? {}),
        itemsGot: (itemsAfter as Record<string, PipeLinkItem>) ?? {},
        // ревью 133 N1: при перегородке редактор перестраивает комнаты при save
        // и сам переназначает id_room контуров — сверка привязки по геометрии
        roomsExpected: ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
        roomsGot: ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {},
      },
    );
    // этап 255: щитки после save — нормализованное ожидание против сервера, строго
    // (авто-записей тут быть не может: ожидание уже из нормализованной модели)
    const shieldsAfter = shieldMismatches(
      structuredClone(((norm.model as Record<string, unknown>)["shields"] ?? {}) as Record<string, never>),
      ((after.model["shields"] as Record<string, unknown> | undefined) ?? {}) as Record<string, never>,
    );
    // этап 260: разделители зон потолка после save — нормализованное ожидание против
    // сервера, строго (привязка узлов zone — производное редактора, не сверяется;
    // ревью 263 N2: затронутые комнаты в save сверяются строго, допустим только
    // сдвиг концов до магнита — предупреждение)
    const zoneAffectedAfter = zoneAffectedRoomIds(norm.model as unknown as Record<string, unknown>, zoneWallPolicy);
    const zoneAfterCheck = zoneDelimiterCompare(
      norm.model as unknown as Record<string, unknown>,
      after.model as unknown as Record<string, unknown>,
      "save",
      { affectedRooms: zoneAffectedAfter },
    );
    warnings.push(...zoneAfterCheck.warnings);
    const zoneAfter = zoneAfterCheck.problems;
    // этап 273: тёплые стены после save — нормализованное ожидание против
    // сервера, строго (затронутые изменёнными стенами комнаты — по грани)
    const warmAfterCheck = warmWallsCompare(
      norm.model as unknown as Record<string, unknown>,
      after.model as unknown as Record<string, unknown>,
      "save",
      { affectedRooms: zoneAffectedAfter },
    );
    warnings.push(...warmAfterCheck.warnings);
    const warmAfter = warmAfterCheck.problems;
    // этап 303: закладные после save — нормализованное ожидание против сервера,
    // строго (затронутые изменёнными стенами комнаты — по грани; связи — по
    // геометрии граней, ревью 304 M6)
    const ceilingRigelAfterCheck = ceilingRigelCompare(
      ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {},
      "save",
      {
        affectedRooms: zoneAffectedAfter,
        walls: { ...((norm.model as Record<string, unknown>)["walls"] ?? {}), ...(after.model["walls"] ?? {}) } as Record<string, unknown>,
        pillars: { ...((norm.model as Record<string, unknown>)["pillars"] ?? {}), ...(after.model["pillars"] ?? {}) } as Record<string, unknown>,
      },
    );
    warnings.push(...ceilingRigelAfterCheck.warnings);
    const ceilingRigelAfter = ceilingRigelAfterCheck.problems;
    const roomsLost = normRooms > 0 && roomsAfter === 0;
    // этап 126: комнаты после save — строго (по каноническому контуру и
    // пользовательским полям): частичная потеря N→M>0 и потеря имени/зон — не verified
    const roomsAfterCheck = roomsSaveCompare(
      ((norm.model as Record<string, unknown>)["rooms2"] ?? (norm.model as Record<string, unknown>)["rooms1"]) as Record<string, unknown> | undefined,
      ((after.model["rooms2"] ?? after.model["rooms1"]) as Record<string, unknown> | undefined) ?? {},
      "save",
      {},
      // ревью 319 №1: база — roomSaveBase (сервер до записи), не norm.model:
      // и добавленные, и удалённые делители объясняют сброс зон комнат на сервере
      {
        zoneDivisionRooms: roomsWithChangedZoneCDividers(
          (host.roomSaveBase()
            ? ({ rooms2: host.roomSaveBase()!.rooms, zone_delimiters: host.roomSaveBase()!.zoneDelimiters } as unknown as Record<string, unknown>)
            : (norm.model as unknown as Record<string, unknown>)),
          after.model as unknown as Record<string, unknown>,
        ),
      },
    ).problems;
    if (wallAxisSetsEqual(segmentsAfter, expected.segments) && pillarMismatch.length === 0 && rigelMismatch.length === 0 && itemMismatch.length === 0 && gasMismatch.length === 0 && pipeMismatch.length === 0 && pipeConnAfter.length === 0 && borderMismatch.length === 0 && holeMismatch.length === 0 && wallRoleMismatch.length === 0 && wallPropMismatch.length === 0 && ledMismatch.length === 0 && stripesMismatch.length === 0 && lineStripsMismatch.length === 0 && cablesMismatch.length === 0 && cablesConnAfter.length === 0 && cableFormAfter.length === 0 && subsAfter.length === 0 && subsDerivedAfter.length === 0 && finishAfter.length === 0 && demolitionAfter.length === 0 && dimsAfter.length === 0 && climateAfter.length === 0 && roomsAfterCheck.length === 0 && shieldsAfter.length === 0 && zoneAfter.length === 0 && warmAfter.length === 0 && ceilingRigelAfter.length === 0 && !roomsLost && elecAfter.every((e) => e.graph.length === 0 && e.conn.length === 0)) {
      verified = true;
      finalSaveId = after.save_id || saveRes.saveId || finalSaveId;
      host.onVerified(toModel(structuredClone(after.model)));
    } else if (attempt === 1) {
      // ревью 193 №5, 199 №1: отката сервера нет — на нём записана версия с
      // расхождениями. Рабочая копия остаётся с желаемой моделью и dirty:true.
      // save_id берём только из ответа СВОЕЙ записи (saveRes.saveId): id из
      // GET-сверки мог принять чужую запись (гонка между save и GET) — тогда
      // повторный project_save без force молча затёр бы чужую правку. Если
      // ответ save не вернул id — остаётся прежний p.saveId: ложный
      // SAVE_CONFLICT безопаснее молчаливой перезаписи, обходится force.
      p.saveId = saveRes.saveId || p.saveId;
      throw new McpError("SITE_ERROR", "после сохранения модель на сервере не совпала с рабочей копией", {
        // ревью 199 №3/№4: подсказка — в штатном поле hint (как у остальных
        // ошибок save), не в details. backup_path — снимок рабочей копии ДО
        // save, а не прежней версии сервера: восстановление из него равносильно
        // повторному project_save; прежняя версия сервера локально не хранится.
        hint: "на сервере версия с расхождениями; рабочая копия не изменена (её копия в backup_path); повторите project_save",
        details: {
          // server_save_id — диагностическое поле: какая запись сейчас на сервере
          // по GET-сверке (может быть уже чужой, см. выше про гонку). Ключ в
          // ответе есть всегда: если GET не вернул save_id — null, а не пропавшее
          // поле (ревью 202 nit №2)
          backup_path: backupPath,
          server_save_id: after.save_id ?? null,
          expected_walls: expected.walls, got_walls: Object.keys(wallsAfter).length,
          coverage_before_mm: Math.round(expected.coverage * 10), coverage_after_mm: Math.round(wallAxisCoverageCm(wallsAfter as Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }>) * 10),
          axis_segments_before: expected.segments.length, axis_segments_after: segmentsAfter.length,
          pillar_mismatches: pillarMismatch, rigel_mismatches: rigelMismatch, item_mismatches: itemMismatch,
          gas_line_mismatches: gasMismatch,
          pipe_mismatches: pipeMismatch,
          pipe_connection_mismatches: pipeConnAfter,
          border_mismatches: borderMismatch,
          level_hole_mismatches: holeMismatch,
          wall_role_mismatches: wallRoleMismatch,
          wall_property_mismatches: wallPropMismatch,
          led_strip_mismatches: ledMismatch,
          stripes_light_mismatches: stripesMismatch,
          line_strips_mismatches: lineStripsMismatch,
          cables_mismatches: cablesMismatch,
          cables_connection_mismatches: cablesConnAfter,
          cables_link_form_mismatches: cableFormAfter,
          socket_group_mismatches: subsAfter,
          socket_group_derived_mismatches: subsDerivedAfter,
          rooms_expected: normRooms, rooms_on_server: roomsAfter,
          room_mismatches: roomsAfterCheck,
          finish_mismatches: finishAfter,
          demolition_mismatches: demolitionAfter,
          dims_mismatches: dimsAfter,
          climate_mismatches: climateAfter,
          shield_mismatches: shieldsAfter,
          zone_mismatches: zoneAfter,
          warmwall_mismatches: warmAfter,
          ceiling_rigel_mismatches: ceilingRigelAfter,
          ...Object.fromEntries(elecAfter.flatMap((e) => [
            [`${e.coll}_mismatches`, e.graph],
            [`${e.coll}_connection_mismatches`, e.conn],
          ])),
        },
      });
    }
  }
  p.saveId = finalSaveId;
  p.dirty = false;
  host.onSaved();
  return { save_id: finalSaveId, save_id_before: saveIdBefore, backup_path: backupPath, verified, rounds, will_delete: willDelete, warnings };
}
