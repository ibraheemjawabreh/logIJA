import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import { makeBatch } from "./generator.js";

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 4),
      duration: __ENV.DURATION || "1m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:8080";
const batchSize = Number(__ENV.BATCH_SIZE || 500);
const acceptedLogs = new Counter("accepted_logs");
const rejectedLogs = new Counter("rejected_logs");
const ingestionOk = new Rate("ingestion_ok");

export default function () {
  const start = __VU * 1_000_000_000 + __ITER * batchSize;
  const response = http.post(`${baseUrl}/logs`, JSON.stringify(makeBatch(start, batchSize)), {
    headers: { "content-type": "application/json" },
  });
  const ok = check(response, {
    "POST /logs is 200": (r) => r.status === 200,
  });
  ingestionOk.add(ok);
  if (response.status === 200) {
    const body = response.json();
    acceptedLogs.add(body.accepted || 0);
    rejectedLogs.add((body.rejected || []).length);
  }
}
