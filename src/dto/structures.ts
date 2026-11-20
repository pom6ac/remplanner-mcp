import { z } from "zod";
import { throwNotFound } from "./common.ts";
import { resolveItem } from "./items.ts";
import { findPipe } from "../model/pipes.ts";
import { RIGEL_CEILING_TYPES } from "../model/rigels.ts";
import { LIGHT_COLLECTION_BY_KIND, type LightKind } from "../model/lighting.ts";
import { resolveWarmWallEntry } from "../model/warmwall.ts";
import type { Model, Pillar, Rigel, GasLine, Pipe, WarmFloor, LedStrip, StripLight, LineStrip } from "../model/types.ts";

// DTO группы «колонны, ригели, трубы, тёплый пол, световые линии, проёмы пола»:
// разрешение ссылок site-id ↔ метки model_get и тип отделки потолка.

/** Колонна по site-id или метке P1…P_n. */
export function resolvePillar(model: Model, ref: string): Pillar {
  if (model.pillars[ref]) return model.pillars[ref]!;
  const m = /^P(\d+)$/.exec(ref);
  if (m) {
    const pillars = Object.values(model.pillars);
    const pillar = pillars[Number(m[1]) - 1];
    if (pillar) return pillar;
  }
  return throwNotFound(`колонна ${ref} не найдена (id сайта или метка P<n> из model_get)`);
}

/** Ригель по site-id или метке B1…B_n. */
export function resolveRigel(model: Model, ref: string): Rigel {
  const rigels = model.rigels ?? {};
  if (rigels[ref]) return rigels[ref]!;
  const m = /^B(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(rigels);
    const rigel = list[Number(m[1]) - 1];
    if (rigel) return rigel;
  }
  return throwNotFound(`ригель ${ref} не найден (id сайта или метка B<n> из model_get)`);
}

/** Тип отделки потолка ригеля: «» или ключ инструмента листа потолка. */
export const ceilingType = z.enum([...RIGEL_CEILING_TYPES, ""]).optional()
  .describe("тип отделки потолка: \"\" — без отделки или ключ инструмента листа потолка " +
    "(stretch_ceiling, paint_ceiling, gypsum_ceiling и др. — группа ceiling_elements редактора); " +
    "произвольные значения не принимаются");

/** Та же схема без описания (rigel_update: описание не дублируется). */
export const ceilingTypeNoDesc = z.enum([...RIGEL_CEILING_TYPES, ""]).optional();

/** Газовая линия по site-id или метке G1…G_n. */
export function resolveGasLine(model: Model, ref: string): GasLine {
  const lines = model.pipes_gas ?? {};
  if (lines[ref]) return lines[ref]!;
  const m = /^G(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(lines);
    const line = list[Number(m[1]) - 1];
    if (line) return line;
  }
  return throwNotFound(`газовая линия ${ref} не найдена (id сайта или метка G<n> из model_get)`);
}

/** Труба (вода или климата) по site-id или метке TP/PW/PC/PH/PV<n> (этапы 78, 122). */
export function resolvePipe(model: Model, ref: string): { coll: string; id: string; pipe: Pipe } {
  const found = findPipe(model, ref);
  if (found) return { coll: found.coll, id: found.pipe.id, pipe: found.pipe };
  const m = /^(TP|PW|PC|PH|PV)(\d+)$/.exec(ref);
  if (m) {
    const collKey = ({ TP: "pipes", PW: "pipes_warm_floor", PC: "pipes_conditioner", PH: "pipes_heat", PV: "pipes_ventilation" } as Record<string, string>)[m[1]!]!;
    const list = Object.values((model as unknown as Record<string, Record<string, Pipe>>)[collKey] ?? {});
    const pipe = list[Number(m[2]) - 1];
    if (pipe) return { coll: collKey, id: pipe.id, pipe };
  }
  return throwNotFound(`труба ${ref} не найдена (id сайта или метка TP/PW/PC/PH/PV<n> из model_get)`);
}

/** Контур тёплого пола по site-id или метке WF<n> из model_get (этап 122). */
export function resolveWarmFloor(model: Model, ref: string): WarmFloor {
  const wfs = model.warm_floors ?? {};
  if (wfs[ref]) return wfs[ref]!;
  const m = /^WF(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(wfs);
    const wf = list[Number(m[1]) - 1];
    if (wf) return wf;
  }
  return throwNotFound(`контур тёплого пола ${ref} не найден (id сайта или метка WF<n> из model_get)`);
}

/**
 * Тёплая стена по id части (WarmLine) или метке WW<n> из warm_wall_list (этап 273).
 * Одна карта меток с warm_wall_list — модельная resolveWarmWallEntry (ревью 274 №1).
 */
export function resolveWarmWall(model: Model, ref: string): string {
  return resolveWarmWallEntry(model, ref).part.id;
}

/** Световая линия по site-id или метке LS/SL/LL1…_n из model_get (этап 84). */
export function resolveLightLine(model: Model, kind: LightKind, ref: string): LedStrip | StripLight | LineStrip {
  const label = kind === "led" ? "LS" : kind === "line" ? "LL" : "SL";
  const lines = model[LIGHT_COLLECTION_BY_KIND[kind]] ?? {};
  if (lines[ref]) return lines[ref]!;
  const m = new RegExp(`^${label}(\\d+)$`).exec(ref);
  if (m) {
    const list = Object.values(lines);
    const line = list[Number(m[1]) - 1];
    if (line) return line;
  }
  return throwNotFound(`световая линия ${ref} не найдена (id сайта или метка ${label}<n> из model_get)`);
}

/**
 * Цель связи «выключатель → …» (часть 2, 240): предмет (id сайта или I<n>) или
 * световая линия led_strips/stripes_light/line_strips (id сайта или LS/SL/LL<n>).
 * Возвращает id сущности в модели; различение предмет/линия — в addCable.
 */
export function resolveCableLamp(model: Model, ref: string): string {
  if (model.items[ref]) return ref;
  if (/^I\d+$/.test(ref)) return resolveItem(model, ref).id;
  for (const kind of ["led", "recessed", "surface", "pendent", "line"] as const) {
    try {
      return resolveLightLine(model, kind, ref).id;
    } catch {
      // не линия этого вида — пробуем следующий
    }
  }
  return resolveItem(model, ref).id; // NOT_FOUND с сообщением про предмет
}

/** Проём в полу по site-id или метке FH1…FH_n из model_get. */
export function resolveFloorHole(model: Model, ref: string): { id: string } {
  const holes = model.level_holes ?? {};
  if (holes[ref]) return holes[ref]!;
  const m = /^FH(\d+)$/.exec(ref);
  if (m) {
    const list = Object.values(holes);
    const hole = list[Number(m[1]) - 1];
    if (hole) return hole;
  }
  return throwNotFound(`проём в полу ${ref} не найден (id сайта или метка FH<n> из model_get)`);
}
