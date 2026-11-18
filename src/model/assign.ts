/**
 * Общий перенос проверенного кандидата в объект модели (аудит 65, C3; план №7):
 * значения присваиваются по объединению ключей target/candidate (мелкое
 * присваивание — вложенные объекты и массивы перенимаются по ссылке от
 * кандидата), ключи, которых у кандидата нет, удаляются. Порядок ключей:
 * сначала ключи исходного объекта, затем новые ключи кандидата. Исходный объект
 * не заменяется — identity в коллекции сохраняется; вызов делается один раз
 * после всех проверок, до него исходный объект не меняется (ревью 28, паттерн
 * assignHole).
 */
export function assignCandidate<T extends object>(target: T, candidate: T): void {
  const keys = new Set([...Object.keys(target), ...Object.keys(candidate)]);
  for (const k of keys) {
    if (k in candidate) (target as Record<string, unknown>)[k] = (candidate as Record<string, unknown>)[k];
    else delete (target as Record<string, unknown>)[k];
  }
}
