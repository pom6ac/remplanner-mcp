import type { Model, Point, PictureEntity } from "./types.ts";
export type { PictureEntity };
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";

/**
 * Изображения на плане (этап 375, бандл app.3.0 — класс Picture, коллекция
 * model.pictures; кнопка #addimage_opener нижней панели — БЕЗ is_pro в
 * разметке бесплатного тарифа, проба 375-sheets-ui):
 * serialize: {id, url, pc, pointer_pc, width, height, width_original,
 * height_original, text, font_size, plan, plan_, prs, on_border, on_pointer,
 * on_scaling_size, show_everywhere, id_shield, level_layer, id_group, type,
 * is_from_user_lib}. url — имя файла на хранилище сайта (urlStorageImages ||
 * /storage/images/ + url); width/height — размер на плане (см), редактор
 * вписывает картинку в 200×200 (бандл: >200 → пропорционально до 200);
 * width_original/height_original — размеры исходного файла (px);
 * text/font_size — подпись (restore заменяет ` на ' и `` на " —
 * canonизация уже на входе MCP: см. tools).
 *
 * Загрузка файла — POST /setup/api/load_picture/ (FormData: file, type =
 * jpeg|png|svg; ответ {status:"success", url}; лимит размера 5 242 880 байт,
 * бандл l10n.picture_more_size). MCP принимает ТОЛЬКО растровые jpeg/png
 * (svg — векторный формат, на публичном плане это инъекция) по сигнатуре
 * файла, вход — base64: MCP не читает локальные файлы по пути от модели.
 */

/** Редактор вписывает картинку в 200×200 см (бандл: onload → масштаб). */
export const PICTURE_FIT_CM = 200;

/** Ограничение длины подписи изображения. */
export const MAX_PICTURE_TEXT_CHARS = 200;

/** Имя файла хранилища: плоское имя без путей (../ и / отсечены — traversal). */
const URL_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g)$/;

export function validatePictureUrl(url: string): string {
  const u = url.replace(/^images\//, "");
  if (u.length === 0 || u.length > 200 || !URL_RE.test(u)) {
    throw new McpError("INVALID_ARGUMENT", "url — имя файла с хранилища сайта (load_picture): буквы/цифры/._- с расширением png|jpg|jpeg", {
      details: { kind: "bad_url" },
    });
  }
  return u;
}

export function addPicture(
  model: Model,
  params: { url: string; center: Point; widthMm?: number; heightMm?: number; widthOriginalPx?: number; heightOriginalPx?: number; text?: string; plan?: string },
): PictureEntity {
  const url = validatePictureUrl(params.url);
  let widthCm: number;
  let heightCm: number;
  if (params.widthMm !== undefined && params.heightMm !== undefined) {
    if (params.widthMm <= 0 || params.heightMm <= 0) {
      throw new McpError("INVALID_ARGUMENT", "width_mm/height_mm — положительные числа");
    }
    widthCm = params.widthMm / 10;
    heightCm = params.heightMm / 10;
  } else if (params.widthOriginalPx && params.heightOriginalPx) {
    // правило бандла: вписать в 200×200 с сохранением пропорций
    const w = params.widthOriginalPx;
    const h = params.heightOriginalPx;
    if (w > 200 && h > 200) {
      if (w > h) { heightCm = (200 * h) / w; widthCm = 200; }
      else { widthCm = (200 * w) / h; heightCm = 200; }
    } else if (w > 200) { heightCm = (200 * h) / w; widthCm = 200; }
    else if (h > 200) { widthCm = (200 * w) / h; heightCm = 200; }
    else { widthCm = w; heightCm = h; }
  } else {
    throw new McpError("INVALID_ARGUMENT", "нужны width_mm и height_mm, либо width_original_px и height_original_px (см. image_upload)");
  }
  const text = params.text !== undefined ? params.text.slice(0, MAX_PICTURE_TEXT_CHARS) : undefined;
  const rec: PictureEntity = {
    id: newId(),
    url,
    pc: { x: Math.round(params.center.x * 100) / 100, y: Math.round(params.center.y * 100) / 100 },
    width: Math.round(widthCm * 100) / 100,
    height: Math.round(heightCm * 100) / 100,
    width_original: params.widthOriginalPx ?? 0,
    height_original: params.heightOriginalPx ?? 0,
    ...(text !== undefined ? { text, font_size: 10 } : {}),
    plan: params.plan ?? "plan",
    prs: {},
    level_layer: 7,
    type: "user",
  };
  (model.pictures ??= {})[rec.id] = rec;
  return rec;
}

export function updatePicture(
  model: Model,
  ref: string,
  params: { center?: Point; widthMm?: number; heightMm?: number; text?: string | null; plan?: string },
): PictureEntity {
  const rec = resolvePicture(model, ref);
  if (params.center !== undefined) rec.pc = { x: Math.round(params.center.x * 100) / 100, y: Math.round(params.center.y * 100) / 100 };
  if (params.widthMm !== undefined && params.heightMm !== undefined) {
    if (params.widthMm <= 0 || params.heightMm <= 0) throw new McpError("INVALID_ARGUMENT", "width_mm/height_mm — положительные числа");
    rec.width = Math.round((params.widthMm / 10) * 100) / 100;
    rec.height = Math.round((params.heightMm / 10) * 100) / 100;
  }
  if (params.text !== undefined) {
    if (params.text === null) {
      delete rec.text;
      delete rec.font_size;
    } else {
      rec.text = params.text.slice(0, MAX_PICTURE_TEXT_CHARS);
      rec.font_size ??= 10;
    }
  }
  if (params.plan !== undefined) rec.plan = params.plan;
  return rec;
}

/** Метка PIC<n> или id сайта. */
export function resolvePicture(model: Model, ref: string): PictureEntity {
  const map = (model.pictures ?? {}) as Record<string, PictureEntity>;
  if (map[ref]) return map[ref]!;
  if (ref.startsWith("PIC")) {
    const n = Number(ref.slice(3));
    const at = Object.values(map)[n - 1];
    if (at) return at;
  }
  throw new McpError("NOT_FOUND", `изображение ${ref} не найдено`);
}

export function deletePicture(model: Model, ref: string): void {
  const rec = resolvePicture(model, ref);
  delete (model.pictures as Record<string, PictureEntity>)[rec.id];
}

/**
 * Размеры растрового файла по сигнатуре: PNG (IHDR) и JPEG (SOF0..SOF15,
 * без DHT/DAC). Возвращает {mime, width, height}; неизвестная сигнатура —
 * null (MIME по содержимому, не по расширению/заголовку запроса).
 */
export function parseImageSize(bytes: Uint8Array): { mime: "image/jpeg" | "image/png"; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // PNG: IHDR на смещении 16, big-endian
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    if (w > 0 && h > 0) return { mime: "image/png", width: w, height: h };
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: маркеры; размер — в SOF-маркерах
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      // SOF0-SOF15 без DHT(0xc4), JPG(0xc8), DAC(0xcc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        const w = (bytes[i + 7]! << 8) | bytes[i + 8]!;
        if (w > 0 && h > 0) return { mime: "image/jpeg", width: w, height: h };
        return null;
      }
      i += 2 + len;
    }
  }
  return null;
}
