import type { Model, Point, PictureEntity } from "./types.ts";
export type { PictureEntity };
import { newId } from "./types.ts";
import { McpError } from "../errors.ts";
import { canonicalCommentText, escapeCommentText, unescapeCommentText } from "./dims.ts";
import { isSafePictureText } from "./strings.ts";

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
 * text/font_size — подпись. Формат текста — тот же, что у комментариев
 * (Comments.copy("server")/restore бандла): в модели хранится server-форма
 * (escapeCommentText(canonicalCommentText(text)); ' → `, " → ``), restore и
 * copy('server') Pictures бандла проходят её без изменений (major 376 №2).
 * Подпись пишется ВСЕГДА (text: "" и font_size: 10 — как Picture ctor бандла,
 * major 376 №1): Pictures.restore бандла первой строкой делает
 * e.text.replace — запись без text падает TypeError на restore, а сверка до
 * save сравнивает undefined с "".
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

/** Имя файла хранилища: 1–3 сегмента [A-Za-z0-9_-] с расширением png|jpg|jpeg
 *  (сервер отдаёт url с шардовыми подкаталогами «c8/a3/файл.png»; «..», абсолютные
 *  пути и прочие схемы отсечены — traversal/инъекция). */
const URL_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,2}\.(png|jpe?g)$/;

/** Предикат url хранилища (для схемы импорта, minor 376 №9). */
export function isPictureUrl(url: string): boolean {
  return URL_RE.test(url.replace(/^images\//, ""));
}

export function validatePictureUrl(url: string): string {
  const u = url.replace(/^images\//, "");
  if (u.length === 0 || u.length > 200 || !URL_RE.test(u)) {
    throw new McpError("INVALID_ARGUMENT", "url — имя файла с хранилища сайта (load_picture): буквы/цифры/._- с расширением png|jpg|jpeg", {
      details: { kind: "bad_url" },
    });
  }
  return u;
}

/**
 * Подпись изображения: < > & запрещены (консервативный белый список — подпись
 * рисуется svg.js как SVG-текст, но тот же класс входа, что имя листа);
 * ` " ' канонизируются в server-форму (major 376 №2), как у комментариев.
 * Бросает McpError для < > &, возвращает server-форму.
 */
export function canonicalPictureText(text: string): string {
  const cut = text.slice(0, MAX_PICTURE_TEXT_CHARS);
  if (!isSafePictureText(cut)) {
    throw new McpError("INVALID_ARGUMENT", "text подписи: символы < > & запрещены (строка попадает в документ редактора)", {
      details: { kind: "unsafe_string", field: "text" },
    });
  }
  return escapeCommentText(canonicalCommentText(cut));
}

/** Warning канонизации подписи (как у комментариев, dto/dims commentTextWarnings). */
export function pictureTextWarnings(input: string | undefined, stored: string): string[] {
  const shown = unescapeCommentText(stored);
  return input !== undefined && shown !== input
    ? [`подпись канонизирована под формат редактора (обратный апостроф «\`» → «'», двойные кавычки «"» → «''»): «${shown}»`]
    : [];
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
  // major 376 №1: подпись пишется ВСЕГДА (text "" + font_size 10 — конструктор
  // Picture бандла text=e.text||"", font_size=e.font_size||10): Pictures.restore
  // бандла делает e.text.replace и падает на записи без text; serialize
  // редактора всегда отдаёт text.
  const text = canonicalPictureText(params.text ?? "");
  const rec: PictureEntity = {
    id: newId(),
    url,
    pc: { x: Math.round(params.center.x * 100) / 100, y: Math.round(params.center.y * 100) / 100 },
    width: Math.round(widthCm * 100) / 100,
    height: Math.round(heightCm * 100) / 100,
    width_original: params.widthOriginalPx ?? 0,
    height_original: params.heightOriginalPx ?? 0,
    text,
    font_size: 10,
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
    // major 376 №1: text:null — подпись в пустую (""), а НЕ удаление поля:
    // serialize редактора всегда отдаёт text, Picture ctor — text||""
    rec.text = canonicalPictureText(params.text === null ? "" : params.text);
    rec.font_size ??= 10;
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

/** Удаление по метке PIC<n> или id сайта; возвращает id удалённой записи
 *  (minor 376 №5: ответ image_delete должен называть именно удалённое —
 *  после удаления метка PIC<n> указывает на следующее изображение). */
export function deletePicture(model: Model, ref: string): string {
  const rec = resolvePicture(model, ref);
  delete (model.pictures as Record<string, PictureEntity>)[rec.id];
  return rec.id;
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
