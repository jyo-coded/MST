-- Astra Waste relational model. Runs on PGlite (embedded) or any PostgreSQL
-- (Supabase, RDS, local) via DATABASE_URL. High-frequency telemetry lives
-- here; only workflow proofs and payments go on MST Blockchain.

CREATE TABLE IF NOT EXISTS municipalities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  city          TEXT NOT NULL,
  ward          TEXT,
  center_lat    DOUBLE PRECISION NOT NULL,
  center_lng    DOUBLE PRECISION NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id                  TEXT PRIMARY KEY,
  municipality_id     TEXT NOT NULL REFERENCES municipalities(id),
  name                TEXT NOT NULL,
  phone               TEXT,
  zone                TEXT,
  rfid_uid            TEXT NOT NULL UNIQUE,
  rfid_hash           TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'AVAILABLE',
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  home_lat            DOUBLE PRECISION,
  home_lng            DOUBLE PRECISION,
  location_source     TEXT NOT NULL DEFAULT 'simulation',
  location_updated_at TIMESTAMPTZ,
  completed_count     INT NOT NULL DEFAULT 0,
  rejected_count      INT NOT NULL DEFAULT 0,
  on_chain            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  municipality_id TEXT NOT NULL REFERENCES municipalities(id),
  name            TEXT NOT NULL,
  email           TEXT UNIQUE,
  role            TEXT NOT NULL CHECK (role IN ('officer', 'admin', 'worker')),
  worker_id       TEXT REFERENCES workers(id),
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bins (
  id               TEXT PRIMARY KEY,
  municipality_id  TEXT NOT NULL REFERENCES municipalities(id),
  name             TEXT NOT NULL,
  address          TEXT NOT NULL,
  zone             TEXT NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  capacity_litres  INT NOT NULL,
  depth_cm         DOUBLE PRECISION NOT NULL,
  threshold_pct    INT NOT NULL DEFAULT 85,
  monitor_pct      INT NOT NULL DEFAULT 70,
  hardware         BOOLEAN NOT NULL DEFAULT false,
  device_address   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'NORMAL',
  fill_pct         DOUBLE PRECISION NOT NULL DEFAULT 0,
  fill2_pct        DOUBLE PRECISION,
  distance_cm      DOUBLE PRECISION,
  distance2_cm     DOUBLE PRECISION,
  lid_state        TEXT NOT NULL DEFAULT 'closed',
  servo_state      TEXT NOT NULL DEFAULT 'locked',
  ir_status        TEXT NOT NULL DEFAULT 'normal',
  rfid_state       TEXT NOT NULL DEFAULT 'idle',
  temperature_c    DOUBLE PRECISION,
  online           BOOLEAN NOT NULL DEFAULT true,
  source           TEXT NOT NULL DEFAULT 'simulation',
  last_heartbeat   TIMESTAMPTZ,
  last_seq         BIGINT NOT NULL DEFAULT 0,
  device_nonce     BIGINT NOT NULL DEFAULT 0,
  on_chain         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensors (
  id          SERIAL PRIMARY KEY,
  bin_id      TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  last_value  TEXT,
  updated_at  TIMESTAMPTZ,
  UNIQUE (bin_id, kind)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id             BIGSERIAL PRIMARY KEY,
  bin_id         TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL,
  seq            BIGINT,
  distance_cm    DOUBLE PRECISION,
  distance2_cm   DOUBLE PRECISION,
  fill_pct       DOUBLE PRECISION NOT NULL,
  fill2_pct      DOUBLE PRECISION,
  lid_state      TEXT NOT NULL,
  servo_state    TEXT NOT NULL,
  ir_status      TEXT NOT NULL,
  ir_count       INT NOT NULL DEFAULT 0,
  rfid_detected  BOOLEAN NOT NULL DEFAULT false,
  temperature_c  DOUBLE PRECISION,
  rssi           INT,
  source         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_bin_ts ON telemetry (bin_id, ts DESC);

CREATE TABLE IF NOT EXISTS worker_locations (
  id          BIGSERIAL PRIMARY KEY,
  worker_id   TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy_m  DOUBLE PRECISION,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_locations_worker_ts ON worker_locations (worker_id, ts DESC);

CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id                   SERIAL PRIMARY KEY,
  hash                 TEXT NOT NULL UNIQUE,
  action               TEXT NOT NULL,
  method               TEXT NOT NULL,
  request_id           INT,
  bin_id               TEXT REFERENCES bins(id),
  worker_id            TEXT REFERENCES workers(id),
  from_address         TEXT,
  to_address           TEXT,
  wallet               TEXT,
  value_wei            NUMERIC(78, 0),
  status               TEXT NOT NULL,
  signer_kind          TEXT NOT NULL,
  block_number         BIGINT,
  gas_used             NUMERIC(78, 0),
  effective_gas_price  NUMERIC(78, 0),
  fee_wei              NUMERIC(78, 0),
  network              TEXT NOT NULL,
  chain_id             INT NOT NULL,
  events               JSONB,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tx_request ON blockchain_transactions (request_id);

CREATE TABLE IF NOT EXISTS collection_requests (
  id                    INT PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,
  bin_id                TEXT NOT NULL REFERENCES bins(id),
  municipality_id       TEXT NOT NULL REFERENCES municipalities(id),
  status                TEXT NOT NULL,
  chain_status          TEXT NOT NULL DEFAULT 'None',
  priority              TEXT NOT NULL DEFAULT 'normal',
  detected_fill         DOUBLE PRECISION NOT NULL,
  detected_at           TIMESTAMPTZ NOT NULL,
  fill_before           DOUBLE PRECISION,
  fill_after            DOUBLE PRECISION,
  amount_wei            NUMERIC(78, 0),
  assigned_worker_id    TEXT REFERENCES workers(id),
  rfid_alert            BOOLEAN NOT NULL DEFAULT false,
  investigation_reason  TEXT,
  rejection_reason      TEXT,
  scenario              TEXT,
  created_tx_id         INT REFERENCES blockchain_transactions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS requests_status ON collection_requests (status);

CREATE TABLE IF NOT EXISTS ai_verifications (
  id             SERIAL PRIMARY KEY,
  request_id     INT REFERENCES collection_requests(id),
  bin_id         TEXT NOT NULL REFERENCES bins(id),
  kind           TEXT NOT NULL CHECK (kind IN ('fullness', 'completion')),
  decision       TEXT NOT NULL,
  verified       BOOLEAN NOT NULL,
  confidence     DOUBLE PRECISION NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  latency_ms     INT,
  inputs         JSONB NOT NULL,
  checks         JSONB NOT NULL,
  reasons        JSONB NOT NULL,
  summary        JSONB,
  second_opinion JSONB,
  evidence_hash  TEXT NOT NULL,
  report_hash    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  id           SERIAL PRIMARY KEY,
  request_id   INT NOT NULL REFERENCES collection_requests(id),
  worker_id    TEXT NOT NULL REFERENCES workers(id),
  assigned_by  TEXT,
  distance_km  DOUBLE PRECISION,
  eta_min      DOUBLE PRECISION,
  status       TEXT NOT NULL,
  tx_id        INT REFERENCES blockchain_transactions(id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  en_route_at  TIMESTAMPTZ,
  arrived_at   TIMESTAMPTZ,
  rfid_at      TIMESTAMPTZ,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rfid_events (
  id           SERIAL PRIMARY KEY,
  bin_id       TEXT NOT NULL REFERENCES bins(id),
  request_id   INT REFERENCES collection_requests(id),
  worker_id    TEXT REFERENCES workers(id),
  tag_uid      TEXT NOT NULL,
  tag_hash     TEXT NOT NULL,
  result       TEXT NOT NULL,
  checks       JSONB NOT NULL,
  distance_m   DOUBLE PRECISION,
  source       TEXT NOT NULL,
  tx_id        INT REFERENCES blockchain_transactions(id),
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  INT REFERENCES collection_requests(id),
  bin_id      TEXT NOT NULL REFERENCES bins(id),
  type        TEXT NOT NULL,
  data        JSONB,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  INT REFERENCES collection_requests(id),
  bin_id      TEXT REFERENCES bins(id),
  worker_id   TEXT REFERENCES workers(id),
  stage       TEXT NOT NULL,
  message     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  tone        TEXT NOT NULL DEFAULT 'info',
  tx_id       INT REFERENCES blockchain_transactions(id),
  data        JSONB,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lifecycle_request ON lifecycle_events (request_id, ts);

CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  request_id      INT NOT NULL UNIQUE REFERENCES collection_requests(id),
  worker_id       TEXT NOT NULL REFERENCES workers(id),
  wallet_address  TEXT NOT NULL,
  amount_wei      NUMERIC(78, 0) NOT NULL,
  amount_inr      DOUBLE PRECISION,
  status          TEXT NOT NULL,
  tx_id           INT REFERENCES blockchain_transactions(id),
  signer          TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
  id               SERIAL PRIMARY KEY,
  municipality_id  TEXT REFERENCES municipalities(id),
  type             TEXT NOT NULL,
  severity         TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT,
  request_id       INT REFERENCES collection_requests(id),
  bin_id           TEXT REFERENCES bins(id),
  worker_id        TEXT REFERENCES workers(id),
  read             BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_commands (
  id            SERIAL PRIMARY KEY,
  bin_id        TEXT NOT NULL REFERENCES bins(id),
  type          TEXT NOT NULL,
  payload       JSONB,
  status        TEXT NOT NULL DEFAULT 'queued',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
