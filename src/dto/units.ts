import { z } from "zod";
import { TOOL_COORD_LIMIT_MM } from "../limits.ts";

// Слой DTO (аудит 65 C4, задача 187-c4): zod-примитивы публичного API и
// преобразования editor↔public, вынесенные из tools-*.ts. Модули src/dto —
// чистые: без server/, workspace, сети и браузера (сторож —
// tests/unit/c4-dto-guard.test.ts). Единицы публичного API — мм;
// единицы модели редактора — см (см. src/dto/model-payload.ts).

/** Zod-примитивы (мм). Диапазоны координат/размеров — src/limits.ts (B5, аудит 65). */
export const mmInt = z.number().finite().int().nonnegative().max(TOOL_COORD_LIMIT_MM).describe("мм, целое, ≥ 0");
// координаты узлов/точек могут быть отрицательными (ревью 85 №1: план не обязан
// умещаться в положительный квадрант — как в mmPoint)
export const mmIntSigned = z.number().finite().int().min(-TOOL_COORD_LIMIT_MM).max(TOOL_COORD_LIMIT_MM).describe("мм, целое (может быть отрицательным)");
export const mm = z.number().finite().describe("мм");
// координаты точек могут быть отрицательными (план не обязан умещаться в положительный квадрант)
export const mmPoint = z.object({
  x: z.number().finite().int().min(-TOOL_COORD_LIMIT_MM).max(TOOL_COORD_LIMIT_MM).describe("мм, целое (может быть отрицательным), X вправо"),
  y: z.number().finite().int().min(-TOOL_COORD_LIMIT_MM).max(TOOL_COORD_LIMIT_MM).describe("мм, целое (может быть отрицательным), Y вниз"),
}).describe("точка плана в мм, X вправо, Y вниз");
