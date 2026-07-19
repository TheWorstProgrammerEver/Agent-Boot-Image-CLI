const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortValue(child)]),
  );
};

export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(sortValue(value), null, 2)}\n`;

export const canonicalJsonBytes = (value: unknown): Buffer =>
  Buffer.from(canonicalJson(value), "utf8");
