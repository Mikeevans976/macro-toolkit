CREATE TABLE IF NOT EXISTS contracts (
    contract_id      TEXT PRIMARY KEY,
    root             TEXT NOT NULL,
    expiry_date      DATE NOT NULL,
    last_trading_day DATE NOT NULL,
    contract_type    TEXT NOT NULL CHECK(contract_type IN ('quarterly','serial')),
    listing_date     DATE
);

CREATE TABLE IF NOT EXISTS daily_obs (
    contract_id      TEXT NOT NULL REFERENCES contracts(contract_id),
    trade_date       DATE NOT NULL,
    knowledge_date   DATE NOT NULL,
    settlement_price REAL NOT NULL,
    open_interest    INTEGER NOT NULL,
    volume           INTEGER NOT NULL,
    vwap             REAL,
    open_price       REAL,
    revised_at       TIMESTAMP,
    ingested_at      TIMESTAMP NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contract_id, trade_date)
);

CREATE TABLE IF NOT EXISTS daily_obs_revisions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id      TEXT NOT NULL,
    trade_date       DATE NOT NULL,
    knowledge_date   DATE NOT NULL,
    settlement_price REAL NOT NULL,
    open_interest    INTEGER NOT NULL,
    volume           INTEGER NOT NULL,
    vwap             REAL,
    open_price       REAL,
    revision_seq     INTEGER NOT NULL DEFAULT 1,
    ingested_at      TIMESTAMP NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cot_obs (
    report_date      DATE NOT NULL,
    publication_date DATE NOT NULL,
    category         TEXT NOT NULL,
    long_positions   INTEGER NOT NULL,
    short_positions  INTEGER NOT NULL,
    spreading        INTEGER NOT NULL,
    n_traders        INTEGER NOT NULL,
    ingested_at      TIMESTAMP NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (report_date, category)
);

CREATE INDEX IF NOT EXISTS idx_daily_obs_knowledge ON daily_obs(knowledge_date);
CREATE INDEX IF NOT EXISTS idx_daily_obs_contract ON daily_obs(contract_id, trade_date);
CREATE INDEX IF NOT EXISTS idx_cot_publication ON cot_obs(publication_date);
