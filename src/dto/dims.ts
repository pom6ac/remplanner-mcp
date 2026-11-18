import { z } from "zod";
import { unescapeCommentText, type DimSheet } from "../model/dims.ts";

// DTO группы «размеры и комментарии»: публичные enum раздела «Размеры и
// комментарии» (этап 116, ревью 115 R4) и канонизация текста комментария.
// Без формата редактора: offset_side auto|left|right (внутри a|l|r), sheet
// plan|furniture (внутри a|furniture); тип привязки комментария free|item —
// семантика сайта. Преобразование только на границе API.

/** Сторона отступа размерной линии: auto (по умолчанию) | left | right. */
export const dimOffsetSide = z.enum(["auto", "left", "right"]).optional().describe("сторона отступа: auto — авто (по умолчанию), left/right — слева/справа по ходу p1→p2");
/** Лист размеров/комментариев: plan (исходный план, по умолчанию) | furniture. */
export const dimSheet = z.enum(["plan", "furniture"]).optional().describe("лист: plan (исходный план, по умолчанию) или furniture (мебель)");

const OFFSET_SIDE_INTERNAL = { auto: "a", left: "l", right: "r" } as const;

export function offsetSideInternal(v: string | undefined): "a" | "l" | "r" | undefined {
  return v === undefined ? undefined : OFFSET_SIDE_INTERNAL[v as keyof typeof OFFSET_SIDE_INTERNAL];
}

export function offsetSidePublic(v: string | undefined): string {
  return v === "l" ? "left" : v === "r" ? "right" : "auto";
}

export function sheetInternal(v: string | undefined): DimSheet | undefined {
  return v === undefined ? undefined : v === "furniture" ? "furniture" : "a";
}

export function sheetPublic(v: string | undefined): string {
  return v === "furniture" ? "furniture" : "plan";
}

/** Канонизация текста комментария (этап 116, ревью 115 R1): ввод с " и `
 *  канонизируется к виду редактора после restore; отличие от ввода — warning. */
export function commentTextWarnings(input: string | undefined, stored: string): string[] {
  const shown = unescapeCommentText(stored);
  return input !== undefined && shown !== input
    ? [`текст канонизирован под формат редактора (обратный апостроф «\`» → «'», двойные кавычки «"» → «''»): «${shown}»`]
    : [];
}
