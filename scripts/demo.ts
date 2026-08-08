import { isoOffset, requestJson } from "./http-utils.js";

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const service = `demo-${Date.now()}`;
const timestamp = isoOffset(-60_000);
const since = isoOffset(-10 * 60_000);
const until = isoOffset(60_000);

console.log("1. Health");
console.log((await requestJson(`${baseUrl}/health`)).value);

console.log("2. Insert sample logs");
console.log(
  (
    await requestJson(
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
              message: "demo payment declined",
              attributes: { user_id: "42", region: "eu-west", attempt: 1, success: false },
            },
            {
              timestamp,
              level: "info",
              service,
              message: "demo checkout recovered",
              attributes: { user_id: "42", region: "eu-west", attempt: 2, success: true },
            },
          ],
        }),
      },
      200,
    )
  ).value,
);

console.log("3. Query logs");
const firstPage = await requestJson<{ logs: unknown[]; next_cursor: string | null }>(
  `${baseUrl}/logs?service=${encodeURIComponent(service)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=1`,
);
console.log(firstPage.value);

console.log("4. Cursor page");
if (firstPage.value.next_cursor !== null) {
  console.log(
    (
      await requestJson(
        `${baseUrl}/logs?service=${encodeURIComponent(service)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&limit=1&cursor=${encodeURIComponent(firstPage.value.next_cursor)}`,
      )
    ).value,
  );
}

console.log("5. Aggregate");
console.log(
  (
    await requestJson(
      `${baseUrl}/logs/aggregate?service=${encodeURIComponent(service)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&bucket=1m&group_by=level`,
    )
  ).value,
);
