import type { SessionState } from "./session.ts";
import { BASE_URL, HTTP_TIMEOUT_MS, USER_AGENT } from "./config.ts";
import { cookieHeader } from "./session.ts";
import { McpError } from "./errors.ts";
import { globalLimiter, httpRequestJson, httpRequestRaw, saveLimiter, safePath } from "./http.ts";

export type ClientProject = {
  object_id: string;
  version: string;
  title: string;
  area_m2: number | null;
  floors: number | null;
  plans: number | null;
  backups: number | null;
  updated: string | null;
};

export type ClientPageInfo = {
  logged_in: boolean;
  login_error: boolean;
  tariff: "free" | "pro" | "unknown";
  projects: ClientProject[];
};

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Текст активного пункта блока pro_status — целиком, после stripTags содержимого
 *  элемента (258 №3в): «Расширенный тариф не подключён» — не pro. */
const SENIOR_ITEM_TEXT_RE = /^расширенный тариф$/i;
/** Явное отрицание в тексте пункта (258 №3в) — free, приоритет над описаниями PRO. */
const ITEM_NEGATION_RE = /(^|[^\s])\s*не\s+(подключ[её]н|активен)/i;
/** Старые тексты страницы «PRO подключен» — вся страница, без блока pro_status_item.
 *  (?<!не\s) — не совпадать внутри отрицания «PRO не активен» (258 №3а). */
const SENIOR_PAGE_RE = /(?<!не\s)Версия PRO:\s*подключена|(?<!не\s)PRO активен/i;
/** Free-маркеры и явные отрицания старшего тарифа (258 №3а). */
const FREE_RE = /Версия PRO:\s*не\s+подключ[её]на|в бесплатной верси|PRO\s+не\s+активен/i;
/** Активный пункт блока pro_status: атрибут class (не data-class — 258 №3б) с
 *  токеном `active` (границы слова: inactive/notactive не совпадают). */
const PRO_STATUS_ITEM_RE = /<[^>]*\sclass="([^"]*\buser_cabinet_pro_status_item\b[^"]*)"[^>]*>/g;
const ACTIVE_TOKEN_RE = /(^|\s)active(\s|$)/;
/** Ссылка «сменить» внутри активного пункта (живая разметка ЛК, шаг 260):
 *  её подпись не часть названия тарифа — вырезается до stripTags. */
const UPGRADE_LINK_RE = /<a\b[^>]*\buser_cabinet_pro_status_upgrade\b[^>]*>[\s\S]*?<\/a>/i;

/** Разбор HTML личного кабинета /client/ (только чтение). */
export function parseClientPage(html: string): ClientPageInfo {
  const logged_in = /id="clientline"[^>]*is_logged/.test(html) || /id="user_cabinet_objects"/.test(html);
  const login_error = /class="pre_error"/.test(html);
  // Этап 256 (ревью №2) + 258 №3: тариф — по нескольким сигналам. Приоритет:
  // активный пункт блока pro_status (текст целиком после stripTags — вложенная
  // разметка тоже читается), затем явные отрицания, затем free-маркеры, и лишь
  // потом фразы-описания PRO на странице. Free-маркер вместе с признаком
  // страницы — unknown (безопасный отказ гейта, не ложное «pro»/«free»).
  let tariff: ClientPageInfo["tariff"] = "unknown";
  const itemRe = new RegExp(PRO_STATUS_ITEM_RE.source, "g");
  const starts = [...html.matchAll(itemRe)];
  const items = starts.map((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : Math.min(from + 400, html.length);
    const chunk = html.slice(from, to).replace(UPGRADE_LINK_RE, " ");
    const close = /<\/div>/i.exec(chunk);
    const text = stripTags(close ? chunk.slice(0, close.index) : chunk).trim();
    return { cls: m[1]!, text };
  });
  const active = items.find((i) => ACTIVE_TOKEN_RE.test(i.cls));
  if (active) {
    if (SENIOR_ITEM_TEXT_RE.test(active.text)) tariff = "pro";
    else if (ITEM_NEGATION_RE.test(active.text)) tariff = "free";
  } else {
    const free = FREE_RE.test(html);
    const senior = SENIOR_PAGE_RE.test(html);
    if (free && senior) tariff = "unknown";
    else if (free) tariff = "free";
    else if (senior) tariff = "pro";
  }
  const projects: ClientProject[] = [];
  const rowRe = /<tr[^>]*\bid="object(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  for (const match of html.matchAll(rowRe)) {
    const object_id = match[1] ?? "";
    const row = match[2] ?? "";
    const title = stripTags(/<input[^>]*name="oname\[\d+\]"[^>]*value="([^"]*)"/.exec(row)?.[1] ?? "");
    const version = /v\d\.\d/.exec(row)?.[0] ?? "";
    const num = (label: string): number | null => {
      const m = new RegExp(`${label}:\\s*(\\d+)`).exec(stripTags(row));
      return m?.[1] !== undefined ? Number(m[1]) : null;
    };
    const areaM = /([\d.,]+)\s*м²/.exec(stripTags(row));
    projects.push({
      object_id,
      version,
      title,
      area_m2: areaM?.[1] !== undefined ? Number(areaM[1].replace(",", ".")) : null,
      floors: num("Этажи"),
      plans: num("Планировки"),
      backups: num("Резервные копии"),
      updated: /Сохранено\s+([^<]+)</.exec(row)?.[1]?.trim() ?? null,
    });
  }
  return { logged_in, login_error, tariff, projects };
}

