import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL, CACHE_DIR, HTTP_TIMEOUT_MS, USER_AGENT } from "./config.ts";
import { globalLimiter } from "./http.ts";
import { McpError } from "./errors.ts";

// Позиция каталога (window.global_tools) — только нужные поля, размеры в см.
export type ToolEntry = {
  id: number;
  name: string;
  title: string;
  group: string;
  subgroup?: string;
  /** Ширина, см. */
  width: number;
  /** Глубина в плане, см (в каталоге поле height). */
  height: number;
  /** Высота, см (self_height). */
  self_height: number;
  /** Лист и порядок (plan: {furniture: 6}). */
  plan: Record<string, number>;
  resizable?: boolean;
  anchor?: string;
  is_magnetized?: boolean;
  can_be_outside?: boolean;
};

export type ToolsBundle = Record<string, Record<string, unknown>>;

/** Нормализация для поиска: нижний регистр, ё→е, схлопывание пробелов. */
export function normalizeQuery(q: string): string {
  return q.toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();
}

export function toToolEntry(name: string, raw: Record<string, unknown>): ToolEntry {
  return {
    id: typeof raw["id"] === "number" ? raw["id"] : 0,
    name,
    title: typeof raw["title"] === "string" ? raw["title"] : name,
    group: typeof raw["group"] === "string" ? raw["group"] : "",
    subgroup: typeof raw["subgroup"] === "string" ? raw["subgroup"] : undefined,
    width: typeof raw["width"] === "number" ? raw["width"] : 0,
    height: typeof raw["height"] === "number" ? raw["height"] : 0,
    self_height: typeof raw["self_height"] === "number" ? raw["self_height"] : 0,
    plan: typeof raw["plan"] === "object" && raw["plan"] !== null ? (raw["plan"] as Record<string, number>) : {},
    resizable: raw["custom_options"] === true,
    anchor: typeof raw["anchor"] === "string" ? raw["anchor"] : undefined,
    is_magnetized: raw["is_magnetized"] === true,
    can_be_outside: raw["can_be_outside"] === true,
  };
}

/** Поиск по каталогу: совпадение по title, name и group (в мм наружу). */
export function searchTools(
  tools: ToolsBundle,
  query: string,
  filters?: { group?: string; sheet?: string; limit?: number },
): ToolEntry[] {
  const q = normalizeQuery(query);
  const limit = filters?.limit ?? 20;
  const out: ToolEntry[] = [];
  for (const [name, raw] of Object.entries(tools)) {
    const entry = toToolEntry(name, raw);
    if (filters?.group && entry.group !== filters.group) continue;
    if (filters?.sheet && entry.plan[filters.sheet] === undefined) continue;
    if (q !== "") {
      const haystack = normalizeQuery(`${entry.title} ${entry.name} ${entry.group} ${entry.subgroup ?? ""}`);
      if (!haystack.includes(q)) continue;
    }
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** Извлечение window.global_tools из текста бандла planner.tools___N___ts.js. */
export function extractGlobalTools(bundleText: string): ToolsBundle {
  const marker = "window.global_tools = ";
  const idx = bundleText.indexOf(marker);
  if (idx === -1) {
    throw new McpError("EDITOR_INCOMPATIBLE", "в бандле каталога нет window.global_tools");
  }
  const start = idx + marker.length;
  let depth = 0;
  let inStr = false;
  let quote = "";
  let esc = false;
  for (let i = start; i < bundleText.length; i++) {
    const ch = bundleText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return JSON.parse(bundleText.slice(start, i + 1)) as ToolsBundle;
      }
    }
  }
  throw new McpError("EDITOR_INCOMPATIBLE", "не удалось выделить global_tools из бандла");
}

