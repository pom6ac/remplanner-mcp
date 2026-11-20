/**
 * Чистые entity-верификаторы для сверки после save (C2, этап 184): вынесены из
 * src/workspace.ts без изменения поведения. Модуль без сети, браузера и
 * workspace-состояния — только функции над моделью/фрагментами модели.
 * Общий тип результата — VerificationMismatches (types.ts).
 */
export type { VerificationMismatches } from "./types.ts";
export { openingIds, missingIds } from "./ids.ts";
export { borderMismatchesOf, checkBordersAfterNormalize } from "./borders.ts";
export { checkLevelHolesAfterNormalize } from "./level-holes.ts";
export { stripVertexIdRoom, gasLineGraphMismatches, type GasLineSig, type GasVertexSig } from "./graphs.ts";
export { pillarVerificationMismatches, type PillarSig } from "./pillars.ts";
export { rigelVerificationMismatches, type RigelSig } from "./rigels.ts";
export { itemVerificationMismatches, type ItemSig } from "./items.ts";
export { socketGroupSubsUserMismatches, socketGroupSubsDerivedMismatches, type SubsItemSig } from "./sockets.ts";
export { cableConnectionMismatches, cableLinkFormMismatches, type CableLinkItem, type CableLinkLines } from "./cables.ts";
export { elecCableConnectionMismatches, type ElecLinkItem } from "./elec.ts";
export { shieldMismatches, isDefaultEmptyShield } from "./shields.ts";
export type { ElecCableColl } from "../model/electric2.ts";
export { wallAxisCoveredBy, wallRoleMismatches, balconyWallPropertyMismatches, type BalconyWallProps } from "./walls.ts";
export { pipeConnectionMismatches, type PipeLinkItem, ALL_PIPE_TYPES, WATER_PIPE_KEYS, WATER_PIPE_TYPES } from "./pipes.ts";
export { climateGraphMismatches } from "./climate.ts";
