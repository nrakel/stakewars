CREATE TABLE IF NOT EXISTS chine_sp500_benchmark (
  benchmark_key text PRIMARY KEY,
  first_wager_date date NOT NULL,
  benchmark_start_date date NOT NULL,
  benchmark_start_value numeric(14,4) NOT NULL,
  benchmark_through_date date NOT NULL,
  benchmark_through_value numeric(14,4) NOT NULL,
  benchmark_roi numeric(12,8) NOT NULL,
  source text NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chine_sp500_benchmark_key_check
    CHECK (benchmark_key = 'OVERALL' OR benchmark_key IN ('MLB', 'NHL', 'NFL', 'NBA', 'NCAAMB', 'NCAAF', 'EPL', 'WORLDCUP')),
  CONSTRAINT chine_sp500_benchmark_values_check
    CHECK (benchmark_start_value > 0 AND benchmark_through_value > 0),
  CONSTRAINT chine_sp500_benchmark_dates_check
    CHECK (benchmark_start_date <= benchmark_through_date)
);

