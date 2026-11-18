# 04 · 数据库设计

> 冻结契约。依据 master_plan §5.4。任何建表/改列都必须同步更新本文档与 05-api-contracts 的 DTO。

## 1. 设计原则

1. **Schema 不是 API**：前端只见 DTO（05 §2），不见表名与列名。
2. 时间统一用 **UTC ISO-8601 字符串**（`2025-01-31T12:00:00Z`），排序依赖字典序；文件 mtime 另存 `mtime_ms`（epoch 毫秒整数）用于精确增量比对。
3. 路径为**规范化绝对路径**（Windows：正斜杠归一 + 盘符大写），唯一约束落在这里。
4. 软删除用 `deleted_at`，物理清理由「清理记录」命令触发。
5. 索引单位 = 页面：`page_text` 与 `page_fts` 一一对应，通过 `rowid` 绑定。

## 2. 连接与 PRAGMA

```sql
PRAGMA journal_mode = WAL;          -- 读写并发，索引不阻塞阅读
PRAGMA foreign_keys = ON;           -- 级联删除必须生效
PRAGMA busy_timeout = 5000;         -- 写竞争时最多等 5s
PRAGMA synchronous = NORMAL;        -- WAL 下的合理折衷
```

连接策略：**一个写连接（串行队列）+ 多个只读连接**。所有写操作经 `WriteQueue` 串行化，避免 `SQLITE_BUSY` 抖动。

## 3. 完整 DDL（迁移 001_init）

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 文献库根目录
CREATE TABLE library_roots (
  id              INTEGER PRIMARY KEY,
  path            TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at      TEXT    NOT NULL,
  last_scanned_at TEXT
);

