import { z } from "zod";
import { mmInt } from "./units.ts";
import { McpError } from "../errors.ts";
import {
  PARTITION_MATERIALS, PARTITION_PRO_MATERIALS, partitionMaterialKey,
} from "../model/demolition.ts";
import type { Model, Wall } from "../model/types.ts";

// DTO группы «стены и помещения»: разрешение ссылок W<n>/site-id, схема толщины
// и выбор материала перегородки (публичные ключи → коды модели).

/** Стена по site-id или компактной метке W1…Wn (порядок совпадает с model_get). */
export function resolveWall(model: Model, ref: string): Wall {
  if (model.walls[ref]) return model.walls[ref]!;
  const m = /^W(\d+)$/.exec(ref);
  if (m) {
    const walls = Object.values(model.walls);
    const wall = walls[Number(m[1]) - 1];
    if (wall) return wall;
  }
  throw Object.assign(new Error(`стена ${ref} не найдена (id сайта или метка W<n> из model_get)`), { code: "NOT_FOUND" });
}

/** Ссылка на стену: id сайта или метка W<n> из model_get. */
export const wallRef = z.string().min(1).describe("id стены сайта или метка W<n> из model_get");

/** Толщина: одно число в мм или по сторонам {top,right,bottom,left}. */
export const thickness = z.union([mmInt, z.object({
  top: mmInt, right: mmInt, bottom: mmInt, left: mmInt,
})]).describe("толщина в мм: одно число или {top,right,bottom,left}");

/**
 * Выбор материала и плана по kind (ревью 129 C7a — одна функция вместо копипасты
 * в wall_add/walls_add_polyline/wall_update). kind=partition: нормализация к
 * публичному ключу (строгий enum, ревью 105 R6) и флаг PRO-гейта — c_glass проходит
 * тот же гейт, что и glass. kind=initial: материал c_* перегородок отклоняется
 * (ревью 129 C4 — обход PRO-гейта c_glass/c_bar). Чистая функция DTO: PRO-гейт
 * (тариф/анонимный проект) проверяет вызывающий tool-модуль по флагу pro.
 */
export function resolveWallMaterial(kind: "initial" | "partition" | undefined, material: string | undefined): { plan: "a" | "c"; material: string; pro: boolean } {
  if (kind === "partition") {
    const key = partitionMaterialKey(material ?? "pgb");
    return { plan: "c", material: PARTITION_MATERIALS[key], pro: PARTITION_PRO_MATERIALS.has(key) };
  }
  const mat = material ?? "a_block";
  if (/^c_/.test(mat)) {
    throw new McpError("INVALID_ARGUMENT", `материал «${mat}» — материал перегородок листа «Перегородки», у исходных стен (plan:"a") свои материалы`, {
      hint: "для исходных стен используйте a_block и другие a_*; перегородка — wall_add с kind=partition",
      details: { kind: "initial_material_invalid", material: mat },
    });
  }
  return { plan: "a", material: mat, pro: false };
}
