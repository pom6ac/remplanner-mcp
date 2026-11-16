import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RENDERS_DIR } from "./config.ts";
import { McpError } from "./errors.ts";
import type { RenderOptions } from "./editor/adapter.ts";

// T16: render_plan — PNG плана в ~/.remplanner-mcp/renders/ + base64 для MCP image-контента.

export type RenderedPlan = {
  /** Путь к файлу PNG. */
  path: string;
  base64: string;
  mimeType: "image/png";
  widthPx: number;
  sheet: string;
  bytes: number;
  /**
   * Ревизия модели, которую показал редактор (дефект 1, отчёт 11): хэш канонической
   * модели workspace, счётчики объектов и счётчики, которые видит редактор после
   * синхронизации. Заполняется workspace, не renderPlanToFile.
   */
  revision?: RenderRevision;
};

export type RenderRevision = {
  model_hash: string;
  save_id: string | null;
  walls: number;
  openings: number;
  items: number;
  pillars?: number;
  editor: { walls: number; openings: number; items: number; pillars?: number };
};

export type RenderEditorLike = {
  objectId: string;
  renderPng(options?: RenderOptions): Promise<Buffer>;
};

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "plan";
}

function pngMagic(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/**
 * Рендер плана через адаптер редактора, запись файла в dir (по умолчанию
 * ~/.remplanner-mcp/renders/). Возвращает путь и base64 — MCP-инструмент
 * render_plan отдаёт их как image-контент.
 */
export async function renderPlanToFile(
  editor: RenderEditorLike,
  options: RenderOptions & { dir?: string } = {},
): Promise<RenderedPlan> {
  const sheet = options.sheet ?? "init";
  const widthPx = options.widthPx ?? 1600;
  // itemIds — предметы, которые должны быть видны на этом листе; без passthrough
  // проверка видимости в адаптере не получала бы ids вовсе (ревью v0.1.1 №3)
  const png = await editor.renderPng({ sheet, widthPx, dimensions: options.dimensions, itemIds: options.itemIds });
  if (!pngMagic(png)) {
    throw new McpError("SITE_ERROR", "скриншот холста не похож на PNG", { details: { bytes: png.length } });
  }
  const dir = options.dir ?? RENDERS_DIR;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${sanitize(editor.objectId)}-${stamp}.png`);
  writeFileSync(path, png);
  return { path, base64: png.toString("base64"), mimeType: "image/png", widthPx, sheet, bytes: png.length };
}
