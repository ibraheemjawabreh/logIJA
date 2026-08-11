import { percentile, requestJson } from "./http-utils.js";

interface IngestResponse {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const targetLogsPerSecond = Number(process.env["TARGET_LOGS_PER_SECOND"] ?? "15000");
const batchSize = Number(process.env["BATCH_SIZE"] ?? "32");
const durationSeconds = Number(process.env["DURATION_SECONDS"] ?? "30");
const maxInFlight = Number(process.env["MAX_IN_FLIGHT"] ?? "512");
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
      request_id: `rate-${index}`,
      attempt: index % 4,
      success: index % 7 !== 0,
    },
  };
}

const started = performance.now();
const deadline = started + durationSeconds * 1_000;
const latencies: number[] = [];
const inFlight = new Set<Promise<void>>();
let launchedBatches = 0;
let accepted = 0;
let rejected = 0;
let failedRequests = 0;
let sequence = 0;

function launchBatch(): void {
  const logs = Array.from({ length: batchSize }, () => makeLog(sequence++));
  const request = requestJson<IngestResponse>(
    `${baseUrl}/logs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs }),
    },
    200,
  )
    .then((response) => {
      latencies.push(response.milliseconds);
      accepted += response.value.accepted;
      rejected += response.value.rejected.length;
    })
    .catch(() => {
      failedRequests += 1;
    })
    .finally(() => {
      inFlight.delete(request);
    });
  inFlight.add(request);
}

while (performance.now() < deadline) {
  const expectedBatches = Math.floor(
    ((performance.now() - started) * targetLogsPerSecond) / (batchSize * 1_000),
  );

  while (launchedBatches < expectedBatches && inFlight.size < maxInFlight) {
    launchBatch();
    launchedBatches += 1;
  }

  if (inFlight.size >= maxInFlight) {
    await Promise.race(inFlight);
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

await Promise.all(inFlight);

const elapsedSeconds = (performance.now() - started) / 1_000;
console.log(
  JSON.stringify(
    {
      baseUrl,
      targetLogsPerSecond,
      batchSize,
      maxInFlight,
      durationSeconds: Number(elapsedSeconds.toFixed(2)),
      attempted: launchedBatches * batchSize,
      accepted,
      rejected,
      failedRequests,
      acceptedLogsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
      requestLatencyMs: {
        p50: Number(percentile(latencies, 50).toFixed(2)),
        p95: Number(percentile(latencies, 95).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
