CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT, project TEXT, cwd TEXT, first_ts TEXT, last_ts TEXT, cc_version TEXT
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL, description TEXT,
  launch_tool_use_id TEXT, parent_run_id TEXT, file TEXT
);
CREATE INDEX runs_session ON runs(session_id);
CREATE TABLE prompts (
  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, duration_ms INTEGER
);
CREATE INDEX prompts_session_ts ON prompts(session_id, ts);
CREATE TABLE api_calls (
  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,
  ts TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, speed TEXT NOT NULL,
  input INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, output INTEGER NOT NULL, thinking INTEGER NOT NULL,
  ctx_tokens INTEGER NOT NULL, cost REAL, cost_parts_json TEXT, price_id TEXT, thinking_ms INTEGER, raw_json TEXT
);
CREATE INDEX api_calls_ts ON api_calls(ts);
CREATE INDEX api_calls_session ON api_calls(session_id);
CREATE INDEX api_calls_run ON api_calls(run_id);
CREATE INDEX api_calls_prompt ON api_calls(prompt_uuid);
CREATE TABLE advisor_calls (
  message_id TEXT NOT NULL, model TEXT NOT NULL, tokens_json TEXT NOT NULL, cost REAL
);
CREATE INDEX advisor_calls_message ON advisor_calls(message_id);
CREATE TABLE tool_calls (
  tool_use_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,
  name TEXT NOT NULL, label TEXT NOT NULL, skill TEXT, input_json TEXT, started_ts TEXT, ended_ts TEXT,
  result_chars INTEGER, is_error INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, permission TEXT
);
CREATE INDEX tool_calls_run ON tool_calls(run_id);
CREATE INDEX tool_calls_prompt ON tool_calls(prompt_uuid);
CREATE TABLE pending_results (
  tool_use_id TEXT PRIMARY KEY, ended_ts TEXT, result_chars INTEGER, is_error INTEGER, denied INTEGER, permission TEXT
);
CREATE TABLE compactions (
  session_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL, pre_tokens INTEGER, duration_ms INTEGER, trigger TEXT
);
CREATE TABLE hook_runs (
  session_id TEXT NOT NULL, ts TEXT NOT NULL, command TEXT NOT NULL, duration_ms INTEGER
);
CREATE TABLE files (
  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, "offset" INTEGER NOT NULL,
  session_id TEXT, run_id TEXT, missing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
