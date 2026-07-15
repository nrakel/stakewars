import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import type pg from "pg";
import { transaction } from "./db.js";

type ParsedLogLine = {
  ip: string;
  occurredAt: Date;
  method: string;
  requestPath: string;
  statusCode: number;
  userAgent: string;
};

export type VisitorMetricRow = {
  label: string;
  uniqueVisitors: number;
  totalVisitors: number;
  humanVisitors: number;
  otherVisitors: number;
};

export type VisitorMetricResponse = {
  generatedAt: string;
  lastUpdatedAt: string | null;
  rows: VisitorMetricRow[];
};

const logDir = "/var/log/nginx";
const stakewarsLogPattern = /^stakewars\.(?:ai|phisystems\.ai)\.access\.log(?:-\d{8}(?:\.gz)?)?$/;
const staticAssetPattern = /\.(?:css|js|mjs|png|jpg|jpeg|webp|gif|ico|svg|woff2?|ttf|map|txt|xml)$/i;
const botPattern = /bot|crawler|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|monitor|uptime|claude|gptbot|semrush|ahrefs|bytespider|petalbot|headless|httpclient/i;
const accessLogPattern = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+ "[^"]*" "([^"]*)"/;

const centralDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const parseNginxDate = (value: string) => {
  const parsed = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(value);
  if (!parsed) return null;
  const [, day, monthName, year, hour, minute, second, offset] = parsed;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthName);
  if (month < 0) return null;
  const base = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
  const sign = offset.startsWith("-") ? -1 : 1;
  const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  return new Date(base - offsetMinutes * 60_000);
};

const parseLogLine = (line: string): ParsedLogLine | null => {
  const match = accessLogPattern.exec(line);
  if (!match) return null;
  const [, ip, timestamp, request, status, userAgent] = match;
  const [method = "", requestTarget = ""] = request.split(" ");
  const occurredAt = parseNginxDate(timestamp);
  if (!occurredAt) return null;
  return {
    ip,
    occurredAt,
    method,
    requestPath: requestTarget.split("?")[0] || "/",
    statusCode: Number(status),
    userAgent
  };
};

const isVisit = (line: ParsedLogLine) => {
  if (line.method !== "GET" && line.method !== "HEAD") return false;
  if (line.statusCode >= 400) return false;
  if (line.requestPath.startsWith("/api/")) return false;
  if (line.requestPath === "/sw.js" || line.requestPath === "/manifest.webmanifest" || line.requestPath === "/offline.html") return false;
  if (line.requestPath.startsWith("/icons/") || line.requestPath.startsWith("/images/") || line.requestPath.startsWith("/assets/")) return false;
  if (staticAssetPattern.test(line.requestPath)) return false;
  return true;
};

const readLogFile = async function* (filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath);
  const input = filePath.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
};

const stakewarsLogFiles = async () => {
  const files = await readdir(logDir);
  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  const candidates = files.filter((file) => stakewarsLogPattern.test(file));
  const selected: string[] = [];
  for (const file of candidates) {
    const filePath = path.join(logDir, file);
    const info = await stat(filePath);
    if (info.mtimeMs >= cutoff) {
      selected.push(filePath);
    }
  }
  return selected.sort();
};

export const refreshVisitorEvents = async () => {
  const files = await stakewarsLogFiles();
  let parsed = 0;
  let visits = 0;
  let inserted = 0;
  await transaction(async (client) => {
    for (const file of files) {
      const host = path.basename(file).startsWith("stakewars.ai") ? "stakewars.ai" : "stakewars.phisystems.ai";
      for await (const rawLine of readLogFile(file)) {
        const line = parseLogLine(rawLine);
        if (!line) continue;
        parsed += 1;
        if (!isVisit(line)) continue;
        visits += 1;
        const result = await client.query(
          `
            INSERT INTO visitor_event (
              event_key, occurred_at, local_date, host, visitor_key,
              is_human, path, status_code
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (event_key) DO NOTHING
          `,
          [
            hash(rawLine),
            line.occurredAt,
            centralDate(line.occurredAt),
            host,
            hash(`${line.ip}|${line.userAgent}`),
            !botPattern.test(line.userAgent),
            line.requestPath,
            line.statusCode
          ]
        );
        inserted += result.rowCount ?? 0;
      }
    }
  });
  return { files: files.length, parsed, visits, inserted };
};

const metricForWhere = async (client: pg.PoolClient, label: string, whereSql: string, params: unknown[]): Promise<VisitorMetricRow> => {
  const result = await client.query<{
    uniqueVisitors: string;
    totalVisitors: string;
    humanVisitors: string;
    otherVisitors: string;
  }>(
    `
      SELECT
        count(DISTINCT visitor_key)::text AS "uniqueVisitors",
        count(*)::text AS "totalVisitors",
        count(DISTINCT visitor_key) FILTER (WHERE is_human)::text AS "humanVisitors",
        count(DISTINCT visitor_key) FILTER (WHERE NOT is_human)::text AS "otherVisitors"
      FROM visitor_event
      WHERE ${whereSql}
    `,
    params
  );
  const row = result.rows[0];
  return {
    label,
    uniqueVisitors: Number(row.uniqueVisitors),
    totalVisitors: Number(row.totalVisitors),
    humanVisitors: Number(row.humanVisitors),
    otherVisitors: Number(row.otherVisitors)
  };
};

export const getVisitorMetrics = async (): Promise<VisitorMetricResponse> => {
  const today = centralDate();
  return transaction(async (client) => {
    const todayRow = await metricForWhere(client, "Today", "local_date = $1::date", [today]);
    const thirtyDayRow = await metricForWhere(client, "Past 30 Days", "local_date >= $1::date - interval '29 days' AND local_date <= $1::date", [today]);
    const lastUpdated = await client.query<{ lastUpdatedAt: string | null }>("SELECT max(created_at)::text AS \"lastUpdatedAt\" FROM visitor_event");
    return {
      generatedAt: new Date().toISOString(),
      lastUpdatedAt: lastUpdated.rows[0]?.lastUpdatedAt ?? null,
      rows: [todayRow, thirtyDayRow]
    };
  });
};
