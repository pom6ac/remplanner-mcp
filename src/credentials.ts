import { readFileSync, statSync } from "node:fs";
import { McpError } from "./errors.ts";

export type Credentials = {
  login: string;
  password: string;
};

/** Маскирование значения для сообщений об ошибках: не раскрывает содержимое. */
export function maskValue(value: string): string {
  if (value.length <= 2) return "***";
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

/** Парсер env-файла: `KEY=value`, кавычки, комментарии `#`, пустые строки. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

/** Права файла: true, если только владелец (0600). */
export function isPrivateMode(filePath: string): boolean {
  return (statSync(filePath).mode & 0o777) === 0o600;
}

export function readCredentials(filePath: string): Credentials {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new McpError("AUTH_REQUIRED", `нет файла учётных данных ${filePath}`, {
      hint: "создайте файл с REMPLANNER_LOGIN и REMPLANNER_PASSWORD (права 0600)",
    });
  }
  if (!isPrivateMode(filePath)) {
    process.emitWarning(`${filePath}: права шире 0600 — сузьте (chmod 600)`);
  }
  const env = parseEnvFile(text);
  const login = env["REMPLANNER_LOGIN"] ?? "";
  const password = env["REMPLANNER_PASSWORD"] ?? "";
  if (login === "" || password === "") {
    throw new McpError("AUTH_REQUIRED", `${filePath}: нет REMPLANNER_LOGIN или REMPLANNER_PASSWORD`);
  }
  return { login, password };
}

/** Убирает значения учётных данных из произвольного текста (логи, ошибки). */
export function scrubSecrets(text: string, credentials?: Credentials): string {
  let out = text;
  if (credentials) {
    if (credentials.login !== "") out = out.replaceAll(credentials.login, "login" + "=***");
    if (credentials.password !== "") out = out.replaceAll(credentials.password, "password" + "=***");
  }
  return out;
}
