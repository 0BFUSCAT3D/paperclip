function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies an owned config update over the parsed source while retaining unknown
 * extension keys. An explicit `undefined` removes an owned key; arrays and
 * scalar values replace their source value.
 */
export function mergeConfigValues<T>(source: T, update: T): T {
  if (!isRecord(source) || !isRecord(update)) return update;

  const merged: Record<string, unknown> = { ...source };
  for (const [key, updateValue] of Object.entries(update)) {
    if (updateValue === undefined) {
      delete merged[key];
      continue;
    }

    const sourceValue = source[key];
    merged[key] = isRecord(sourceValue) && isRecord(updateValue)
      ? mergeConfigValues(sourceValue, updateValue)
      : updateValue;
  }

  return merged as T;
}