-- 文献（一行 = 一个 PDF 文件）
CREATE TABLE documents (
  id               INTEGER PRIMARY KEY,
  library_root_id  INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,   -- 相对 root，'/' 分隔，保留原始大小写（展示用）
  rel_path_key     TEXT    NOT NULL,   -- lower(rel_path)，唯一性判定用
  abs_path         TEXT    NOT NULL,   -- 规范化绝对路径，保留大小写（展示 / 打开文件用）
  abs_path_key     TEXT    NOT NULL UNIQUE,  -- lower(去尾分隔符的正斜杠路径)，唯一性判定用
  file_name        TEXT    NOT NULL,   -- 原始文件名（含大小写），展示用
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

-- 页面原始文本（索引的事实来源，也用于上下文与重建）
CREATE TABLE page_text (
  id          INTEGER PRIMARY KEY,          -- 同时是 page_fts 的 rowid
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,             -- 1-based
  raw_text    TEXT    NOT NULL,
  char_count  INTEGER NOT NULL,
  UNIQUE (document_id, page_no)
);

CREATE INDEX idx_page_text_doc ON page_text(document_id);

-- 分词后的检索表（contentless，只存倒排，不存原文）
CREATE VIRTUAL TABLE page_fts USING fts5(
  seg_text,
  tokenize = 'unicode61 remove_diacritics 2',
  content = '',
  contentless_delete = 1
);

-- 索引任务（持久化，供崩溃恢复与 UI 进度）
CREATE TABLE indexing_jobs (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('meta','text','reindex')),
  priority    INTEGER NOT NULL DEFAULT 10,   -- 0=前台优先, 10=后台
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

-- 用户书签（与 PDF 内置 Outline 完全无关，Outline 不落库）
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

-- 阅读进度（一文档一行）
CREATE TABLE reading_progress (
  document_id  INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  page_no      INTEGER NOT NULL CHECK (page_no >= 1),
  scroll_ratio REAL    NOT NULL DEFAULT 0,     -- 页内相对位置 0..1
  zoom         REAL    NOT NULL DEFAULT 1.0,
  mode         TEXT    NOT NULL DEFAULT 'continuous'
               CHECK (mode IN ('continuous','single')),
  updated_at   TEXT    NOT NULL
);

-- 设置（键值，value 为 JSON 字符串）
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 4. 字段要点与易错处

| 字段 | 说明 |
|---|---|
| `documents.abs_path_key` | **唯一性只认这一列**（R17）。生成规则：`normalize_abs()` 后 `to_lowercase()`。Windows 文件系统大小写不敏感，若用 `abs_path` 直接 UNIQUE，`C:/Docs/A.pdf` 与 `c:/docs/a.pdf` 会是同一文件的两行。`abs_path` 保留大小写供展示与打开。 |
| `documents.rel_path_key` | `lower(rel_path)`，与 `library_root_id` 组成唯一约束；扫描 diff 也用它做 join，避免大小写差异造成「假删除 + 假新增」。 |
| `documents.abs_path` | 文件移动后若新 `abs_path_key` 已有记录 → **合并**（保留 id，更新路径），不新建。 |
| `documents.deleted_at` | 软删除。同一路径重新出现时优先「复活」旧行（清 `deleted_at`），保持 id 稳定，书签与进度不丢。 |
| `documents.text_state` | 索引状态唯一真源。`no_text` 与 `failed` 都是**终态**（除非 mtime 变化或手动重建）。 |
| `page_text.id` | 必须与 `page_fts.rowid` 严格相等；由 `PageTextRepo::insert_page` 在同一事务内保证。`INTEGER PRIMARY KEY` 即 rowid 别名，不加 AUTOINCREMENT。 |
| rowid 复用风险 | 删除后 SQLite 可能复用 rowid，因此删除页面必须在**同一事务**内先删 FTS 行再删 `page_text`，且不允许「删文档但留 FTS 行」。 |
| `page_fts.content = ''` | contentless：不存原文。`seg_text` 只用于匹配，原始文本在 `page_text.raw_text`。 |
| `contentless_delete = 1` | 允许 `DELETE FROM page_fts WHERE rowid = ?`。V-03 探针失败时降级为普通 FTS5 表（同列，去掉 `content=''`），功能不变、体积略增，Repository 内部自动选择分支。 |
| `reading_progress.scroll_ratio` | 恢复时 `page_no` 需按新的 `page_count` 夹取（文件可能被替换）。 |
| `app_settings.value` | JSON 字符串。读取失败或未知键 → 用默认值，不抛错。 |

## 5. 迁移方案

- 迁移文件：`src-tauri/migrations/001_init.sql`、`002_xxx.sql`…，用 `include_str!` 嵌入二进制。
- `schema_migrations` 由 `db::run_migrations` 负责创建（必须先读版本号），**迁移脚本内不得重复建表** —— 首版曾因 001 里重复 `CREATE TABLE schema_migrations` 导致迁移失败（2026-11-18 修正）。
- 启动流程：读 `schema_migrations.max(version)` → 顺序执行未应用文件（每个文件一个事务）→ 插入版本行。
- 迁移**只增不改**：禁止修改已发布迁移文件；修正必须新增迁移。
- 迁移失败：应用进入只读降级状态并在 UI 顶部显示 `E_DB` 错误，不得静默继续。
- `db_reset` 仅 debug 构建可用（开发便利），release 构建不编译该命令。

## 6. 一致性维护

| 场景 | 处理 |
|---|---|
| 删除文档记录 | 同事务：先按 `document_id` 查 `page_text.id` 列表逐条 `DELETE FROM page_fts WHERE rowid=?`，再 `DELETE FROM documents WHERE id=?`（等级联清 `page_text`/`bookmarks`/`reading_progress`/`indexing_jobs`）。FTS 无外键，必须显式删。 |
| 文档内容变更 | 同事务删除该文档全部 FTS 行与 `page_text` 行，`text_state='pending'`。 |
| 索引中断 | 启动时 `UPDATE documents SET text_state='pending' WHERE text_state='indexing'`；`UPDATE indexing_jobs SET state='queued' WHERE state='running'`。 |
| 一致性自检 | `db_integrity_check` 报告：FTS 行数 vs `page_text` 行数、孤儿 `page_text`、`text_state='indexed'` 但无页面文本的文档清单。只报告，不自动修。 |
| 重建索引 | `index_rebuild_all`：清空 FTS 与 `page_text`，所有未删除文档置 `text_state='pending'`，重新入队。重建中途可读（已重建的文档可被搜到）。 |

## 7. FTS5 检索表细节

- tokenizer：`unicode61 remove_diacritics 2`。写入的 `seg_text` 是 **jieba 精确模式切分后的空格连接串**：原文「中文分词的效果」→「中文 分词 的 效果」。
- 查询侧必须使用同一分词器与同一词典配置（V-04）。短语查询：`"中文 分词 的 效果"`（FTS5 短语 = 相邻 token 序列）；宽松查询：`中文 AND 分词`。
- **不使用 trigram**（master_plan §3.4 明确警告：<3 字符中文查询受限）。
- 排序：`bm25(page_fts)` 升序为默认相关度（bm25 返回负值，越小越相关）。
- 注入防护：查询串先经 `sanitize_query` 去除 `" * ( ) : ^ - NEAR AND OR NOT` 等 FTS 语法字符，仅保留文字与数字，再分词构造 MATCH。

## 8. 存储估算

| 对象 | 估算 |
|---|---|
| 1000 篇论文（平均 15 页） | `page_text` 约 150MB；`page_fts` 约 150–250MB |
| 4000 篇 | 约 0.6–1.5GB |
| 单页文本平均 | 1.5–4KB（中文论文） |

结论：可接受。若后续膨胀，可对 `page_text.raw_text` 加压缩列（迁移 002，非首版）。

## 9. 测试要求

- 迁移：空库 → 最新；从 001 库 → 最新；重复执行幂等。
- 级联：删 root → documents 消失；删 document → page_text/bookmarks/progress/jobs 消失且 FTS 行同步删除。
- FTS：连续 3 轮「插入-删除-插入」后查询不得返回已删文档（rowid 复用回归测试）。
- 并发：一个写线程 + 三个读线程循环 10s，无 `SQLITE_BUSY` 逃逸。
- 降级：强制走普通 FTS5 分支后，全部用例仍通过。
