param(
  [string]$Service = "checkout",
  [string]$Since = "2000-01-01T00:00:00Z",
  [string]$Until = "2100-01-01T00:00:00Z"
)

$queries = @(
  @{
    Name = "recent-logs"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, level, service, message FROM logs ORDER BY timestamp DESC, id DESC LIMIT 100;"
  },
  @{
    Name = "service-time"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, level, service, message FROM logs WHERE service = '$Service' AND timestamp >= '$Since'::timestamptz AND timestamp < '$Until'::timestamptz ORDER BY timestamp DESC, id DESC LIMIT 100;"
  },
  @{
    Name = "level-time"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, level, service, message FROM logs WHERE level = 'error' AND timestamp >= '$Since'::timestamptz AND timestamp < '$Until'::timestamptz ORDER BY timestamp DESC, id DESC LIMIT 100;"
  },
  @{
    Name = "aggregation"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT date_bin('1 minute'::interval, timestamp, '1970-01-01 00:00:00+00'::timestamptz) AS start, service AS group, COUNT(*)::text AS count FROM logs WHERE timestamp >= '$Since'::timestamptz AND timestamp < '$Until'::timestamptz GROUP BY start, service ORDER BY start ASC, service ASC;"
  },
  @{
    Name = "attribute-equality"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, level, service, message FROM logs WHERE attributes_search ->> 'region' = 'eu-west' AND timestamp >= '$Since'::timestamptz AND timestamp < '$Until'::timestamptz ORDER BY timestamp DESC, id DESC LIMIT 100;"
  },
  @{
    Name = "message-substring"
    Sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, level, service, message FROM logs WHERE message ILIKE '%declined%' ESCAPE E'\\' AND timestamp >= '$Since'::timestamptz AND timestamp < '$Until'::timestamptz ORDER BY timestamp DESC, id DESC LIMIT 100;"
  }
)

New-Item -ItemType Directory -Force -Path "docs/performance/explain" | Out-Null

foreach ($query in $queries) {
  docker compose exec -T postgres psql -U logija -d logija -c $query.Sql | Out-File -Encoding utf8 "docs/performance/explain/$($query.Name).txt"
}

