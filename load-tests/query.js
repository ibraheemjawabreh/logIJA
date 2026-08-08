import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: Number(__ENV.VUS || 4),
  duration: __ENV.DURATION || "1m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://localhost:8080";
const since = __ENV.SINCE || new Date(Date.now() - 60 * 60 * 1000).toISOString();
const until = __ENV.UNTIL || new Date(Date.now() + 60 * 1000).toISOString();

export default function () {
  const requests = [
    [
      `${baseUrl}/logs?service=checkout&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      "service filter",
    ],
    [
      `${baseUrl}/logs?level=error&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      "level filter",
    ],
    [
      `${baseUrl}/logs?attr.region=eu-west&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      "attr filter",
    ],
    [
      `${baseUrl}/logs?q=declined&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      "q filter",
    ],
    [
      `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m`,
      "aggregate 1m",
    ],
    [
      `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=service`,
      "aggregate service",
    ],
  ];

  const [url, name] = requests[__ITER % requests.length];
  const response = http.get(url);
  check(response, {
    [`${name} returns 200`]: (r) => r.status === 200,
  });
  sleep(1);
}
