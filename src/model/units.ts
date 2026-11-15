// Единицы: инструменты говорят на миллиметрах, модель сайта хранит сантиметры.
// Точность хранения — 0,1 мм = 0,01 см.

/** мм → см (с округлением до 0,1 мм). */
export function mmToCm(mm: number): number {
  return roundTenthMm(mm / 10);
}

/** см → мм. */
export function cmToMm(cm: number): number {
  return roundTenthMm(cm * 10);
}

/** Округление до 0,1 мм (0,01 см). */
export function roundTenthMm(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Округление до 0,1 мм в см (совместимое имя). */
export const round1 = roundTenthMm;

/** Округление до 1 мм (0,1 см). */
export function round0(value: number): number {
  return Math.round(value);
}

/** Площадь см² → м², две значащие цифры после запятой. */
export function cm2ToM2(cm2: number): number {
  return Math.round((cm2 / 10_000) * 100) / 100;
}
