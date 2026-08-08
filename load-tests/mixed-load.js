import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { makeBatch } from "./generator.js";

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-vus",
      vus: Number(__ENV.INGEST_VUS || 4),
      duration: __ENV.DURATION || "1m",
      exec: "ingest",
    },
    query: {
      executor: "constant-vus",
      vus: Number(__ENV.QUERY_VUS || 1),
      duration: __ENV.DURATION || "1m",
      exec: "query",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:8080";
const batchSize = Number(__ENV.BATCH_SIZE || 500);
const acceptedLogs = new Counter("accepted_logs");

export function ingest() {
  const start = __VU * 1_000_000_000 + __ITER * batchSize;
  const response = http.post(`${baseUrl}/logs`, JSON.stringify(makeBatch(start, batchSize)), {
    headers: { "content-type": "application/json" },
  });
  check(response, { "POST /logs is 200": (r) => r.status === 200 });
  if (response.status === 200) {
    acceptedLogs.add(response.json().accepted || 0);
  }
}

export function query() {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const until = new Date(Date.now() + 60 * 1000).toISOString();
  const urls = [
    `${baseUrl}/logs?service=checkout&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100`,
    `${baseUrl}/logs?level=error&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100`,
    `${baseUrl}/logs?attr.region=eu-west&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100`,
    `${baseUrl}/logs?q=declined&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=100`,
    `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m`,
    `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`,
  ];
  const response = http.get(urls[__ITER % urls.length]);
  check(response, { "query returns 200": (r) => r.status === 200 });
  sleep(1);
}
