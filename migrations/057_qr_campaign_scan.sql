CREATE TABLE IF NOT EXISTS qr_campaign_scan (
  id uuid PRIMARY KEY,
  campaign_slug text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  local_date date NOT NULL,
  scanner_key text NOT NULL,
  ip_address inet,
  user_agent text,
  referrer text,
  destination_url text NOT NULL
);

CREATE INDEX IF NOT EXISTS qr_campaign_scan_slug_date_idx
  ON qr_campaign_scan (campaign_slug, local_date);

CREATE INDEX IF NOT EXISTS qr_campaign_scan_date_idx
  ON qr_campaign_scan (local_date);

CREATE INDEX IF NOT EXISTS qr_campaign_scan_scanner_idx
  ON qr_campaign_scan (campaign_slug, scanner_key);
