// Postgres schema and connection. Amounts are raw integer units in NUMERIC columns (exact); addresses are
// lowercase hex. The schema is created idempotently at startup.
const { Pool } = require("pg");

const SCHEMA = `
create table if not exists meta (
  key text primary key,
  value text not null
);

create table if not exists sync_state (
  id text primary key,
  block bigint not null,
  updated_at timestamptz not null default now()
);

create table if not exists quotes (
  address text primary key,
  symbol text not null,
  decimals smallint not null
);

create table if not exists integrators (
  id integer primary key,
  account text,
  payout text,
  name text,
  uri text,
  verified boolean not null default false,
  suspended boolean not null default false,
  registered_block bigint,
  updated_block bigint
);

create table if not exists tokens (
  address text primary key,
  launch_id bigint not null unique,
  pool_id text not null unique,
  name text,
  symbol text,
  metadata_uri text,
  image text,
  description text,
  creator text not null,
  caller text not null,
  integrator_id integer not null,
  attribution smallint not null,
  quote text not null,
  token_is0 boolean not null,
  preset_id integer not null,
  protocol_bps integer not null,
  integrator_bps integer not null,
  creator_bps integer not null,
  alloc_bps integer not null,
  cliff integer not null,
  duration integer not null,
  instant_allocation boolean not null,
  dev_buy_tokens numeric not null,
  dev_buy_quote_spent numeric not null,
  dev_buy_lock integer not null,
  pool_tokens numeric not null,
  core_version integer,
  block bigint not null,
  tx text not null,
  ts timestamptz not null,
  init_price double precision,
  last_price double precision,
  last_sqrt_price numeric,
  last_tick integer,
  last_trade_at timestamptz
);
create index if not exists tokens_block_idx on tokens (block desc);
create index if not exists tokens_creator_idx on tokens (creator);

create table if not exists swaps (
  tx text not null,
  log_index integer not null,
  block bigint not null,
  ts timestamptz not null,
  pool_id text not null,
  token text not null,
  kind text not null,            -- 'swap' | 'devbuy'
  sender text not null,          -- msg.sender at the PoolManager (router, hook, ...)
  trader text,                   -- end user when known (router Swapped event, or the creator for a dev buy)
  side text not null,            -- 'buy' | 'sell' (of the launched token)
  token_amount numeric not null, -- pool-level amounts (what moved in the pool)
  quote_amount numeric not null,
  user_amount_in numeric,        -- user-level amounts from the router (incl. anti-sniper surcharge)
  user_amount_out numeric,
  price double precision not null, -- quote per token after the swap, human units
  sqrt_price numeric not null,
  tick integer not null,
  fee integer not null,
  primary key (tx, log_index)
);
create index if not exists swaps_token_idx on swaps (token, block desc, log_index desc);
create index if not exists swaps_ts_idx on swaps (ts);
create index if not exists swaps_trader_idx on swaps (trader);

create table if not exists transfers (
  tx text not null,
  log_index integer not null,
  block bigint not null,
  token text not null,
  from_addr text not null,
  to_addr text not null,
  value numeric not null,
  primary key (tx, log_index)
);
create index if not exists transfers_token_idx on transfers (token, block desc);

create table if not exists balances (
  token text not null,
  holder text not null,
  balance numeric not null,
  primary key (token, holder)
);
create index if not exists balances_token_idx on balances (token, balance desc);

create table if not exists fees (
  tx text not null,
  log_index integer not null,
  block bigint not null,
  ts timestamptz not null,
  pool_id text not null,
  currency text not null,
  amount numeric not null,
  to_protocol numeric not null,
  to_integrator numeric not null,
  to_creator numeric not null,
  primary key (tx, log_index)
);
create index if not exists fees_pool_idx on fees (pool_id);

create table if not exists images (
  sha256 text primary key,
  mime text not null,
  size integer not null,
  bytes bytea not null,
  created_at timestamptz not null default now()
);
`;

function makePool(cfg) {
  return new Pool({
    connectionString: cfg.databaseUrl,
    ssl: cfg.databaseSsl === "verify" ? { rejectUnauthorized: true } : cfg.databaseSsl === "no-verify" ? { rejectUnauthorized: false } : undefined,
    max: 8,
  });
}

/** Creates the schema and pins the database to one chain + deployment, so a misconfigured env can't mix data. */
async function migrate(pool, cfg) {
  await pool.query(SCHEMA);
  const id = `${cfg.chainId}:${cfg.addresses.core}`;
  const { rows } = await pool.query("select value from meta where key = 'deployment'");
  if (!rows.length) await pool.query("insert into meta (key, value) values ('deployment', $1)", [id]);
  else if (rows[0].value !== id) {
    throw new Error(`database holds data for ${rows[0].value}, not ${id}; use a fresh database (or drop its tables)`);
  }
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { makePool, migrate, tx };
