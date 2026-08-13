/**
 * logIJA - Manual Read Throughput Benchmark
 *
 * Measures HTTP read throughput of GET /logs using cursor pagination.
 * No external npm packages are required (Node.js 18+).
 *
 * PowerShell examples:
 *
 *   node scripts/benchmark-read.mjs
 *
 *   $env:DURATION_SECONDS="30"
 *   $env:CONCURRENCY="4"
 *   $env:LIMIT="1000"
 *   node scripts/benchmark-read.mjs
 *
 * Optional:
 *   $env:BASE_URL="http://localhost:8080"
 *   $env:FILTER_QUERY="service=checkout&level=error"
 *
 * IMPORTANT:
 * - CONCURRENCY=1 is best when you want one sequential cursor scan.
 * - CONCURRENCY>1 measures total API delivery throughput using independent
 *   cursor streams, so different workers may read overlapping rows.
 */

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const DURATION_SECONDS = parsePositiveInt(
  process.env.DURATION_SECONDS ?? "20",
  "DURATION_SECONDS"
);
const CONCURRENCY = parsePositiveInt(
  process.env.CONCURRENCY ?? "1",
  "CONCURRENCY"
);
const LIMIT = parsePositiveInt(process.env.LIMIT ?? "1000", "LIMIT");
const FILTER_QUERY = process.env.FILTER_QUERY ?? "";
const REQUEST_TIMEOUT_MS = parsePositiveInt(
  process.env.REQUEST_TIMEOUT_MS ?? "120000",
  "REQUEST_TIMEOUT_MS"
);

if (LIMIT > 1000) {
  console.error("ERROR: LIMIT must be <= 1000 because the API maximum is 1000.");
  process.exit(1);
}

function parsePositiveInt(value, name) {
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    console.error(`ERROR: ${name} must be a positive integer. Received: ${value}`);
    process.exit(1);
  }

  return n;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );

  return sorted[index];
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function makeUrl(cursor) {
  const url = new URL("/logs", BASE_URL);
  const extra = new URLSearchParams(FILTER_QUERY);

  for (const [key, value] of extra.entries()) {
    url.searchParams.append(key, value);
  }

  url.searchParams.set("limit", String(LIMIT));

  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  return url;
}

const stats = {
  logsRead: 0,
  responses: 0,
  failures: 0,
  emptyPages: 0,
  completedScans: 0,
  latenciesMs: [],
};

let stopRequested = false;

async function fetchPage(cursor) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = performance.now();

  try {
    const response = await fetch(makeUrl(cursor), {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    const latency = performance.now() - start;
    stats.latenciesMs.push(latency);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.logs)) {
      throw new Error("Invalid API response: 'logs' is not an array.");
    }

    stats.responses += 1;
    stats.logsRead += data.logs.length;

    if (data.logs.length === 0) {
      stats.emptyPages += 1;
    }

    return {
      count: data.logs.length,
      nextCursor:
        typeof data.next_cursor === "string" && data.next_cursor.length > 0
          ? data.next_cursor
          : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function worker(workerId) {
  let cursor = null;

  while (!stopRequested) {
    try {
      const page = await fetchPage(cursor);

      if (page.nextCursor) {
        cursor = page.nextCursor;
      } else {
        // Reached the end. Start another scan so the benchmark can continue
        // for the full requested duration.
        stats.completedScans += 1;
        cursor = null;

        if (page.count === 0) {
          // Avoid a hot loop if the database contains no logs.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      stats.failures += 1;

      const message =
        error instanceof Error ? error.message : String(error);

      if (stats.failures <= 5) {
        console.error(`[worker ${workerId}] request failed: ${message}`);
      }

      // Small delay prevents an error storm if the service is unavailable.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function checkHealth() {
  const response = await fetch(new URL("/health", BASE_URL));

  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}`);
  }

  const body = await response.json();

  if (body?.status !== "ok") {
    throw new Error(`Unexpected health response: ${JSON.stringify(body)}`);
  }
}

async function main() {
  console.log("");
  console.log("============================================================");
  console.log(" logIJA - GET /logs Read Throughput Benchmark");
  console.log("============================================================");
  console.log(`Base URL          : ${BASE_URL}`);
  console.log(`Duration          : ${DURATION_SECONDS} seconds`);
  console.log(`Concurrency       : ${CONCURRENCY}`);
  console.log(`Page limit        : ${LIMIT}`);
  console.log(`Extra filters     : ${FILTER_QUERY || "(none)"}`);
  console.log(`Request timeout   : ${REQUEST_TIMEOUT_MS} ms`);
  console.log("------------------------------------------------------------");

  console.log("Checking /health ...");
  await checkHealth();
  console.log("Health: OK");
  console.log("");

  if (CONCURRENCY > 1) {
    console.log(
      "NOTE: Multiple workers use independent cursor streams. The result is"
    );
    console.log(
      "      total API delivery throughput, not unique-row scan throughput."
    );
    console.log("");
  }

  const benchmarkStart = performance.now();

  const timer = setTimeout(() => {
    stopRequested = true;
  }, DURATION_SECONDS * 1000);

  const workers = Array.from({ length: CONCURRENCY }, (_, index) =>
    worker(index + 1)
  );

  await Promise.all(workers);
  clearTimeout(timer);

  const elapsedSeconds = (performance.now() - benchmarkStart) / 1000;
  const sortedLatencies = [...stats.latenciesMs].sort((a, b) => a - b);

  const logsPerSecond =
    elapsedSeconds > 0 ? stats.logsRead / elapsedSeconds : 0;
  const requestsPerSecond =
    elapsedSeconds > 0 ? stats.responses / elapsedSeconds : 0;

  console.log("");
  console.log("============================================================");
  console.log(" RESULTS");
  console.log("============================================================");
  console.log(`Actual duration    : ${formatNumber(elapsedSeconds)} s`);
  console.log(`Logs received      : ${stats.logsRead.toLocaleString("en-US")}`);
  console.log(`Successful requests: ${stats.responses.toLocaleString("en-US")}`);
  console.log(`Failed requests    : ${stats.failures.toLocaleString("en-US")}`);
  console.log(`Completed scans    : ${stats.completedScans.toLocaleString("en-US")}`);
  console.log("------------------------------------------------------------");
  console.log(`READ THROUGHPUT    : ${formatNumber(logsPerSecond)} logs/sec`);
  console.log(`Request throughput : ${formatNumber(requestsPerSecond)} req/sec`);
  console.log("------------------------------------------------------------");
  console.log(`HTTP latency p50   : ${formatNumber(percentile(sortedLatencies, 50))} ms`);
  console.log(`HTTP latency p95   : ${formatNumber(percentile(sortedLatencies, 95))} ms`);
  console.log(`HTTP latency p99   : ${formatNumber(percentile(sortedLatencies, 99))} ms`);
  console.log("============================================================");
  console.log("");
}

process.on("SIGINT", () => {
  console.log("\nStopping benchmark...");
  stopRequested = true;
});

main().catch((error) => {
  console.error("");
  console.error(
    "Benchmark failed:",
    error instanceof Error ? error.message : String(error)
  );
  console.error("");
  console.error("Make sure Docker is running and logIJA is available at:");
  console.error(`${BASE_URL}/health`);
  process.exitCode = 1;
});
