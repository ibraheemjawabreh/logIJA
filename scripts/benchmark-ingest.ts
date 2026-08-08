import { percentile, requestJson } from "./http-utils.js";

interface IngestResponse {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const batchSize = Number(process.env["BATCH_SIZE"] ?? "500");
const durationSeconds = Number(process.env["DURATION_SECONDS"] ?? "15");
const concurrency = Number(process.env["CONCURRENCY"] ?? "4");
const services = ["auth", "checkout", "orders", "notifications", "users"] as const;
const levels = ["debug", "info", "warn", "error"] as const;
const messages = [
  "request completed",
  "payment declined",
  "password reset requested",
  "notification delivered",
  "order queued",
] as const;

function makeLog(index: number): Record<string, unknown> {
  const timestamp = new Date(Date.now() - 60_000 + (index % 1000)).toISOString();
  return {
    timestamp,
    level: levels[index % levels.length],
    service: services[index % services.length],
    message: `${messages[index % messages.length]} benchmark-${index % 100}`,
    attributes: {
      user_id: String(10_000 + (index % 50_000)),
      region: index % 2 === 0 ? "eu-west" : "us-east",
      request_id: `req-${index}`,
      attempt: index % 4,
      success: index % 7 !== 0,
    },
  };
}

const end = Date.now() + durationSeconds * 1_000;
const latencies: number[] = [];
let attempted = 0;
let accepted = 0;
let rejected = 0;
let failedRequests = 0;
let sequence = 0;

async function worker(workerId: number): Promise<void> {
  while (Date.now() < end) {
    const logs = Array.from({ length: batchSize }, () =>
      makeLog(sequence++ + workerId * 1_000_000_000),
    );
    attempted += logs.length;
    try {
      const result = await requestJson<IngestResponse>(
        `${baseUrl}/logs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logs }),
        },
        200,
      );
      latencies.push(result.milliseconds);
      accepted += result.value.accepted;
      rejected += result.value.rejected.length;
    } catch (err) {
      failedRequests += 1;
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

const elapsedSeconds = durationSeconds;
console.log(
  JSON.stringify(
    {
      baseUrl,
      batchSize,
      durationSeconds,
      concurrency,
      attempted,
      accepted,
      rejected,
      failedRequests,
      attemptedLogsPerSecond: Number((attempted / elapsedSeconds).toFixed(2)),
      acceptedLogsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
      requestLatencyMs: {
        p50: Number(percentile(latencies, 50).toFixed(2)),
        p90: Number(percentile(latencies, 90).toFixed(2)),
        p95: Number(percentile(latencies, 95).toFixed(2)),
        p99: Number(percentile(latencies, 99).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
