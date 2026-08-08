import { isoOffset, requestJson } from "./http-utils.js";

interface HealthResponse {
  status: string;
}

interface IngestResponse {
  accepted: number;
  rejected: unknown[];
}

interface ListResponse {
  logs: unknown[];
  next_cursor: string | null;
}

interface AggregateResponse {
  buckets: unknown[];
}

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const service = `smoke-${Date.now()}`;
const timestamp = isoOffset(-60_000);
const since = isoOffset(-5 * 60_000);
const until = isoOffset(60_000);

const health = await requestJson<HealthResponse>(`${baseUrl}/health`);
if (health.value.status !== "ok") {
  throw new Error(`Expected health status ok, got ${health.value.status}`);
}

const ingest = await requestJson<IngestResponse>(
  `${baseUrl}/logs`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      logs: [
        {
          timestamp,
          level: "error",
          service,
          message: "smoke payment declined",
          attributes: { user_id: "42", request_id: service, attempt: 1, success: false },
        },
      ],
    }),
  },
  200,
);
if (ingest.value.accepted !== 1 || ingest.value.rejected.length !== 0) {
  throw new Error(`Unexpected ingestion response: ${JSON.stringify(ingest.value)}`);
}

const list = await requestJson<ListResponse>(
  `${baseUrl}/logs?service=${encodeURIComponent(service)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
);
if (list.value.logs.length !== 1 || list.value.next_cursor !== null) {
  throw new Error(`Unexpected list response: ${JSON.stringify(list.value)}`);
}

const aggregate = await requestJson<AggregateResponse>(
  `${baseUrl}/logs/aggregate?service=${encodeURIComponent(service)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m`,
);
if (aggregate.value.buckets.length !== 1) {
  throw new Error(`Unexpected aggregate response: ${JSON.stringify(aggregate.value)}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      health_ms: Number(health.milliseconds.toFixed(2)),
      ingest_ms: Number(ingest.milliseconds.toFixed(2)),
      list_ms: Number(list.milliseconds.toFixed(2)),
      aggregate_ms: Number(aggregate.milliseconds.toFixed(2)),
    },
    null,
    2,
  ),
);
