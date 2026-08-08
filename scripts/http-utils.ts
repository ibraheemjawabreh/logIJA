export interface TimedResult<T> {
  value: T;
  milliseconds: number;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<TimedResult<T>> {
  const start = performance.now();
  const response = await fetch(url, init);
  const milliseconds = performance.now() - start;
  const text = await response.text();
  const value = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);

  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus} from ${url}, got ${response.status}: ${text}`);
  }

  return { value, milliseconds };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function isoOffset(millisecondsFromNow: number): string {
  return new Date(Date.now() + millisecondsFromNow).toISOString();
}
