import { percentile, requestJson } from "./http-utils.js";

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const iterations = Number(process.env["ITERATIONS"] ?? "60");
const since = process.env["SINCE"] ?? new Date(Date.now() - 60 * 60 * 1_000).toISOString();
const until = process.env["UNTIL"] ?? new Date(Date.now() + 60_000).toISOString();

const serviceLatencies: number[] = [];
const levelLatencies: number[] = [];
const encodedSince = encodeURIComponent(since);
const encodedUntil = encodeURIComponent(until);

for (let i = 0; i < iterations; i += 1) {
  const service = await requestJson(
    `${baseUrl}/logs?service=checkout&since=${encodedSince}&until=${encodedUntil}&limit=100`,
  );
  serviceLatencies.push(service.milliseconds);

  const level = await requestJson(
    `${baseUrl}/logs?level=error&since=${encodedSince}&until=${encodedUntil}&limit=100`,
  );
  levelLatencies.push(level.milliseconds);
}

function summary(latencies: readonly number[]): { p50: number; p95: number } {
  return {
    p50: Number(percentile(latencies, 50).toFixed(2)),
    p95: Number(percentile(latencies, 95).toFixed(2)),
  };
}

console.log(
  JSON.stringify(
    {
      baseUrl,
      iterations,
      since,
      until,
      serviceLatencyMs: summary(serviceLatencies),
      levelLatencyMs: summary(levelLatencies),
    },
    null,
    2,
  ),
);
