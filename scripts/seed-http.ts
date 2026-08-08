import { requestJson } from "./http-utils.js";

interface IngestResponse {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const totalLogs = Number(process.env["TOTAL_LOGS"] ?? "1000000");
const batchSize = Number(process.env["BATCH_SIZE"] ?? "1000");
const concurrency = Number(process.env["CONCURRENCY"] ?? "4");
const services = ["auth", "checkout", "orders", "notifications", "users"] as const;
const levels = ["debug", "info", "warn", "error"] as const;
const regions = ["eu-west", "us-east", "ap-south"] as const;

function logAt(index: number): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() - 60_000 - (index % (30 * 24 * 60 * 60)) * 1_000).toISOString(),
    level: levels[index % levels.length],
    service: services[index % services.length],
    message:
      index % 5 === 0
        ? `payment declined seed-${index % 100}`
        : `request completed seed-${index % 100}`,
    attributes: {
      user_id: String(10_000 + (index % 50_000)),
      region: regions[index % regions.length],
      request_id: `seed-req-${index}`,
      attempt: index % 4,
      success: index % 7 !== 0,
    },
  };
}

const started = performance.now();
let accepted = 0;
let rejected = 0;
let nextOffset = 0;

async function worker(): Promise<void> {
  while (nextOffset < totalLogs) {
    const offset = nextOffset;
    nextOffset += batchSize;
    const size = Math.min(batchSize, totalLogs - offset);
    const logs = Array.from({ length: size }, (_, index) => logAt(offset + index));
    const response = await requestJson<IngestResponse>(
      `${baseUrl}/logs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs }),
      },
      200,
    );
    accepted += response.value.accepted;
    rejected += response.value.rejected.length;

    if (accepted % 100_000 === 0 || accepted === totalLogs) {
      console.log(`accepted=${accepted} rejected=${rejected}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const elapsedSeconds = (performance.now() - started) / 1_000;
console.log(
  JSON.stringify(
    {
      baseUrl,
      totalLogs,
      batchSize,
      concurrency,
      accepted,
      rejected,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      acceptedLogsPerSecond: Number((accepted / elapsedSeconds).toFixed(2)),
    },
    null,
    2,
  ),
);
