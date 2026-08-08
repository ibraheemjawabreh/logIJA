const services = ["auth", "checkout", "orders", "notifications", "users"];
const levels = ["debug", "info", "warn", "error"];
const messages = [
  "request completed",
  "payment declined",
  "password reset requested",
  "notification delivered",
  "order queued",
  "search 100% literal",
];
const regions = ["eu-west", "us-east", "ap-south"];

export function makeLog(index) {
  return {
    timestamp: new Date(Date.now() - 60_000 + (index % 1000)).toISOString(),
    level: levels[index % levels.length],
    service: services[index % services.length],
    message: `${messages[index % messages.length]} pattern-${index % 100}`,
    attributes: {
      user_id: String(10_000 + (index % 50_000)),
      region: regions[index % regions.length],
      request_id: `req-${index}`,
      attempt: index % 4,
      success: index % 7 !== 0,
    },
  };
}

export function makeBatch(start, size) {
  const logs = [];
  for (let i = 0; i < size; i += 1) {
    logs.push(makeLog(start + i));
  }
  return { logs };
}