/** Признак истёкшей сессии в ответах API. */
export function isReloadResponse(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>)["reload"] === 101
  );
}

export async function fetchClientPage(session: SessionState): Promise<string> {
  await globalLimiter.acquire();
  const res = await fetch(`${BASE_URL}/client/`, {
    headers: {
      cookie: cookieHeader(session, "remplanner.ru"),
      "user-agent": USER_AGENT,
      referer: `${BASE_URL}/client/`,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 429) {
    throw new McpError("CAPTCHA_REQUIRED", `сайт ответил ${res.status} на /client/`);
  }
  return res.text();
}

/** Статус сессии по странице ЛК: logged_in, тариф, проекты. */
export async function checkStatus(session: SessionState): Promise<ClientPageInfo> {
  return parseClientPage(await fetchClientPage(session));
}

// ---------- Модель проекта (A-транспорт) ----------

export type RawLoadResponse = {
  object_id: string;
  plan_id: string;
  floor_id?: string;
  save_id: string;
  data: string;
  floors?: unknown;
  units?: string;
  switches?: unknown;
};

export type LoadedModel = {
  object_id: string;
  plan_id: string;
  save_id: string;
  units: string;
  model: Record<string, unknown>;
  /** true — сервер вернул пустую строку data (проект без сохранений). */
  data_empty?: boolean;
  /** Сырой floors из ответа GET (этажи/планировки объекта) — для гардов проб
   *  «PLAN_ID принадлежит объекту» (ревью 319 №3); форма не нормализуется. */
  floors?: unknown;
};

/** Разбор ответа GET /setup/api/planner/: data — строка JSON модели. */
export function parseLoadResponse(body: RawLoadResponse): LoadedModel {
  if (typeof body?.data !== "string") {
    throw new McpError("SITE_ERROR", "в ответе загрузки нет строки data");
  }
  let model: Record<string, unknown>;
  try {
    // пустой проект: data == ""
    model = body.data.trim() === "" ? {} : (JSON.parse(body.data) as Record<string, unknown>);
  } catch {
    throw new McpError("SITE_ERROR", "строка data не является JSON модели");
  }
  return {
    object_id: String(body.object_id ?? ""),
    plan_id: String(body.plan_id ?? ""),
    save_id: String(body.save_id ?? ""),
    units: body.units ?? "cm",
    model,
    data_empty: body.data.trim() === "",
    floors: body.floors,
  };
}

export async function loadModel(session: SessionState, objectId: string, planId = "1"): Promise<LoadedModel> {
  const body = await httpRequestJson<RawLoadResponse>({
    path: `/setup/api/planner/?object_id=${encodeURIComponent(objectId)}&plan_id=${encodeURIComponent(planId)}`,
    session,
  });
  return parseLoadResponse(body);
}

export type RawSaveResponse = {
  result: "success" | "fail";
  save_id?: string;
  c?: unknown;
  html_code?: string;
};

export type SaveResult = {
  ok: boolean;
  save_id: string | null;
  conflict: boolean;
};

export function parseSaveResponse(body: RawSaveResponse): SaveResult {
  if (body.result === "success") {
    return { ok: true, save_id: body.save_id ?? null, conflict: false };
  }
  // result:"fail" + html_code — диалог «Сохранить все равно»: серверная сторона SAVE_CONFLICT (T1a)
  return { ok: false, save_id: null, conflict: /Сохранить все равно|save_project_from_fog/i.test(body.html_code ?? "") };
}

export type SaveModelParams = {
  objectId: string;
  planId: string;
  authkey: string;
  saveId: string;
  model: unknown;
  isForced?: boolean;
};

export async function saveModel(session: SessionState, params: SaveModelParams): Promise<SaveResult> {
  const data = JSON.stringify(params.model);
  const query = new URLSearchParams({
    object_id: params.objectId,
    plan_id: params.planId,
    plan: "a",
    authkey: params.authkey,
    save_id: params.saveId,
    is_resave: "0",
    is_forced: params.isForced ? "1" : "0",
  });
  const form = new URLSearchParams({
    plan_data: data,
    plan_length: String(data.length),
    session: "0",
    version: "3.0",
    save_id: params.saveId,
    planner_version: "3",
    visual_data: "",
    switches: "[]",
    active_tabs: "",
  });
  const res = await httpRequestRaw({
    path: `/setup/api/planner/save/?${query.toString()}`,
    method: "POST",
    session,
    body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    limiter: saveLimiter,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // путь с authkey в query не включаем в ошибку (№1); сырое тело тоже
    throw new McpError("SITE_ERROR", `не-JSON ответ на ${safePath("/setup/api/planner/save/")}`);
  }
  // reload:101 — истёкшая сессия; раньше проглатывалось parseSaveResponse (№13)
  if (isReloadResponse(body)) {
    throw new McpError("SESSION_EXPIRED", "сессия истекла (reload:101) при сохранении", {
      hint: "выполните npm run login",
    });
  }
  return parseSaveResponse(body as RawSaveResponse);
}

/** Переименование проекта в ЛК (нужна аккаунтная сессия). */
export async function renameProject(session: SessionState, objectId: string, title: string): Promise<void> {
  await httpRequestRaw({
    path: "/client/ajax/object_edit_name/",
    method: "POST",
    session,
    body: new URLSearchParams({ object_id: objectId, name: title }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
  });
}

// ---------- Анонимные проекты ----------

export type AnonProjectCreated = {
  object_id: string;
  plan_id: string;
};

/** Безопасная сводка о нечитаемом ответе: без фрагментов тела. */
export function unknownBodySummary(status: number, contentType: string | null, bytes: number): Record<string, unknown> {
  return { status, content_type: contentType ?? "unknown", bytes };
}

/** Разбор ответа POST /planner/create/ (без входа; проект привязан к cookie visitor_id). */
export function parseCreateResponse(body: unknown): AnonProjectCreated {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const objectId = (b.object_id ?? b.id ?? b.oid) as string | number | undefined;
    const planId = (b.plan_id ?? b.pid) as string | number | undefined;
    if (objectId !== undefined && objectId !== null && String(objectId) !== "") {
      return { object_id: String(objectId), plan_id: planId !== undefined && planId !== null ? String(planId) : "" };
    }
  }
  // сырое тело наружу не идёт (этап 145, B1); сводку добавляет createAnonProject
  throw new McpError("SITE_ERROR", "не удалось разобрать ответ создания проекта");
}

export async function createAnonProject(session: SessionState): Promise<AnonProjectCreated> {
  const res = await httpRequestRaw({
    path: "/planner/create/",
    method: "POST",
    session,
    captureCookiesInto: session,
    body: new URLSearchParams({ version: "3.0", create_trigger: "1" }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
  });
  // сервер отвечает 302 на /planner/ и ставит cookies object_id / object_plan_id / visitor_id
  if (res.status >= 300 && res.status < 400) {
    await res.text().catch(() => "");
    const objectId = session.cookies.find((c) => c.name === "object_id")?.value ?? "";
    const planId = session.cookies.find((c) => c.name === "object_plan_id")?.value ?? "";
    if (objectId !== "") return { object_id: objectId, plan_id: planId };
    throw new McpError("SITE_ERROR", "создание проекта не вернуло object_id (нет cookie object_id)");
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // сырое тело (может содержать секреты/ПДн) наружу не идёт — только сводка (этап 145, B1)
    throw new McpError("SITE_ERROR", "не-JSON ответ на создание проекта", {
      details: unknownBodySummary(res.status, res.headers.get("content-type"), text.length),
    });
  }
  try {
    return parseCreateResponse(body);
  } catch (e) {
    if (e instanceof McpError && e.details === undefined) {
      throw new McpError(e.code, e.message, { hint: e.hint, details: unknownBodySummary(res.status, res.headers.get("content-type"), text.length) });
    }
    throw e;
  }
}
