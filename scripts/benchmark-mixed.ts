import { percentile, requestJson } from "./http-utils.js";

interface IngestResponse {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const batchSize = Number(process.env["BATCH_SIZE"] ?? "5000");
const durationSeconds = Number(process.env["DURATION_SECONDS"] ?? "20");
const concurrency = Number(process.env["CONCURRENCY"] ?? "4");
const services = ["auth", "checkout", "orders", "notifications", "users"] as const;
const levels = ["debug", "info", "warn", "error"] as const;

function makeLog(index: number): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() - 60_000 + (index % 1_000)).toISOString(),
    level: levels[index % levels.length],
    service: services[index % services.length],
    message: index % 5 === 0 ? "payment declined" : "request completed",
    attributes: {
      user_id: String(10_000 + (index % 50_000)),
      region: index % 2 === 0 ? "eu-west" : "us-east",
      request_id: `mixed-${index}`,
      attempt: index % 4,
      success: index % 7 !== 0,
    },
  };
}

const started = performance.now();
const deadline = Date.now() + durationSeconds * 1_000;
const ingestLatencies: number[] = [];
const aggregateLatencies: number[] = [];
let sequence = 0;
let accepted = 0;
let rejected = 0;
let failedRequests = 0;
let aggregateFailures = 0;

async function ingestWorker(workerId: number): Promise<void> {
  while (Date.now() < deadline) {
    const logs = Array.from({ length: batchSize }, () =>
      makeLog(sequence++ + workerId * 1_000_000_000),
    );
    try {
      const response = await requestJson<IngestResponse>(
        `${baseUrl}/logs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logs }),
        },
        200,
      );
      ingestLatencies.push(response.milliseconds);
      accepted += response.value.accepted;
      rejected += response.value.rejected.length;
    } catch (error) {
      failedRequests += 1;
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function aggregateWorker(): Promise<void> {
  while (Date.now() < deadline) {
    const tickStart = performance.now();
    const since = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const until = new Date(Date.now() + 60 * 1_000).toISOString();
    try {
      const response = await requestJson(
        `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m`,
      );
      aggregateLatencies.push(response.milliseconds);
    } catch (error) {
      aggregateFailures += 1;
      console.error(error instanceof Error ? error.message : String(error));
    }
    const remaining = 1_000 - (performance.now() - tickStart);
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  }
}

await Promise.all([
  ...Array.from({ length: concurrency }, (_, index) => ingestWorker(index)),
  aggregateWorker(),
]);

const elapsedSeconds = (performance.now() - started) / 1_000;
console.log(
  JSON.stringify(
    {
      baseUrl,
      batchSize,
      concurrency,
      durationSeconds: Number(elapsedSeconds.toFixed(2)),
      accepted,
      rejected,
      failedRequests,
      acceptedLogsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
      ingestLatencyMs: {
        p50: Number(percentile(ingestLatencies, 50).toFixed(2)),
        p95: Number(percentile(ingestLatencies, 95).toFixed(2)),
      },
      aggregation: {
        requests: aggregateLatencies.length,
        failedRequests: aggregateFailures,
        p95Ms: Number(percentile(aggregateLatencies, 95).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
