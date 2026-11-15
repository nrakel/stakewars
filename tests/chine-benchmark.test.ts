import assert from "node:assert/strict";
import test from "node:test";
import { parseFredSp500Csv, selectBenchmarkStart } from "../src/server/chineBenchmark.js";

test("FRED S&P 500 parser ignores missing observations", () => {
  const rows = parseFredSp500Csv("observation_date,SP500\n2026-09-11,7500.25\n2026-09-12,.\n2026-09-14,7550.50\n");
  assert.deepEqual(rows, [
    { date: "2026-09-11", value: 7500.25 },
    { date: "2026-09-14", value: 7550.5 }
  ]);
});

test("weekend inception uses the most recent prior S&P 500 close", () => {
  const rows = [
    { date: "2026-09-11", value: 7500 },
    { date: "2026-09-14", value: 7550 }
  ];
  assert.deepEqual(selectBenchmarkStart(rows, "2026-09-13"), rows[0]);
});

