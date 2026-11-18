// Общие помощники DTO-слоя: публичный формат ошибок «не найдено».

/** Ошибка NOT_FOUND в едином публичном формате (design §8): code в свойстве code. */
export function throwNotFound(message: string): never {
  throw Object.assign(new Error(message), { code: "NOT_FOUND" });
}
