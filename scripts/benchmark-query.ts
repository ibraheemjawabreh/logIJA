import { percentile, requestJson } from "./http-utils.js";

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const iterations = Number(process.env["ITERATIONS"] ?? "60");
const since = process.env["SINCE"] ?? new Date(Date.now() - 60 * 60 * 1_000).toISOString();
const until = process.env["UNTIL"] ?? new Date(Date.now() + 60_000).toISOString();

const aggregateLatencies: number[] = [];
const listLatencies: number[] = [];

for (let i = 0; i < iterations; i += 1) {
  const list = await requestJson(
    `${baseUrl}/logs?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100`,
  );
  listLatencies.push(list.milliseconds);

  const aggregate = await requestJson(
    `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`,
  );
  aggregateLatencies.push(aggregate.milliseconds);
}

console.log(
  JSON.stringify(
    {
      baseUrl,
      iterations,
      since,
      until,
      listLatencyMs: {
        p50: Number(percentile(listLatencies, 50).toFixed(2)),
        p90: Number(percentile(listLatencies, 90).toFixed(2)),
        p95: Number(percentile(listLatencies, 95).toFixed(2)),
        p99: Number(percentile(listLatencies, 99).toFixed(2)),
      },
      aggregateLatencyMs: {
        p50: Number(percentile(aggregateLatencies, 50).toFixed(2)),
        p90: Number(percentile(aggregateLatencies, 90).toFixed(2)),
        p95: Number(percentile(aggregateLatencies, 95).toFixed(2)),
        p99: Number(percentile(aggregateLatencies, 99).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