/** Имя бандла каталога со страницы редактора. */
export function extractToolsBundleName(pageHtml: string): string {
  const m = /(?:src=")?(\/files\/js\/v2\/app\/planner\.tools___\d+___\d+\.js)/.exec(pageHtml);
  if (!m) {
    throw new McpError("EDITOR_INCOMPATIBLE", "на странице редактора не найден бандл каталога planner.tools");
  }
  return m[1]!;
}

/**
 * Патчи редактора fix_tools() (бандл app.3.0, этап 57, 2026-11-16): бандл planner.tools
 * отдаёт у ряда «исходно-плановых» инструментов нулевые размеры/чужую группу, а редактор
 * сразу после загрузки правит их кодом fix_tools() (tools=window.global_tools — та же
 * ссылка). Патчи воспроизведены из исходника fix_tools (пробы 57-comm-gt/57-comm-src:
 * значения совпадают с window.global_tools живого редактора) и применяются к каталогу
 * MCP (идемпотентно — абсолютные значения):
 * - water (Сантехнический стояк): 20×20, group furniture, anchor free;
 * - water_column_hot / water_column_cold (стояки ГВС/ХВС): 10×10, furniture, free;
 * - drainage_column (Канализационный стояк): 15×15, furniture, free;
 * - ceiling_water (Ввод водоснабжения): 20×18, furniture, anchor WALL;
 * - air (Вентиляционный короб): 30×30, furniture, free;
 * - gas_pipe (Газовый стояк): delete_only:true — значение живого редактора после
 *   fix_tools; семантика флага не подтверждена (проба 57 поставила его кликом
 *   локально, без save).
 * Остальные инструменты fix_tools не трогает (radiator_old, gas_boiler, gas_meter,
 * electric_shield_old, conditioner_cage и т.д. — как в бандле).
 */
export function applyToolFixes(tools: ToolsBundle): ToolsBundle {
  const set = (name: string, patch: Record<string, unknown>): void => {
    const raw = tools[name];
    if (raw && typeof raw === "object") Object.assign(raw as Record<string, unknown>, patch);
  };
  set("water", { width: 20, height: 20, group: "furniture", anchor: "free" });
  set("water_column_hot", { width: 10, height: 10, group: "furniture", anchor: "free" });
  set("water_column_cold", { width: 10, height: 10, group: "furniture", anchor: "free" });
  set("drainage_column", { width: 15, height: 15, group: "furniture", anchor: "free" });
  set("ceiling_water", { width: 20, height: 18, group: "furniture", anchor: "wall" });
  set("air", { width: 30, height: 30, group: "furniture", anchor: "free" });
  set("gas_pipe", { delete_only: true });
  return tools;
}

function cachePath(globalVersion: string): string {
  return join(CACHE_DIR, `catalog-${globalVersion}.json`);
}

export function loadCachedTools(globalVersion: string): ToolsBundle | null {
  const path = cachePath(globalVersion);
  if (!existsSync(path)) return null;
  try {
    return applyToolFixes(JSON.parse(readFileSync(path, "utf8")) as ToolsBundle);
  } catch {
    return null;
  }
}

export function saveCachedTools(globalVersion: string, tools: ToolsBundle): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(globalVersion), JSON.stringify(tools), { mode: 0o600 });
}

/** GET бандла каталога (кэш по global_version). */
export async function fetchTools(bundleName: string, globalVersion: string): Promise<ToolsBundle> {
  const cached = loadCachedTools(globalVersion);
  if (cached) return cached;
  await globalLimiter.acquire();
  const res = await fetch(`${BASE_URL}${bundleName}`, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new McpError("SITE_ERROR", `не удалось скачать бандл каталога ${bundleName} (${res.status})`);
  }
  const tools = applyToolFixes(extractGlobalTools(await res.text()));
  saveCachedTools(globalVersion, tools);
  return tools;
}

/** Размеры позиции в мм. */
export function toolSizeMm(entry: ToolEntry): { widthMm: number; depthMm: number; heightMm: number } {
  return {
    widthMm: entry.width * 10,
    depthMm: entry.height * 10,
    heightMm: entry.self_height * 10,
  };
}
