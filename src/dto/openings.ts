import { z } from "zod";
import { throwNotFound } from "./common.ts";
import type { Model } from "../model/types.ts";
import type { AddOpeningParams, UpdateOpeningParams } from "../model/openings.ts";

// DTO группы «проёмы»: схема створок, разрешение ссылки проёма (поиск стены)
// и перевод публичных аргументов opening_add/update (мм) в параметры модельного слоя.

/** Петля и сторона открывания двери (публичные start/end, left/right). */
export const swing = z.object({
  hinge: z.enum(["start", "end"]).describe("у какого конца оси петля"),
  into: z.enum(["left", "right"]).describe("куда открывается дверь (left — левая грань по направлению оси)"),
});

/** Стена, на которой стоит проём (поиск по всем стенам); NOT_FOUND, если проёма нет. */
export function resolveOpeningWall(model: Model, openingId: string): string {
  const found = Object.values(model.walls).find((w) => (w.holes ?? {})[openingId]);
  if (!found) throwNotFound(`проём ${openingId} не найден ни на одной стене`);
  return found!.id;
}

type OpeningPublicArgs = Record<string, unknown>;

/** Публичные аргументы opening_add → AddOpeningParams модельного слоя. */
export function openingAddArgs(wallId: string, a: OpeningPublicArgs): AddOpeningParams {
  return {
    wallId,
    type: a["type"] as string,
    offsetMm: a["offset_mm"] as number | undefined,
    from: a["from"] as "start" | "end" | undefined,
    centerMm: a["center_mm"] as number | undefined,
    widthMm: a["width_mm"] as number | undefined,
    heightMm: a["height_mm"] as number | undefined,
    sillHeightMm: a["sill_height_mm"] as number | undefined,
    swing: a["swing"] as { hinge: "start" | "end"; into: "left" | "right" } | undefined,
    casing: a["casing"] as boolean | undefined,
    casements: a["casements"] as number | undefined,
    slopeAngleDeg: a["slope_angle_deg"] as number | undefined,
    sillThicknessMm: a["sill_thickness_mm"] as number | undefined,
    sillOverhangMm: a["sill_overhang_mm"] as number | undefined,
    sillOvermeasureMm: a["sill_overmeasure_mm"] as number | undefined,
    windowWidthMm: a["window_width_mm"] as number | undefined,
    windowHeightMm: a["window_height_mm"] as number | undefined,
    doorWidthMm: a["door_width_mm"] as number | undefined,
    doorHeightMm: a["door_height_mm"] as number | undefined,
    doorPosition: a["door_position"] as "left" | "right" | undefined,
    impostHeightMm: a["impost_height_mm"] as number | undefined,
    replacesHoleId: a["replaces"] as string | undefined,
  };
}

/** Публичные аргументы opening_update → UpdateOpeningParams модельного слоя. */
export function openingUpdateParams(wallId: string, openingId: string, a: OpeningPublicArgs): UpdateOpeningParams {
  return {
    wallId,
    holeId: openingId,
    type: a["type"] as string | undefined,
    offsetMm: a["offset_mm"] as number | undefined,
    from: a["from"] as "start" | "end" | undefined,
    centerMm: a["center_mm"] as number | undefined,
    widthMm: a["width_mm"] as number | undefined,
    heightMm: a["height_mm"] as number | undefined,
    sillHeightMm: a["sill_height_mm"] as number | undefined,
    swing: a["swing"] as { hinge: "start" | "end"; into: "left" | "right" } | undefined,
    casing: a["casing"] as boolean | undefined,
    casements: a["casements"] as number | undefined,
    slopeAngleDeg: a["slope_angle_deg"] as number | undefined,
    sillThicknessMm: a["sill_thickness_mm"] as number | undefined,
    sillOverhangMm: a["sill_overhang_mm"] as number | undefined,
    sillOvermeasureMm: a["sill_overmeasure_mm"] as number | undefined,
    windowWidthMm: a["window_width_mm"] as number | undefined,
    windowHeightMm: a["window_height_mm"] as number | undefined,
    doorWidthMm: a["door_width_mm"] as number | undefined,
    doorHeightMm: a["door_height_mm"] as number | undefined,
    doorPosition: a["door_position"] as "left" | "right" | undefined,
    impostHeightMm: a["impost_height_mm"] as number | undefined,
  };
}
