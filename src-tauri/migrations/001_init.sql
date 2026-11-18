-- M03 · 初始化 Schema（docs/04-database-design.md §3）
-- 迁移只增不改：修正必须新增 002_*.sql。

-- schema_migrations 由 db::run_migrations 负责创建（先读版本再迁移），迁移脚本不重复建表。

CREATE TABLE library_roots (
  id              INTEGER PRIMARY KEY,
  path            TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at      TEXT    NOT NULL,
  last_scanned_at TEXT
);

CREATE TABLE documents (
  id               INTEGER PRIMARY KEY,
  library_root_id  INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,
  rel_path_key     TEXT    NOT NULL,
  abs_path         TEXT    NOT NULL,
  abs_path_key     TEXT    NOT NULL UNIQUE,
  file_name        TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  mtime_ms         INTEGER NOT NULL,
  page_count       INTEGER,
  pdf_title        TEXT,
  pdf_author       TEXT,
  pdf_subject      TEXT,
  pdf_keywords     TEXT,
  pdf_producer     TEXT,
  pdf_creator      TEXT,
  pdf_creation_date TEXT,
  meta_state       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (meta_state IN ('pending','ok','failed')),
  text_state       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (text_state IN ('pending','indexing','indexed','no_text','failed')),
  index_error_code TEXT,
  index_error_msg  TEXT,
  last_opened_at   TEXT,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (library_root_id, rel_path_key)
);

CREATE INDEX idx_documents_root        ON documents(library_root_id);
CREATE INDEX idx_documents_text_state  ON documents(text_state) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_last_opened ON documents(last_opened_at DESC) WHERE last_opened_at IS NOT NULL;
CREATE INDEX idx_documents_name        ON documents(file_name COLLATE NOCASE);

CREATE TABLE page_text (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  raw_text    TEXT    NOT NULL,
  char_count  INTEGER NOT NULL,
  UNIQUE (document_id, page_no)
);

CREATE INDEX idx_page_text_doc ON page_text(document_id);

CREATE VIRTUAL TABLE page_fts USING fts5(
  seg_text,
  tokenize = 'unicode61 remove_diacritics 2',
  content = '',
  contentless_delete = 1
);

CREATE TABLE indexing_jobs (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('meta','text','reindex')),
  priority    INTEGER NOT NULL DEFAULT 10,
  state       TEXT    NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','running','done','failed','canceled')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error_code  TEXT,
  error_msg   TEXT,
  enqueued_at TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE INDEX idx_jobs_state    ON indexing_jobs(state, priority, enqueued_at);
CREATE INDEX idx_jobs_document ON indexing_jobs(document_id);

CREATE TABLE bookmarks (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL CHECK (page_no >= 1),
  title       TEXT    NOT NULL,
  note        TEXT,
  color       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_bookmarks_doc ON bookmarks(document_id, page_no);

CREATE TABLE reading_progress (
  document_id  INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  page_no      INTEGER NOT NULL CHECK (page_no >= 1),
  scroll_ratio REAL    NOT NULL DEFAULT 0,
  zoom         REAL    NOT NULL DEFAULT 1.0,
  mode         TEXT    NOT NULL DEFAULT 'continuous'
               CHECK (mode IN ('continuous','single')),
  updated_at   TEXT    NOT NULL
);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
