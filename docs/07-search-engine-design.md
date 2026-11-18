# 07 · 全文搜索引擎设计

> 依据：`master_plan.md` §3.4（第 198–243 行）、§5.6 第 8/9/10 项（第 472–474 行）；`docs/02-system-architecture.md` §6–§7（第 182–237 行）与 D04/D05/D06/D10（第 294–300 行）；`docs/04-database-design.md` §3/§6/§7（第 79–96、172–188 行）；`docs/05-api-contracts.md` §2/§3/§8。
> 引用约定：`04 §3 L91-L96` 表示 `docs/04-database-design.md` 第 91–96 行。契约已定义的名称（表/列/Command/DTO/错误码）只引用，不改写、不新增。

## 1 索引单位与数据结构

**单位 = PDF 页面，两表 rowid 绑定**（master_plan §3.4 L243 的要求）

- `page_text`：一页一行，存 `raw_text`（原始文本，事实来源）与 `char_count`，`UNIQUE (document_id, page_no)`（04 §3 L79-L86）。
- `page_fts`：`fts5(seg_text, tokenize='unicode61 remove_diacritics 2', content='', contentless_delete=1)`，只存倒排（04 §3 L91-L96）。
- 绑定：`page_text.id == page_fts.rowid`，由 `PageTextRepo::insert_page` 在同一事务内保证（04 §4 L157）。`INTEGER PRIMARY KEY` 即 rowid 别名，不加 AUTOINCREMENT。搜索命中 → 页码因此是一次主键等值 join，无需在 FTS 里冗余 `document_id`/`page_no`。
- 删除一页必须**同事务**先删 FTS 行再删 `page_text` 行（04 §4 L158）：rowid 会被复用，反过来删会让新页面「继承」已删内容的倒排。回归用例见 04 §9 L204。

**为什么原文不放进 FTS（D04）**：`seg_text` 是 jieba 切分后用空格连接的串（04 §7 L184）。摘录上下文、前端高亮、重建索引三件事都需要未插空格的原文；且 `seg_text` 的字符偏移与 `raw_text` 的偏移**不可互换**（§2 的空白折叠会改变长度）。故：匹配只查 `page_fts`，一切偏移只在 `raw_text` 上算。

**V-03 的两条分支**

| 分支 | 判定 | 建表 | 删一页 |
|---|---|---|---|
| A（首选） | 探针通过：FTS5 可用 且支持 `contentless_delete` | 04 §3 L91-L96 原样 | `DELETE FROM page_fts WHERE rowid = ?1` |
| B（降级，D10） | 探针失败 | 去掉 `content=''` 与 `contentless_delete=1`，其余不变 | 同上 |

差异只在 M03 内部：Repository 按 `DbCapabilities { fts5, contentlessDelete }`（03 M03 卡 L56）选建表/删除语句，M09 与 M11 的调用接口不变。若 `fts5` 完全不可用 → `DbCapabilities.fts5=false`，`search_global` 返回 `E_UNSUPPORTED`（05 §1 L55），全文搜索入口置灰；`document_list` 的 `text` 过滤仍可用（走 `idx_documents_name`，04 §3 L76）。

## 2 seg_text 构造

### 2.1 规则表

| # | 类别 | 输入 | 中间态 | seg_text |
|---|---|---|---|---|
| 1 | 中文词间单空格 | `中文分词的效果` | 同左 | `中文 分词 的 效果` |
| 2 | 英文保持原样 | `Transformer model` | 同左 | `Transformer model` |
| 3 | 连接符 | `Transformer-based` | `Transformer based` | `Transformer based` |
| 4 | 数字 | `2024年 第3.5节` | `2024年 第3 5节` | `2024 年 第 3 5 节` |
| 5 | 中英混排 | `使用BERT模型` | `使用 BERT 模型` | `使用 BERT 模型` |
| 6 | 标点一律丢弃 | `第1页，共10页。` | `第1页 共10页` | `第 1 页 共 10 页` |
| 7 | 全角→半角 | `ＡＢＣ１２３（注）` | `ABC123(注)` | `ABC 123 注` |
| 8 | 大小写 | `Bert` / `BERT` | 原样 | `Bert` / `BERT` |
| 9 | 空白折叠 | `中文\n\n分词\t效果` | 单空格 | `中文 分词 效果` |
| 10 | 超长页截断 | `seg_text` > 65536 字符 | — | 前 65536 字符，回退到最近空格边界 |
| 11 | 不可见字符 | U+0000–U+001F、U+200B、U+FEFF | 删除 | — |

规则 3 补充：标点「一律丢弃」在实现上分两步——先把连接符（`-` `/` `_` `·` `.` `'`）替换为**空格**，再把其余标点删除。若直接删除 `-`，`Transformer-based` 会粘成 `Transformerbased`，是一个库中不存在的 token，查询侧同样处理后虽对称，但可读性与调试成本都更差。不变式不变：标点不出现在 `seg_text` 中。

规则 7 用 U+FF01–U+FF5E 减 0xFEE0 映射，U+3000 → 空格，**字符数不变（1:1）**。规则 10 只截 `seg_text`，`raw_text` 保留全文，故上下文与高亮不受截断影响；65536 约为中文论文单页（1.5–4KB，04 §8 L196）的 16 倍，只在字体子集乱码导致整页变文本时触发。

### 2.2 伪代码

```text
fn build_seg_text(raw: &str) -> String:
    n1 = map_width_halfwidth(raw)                 # 1:1；同时删除不可见字符
    n2 = for c in n1: if is_joiner(c) || is_punctuation(c) then ' ' else c
    n3 = insert_cjk_latin_boundary(n2)            # CJK 与拉丁/数字交界处补空格
    n4 = collapse_ws(n3)                          # 连续空白→单空格 + trim
    words = JIEBA.cut(&n4, false)                 # 精确模式，HMM=false
    out = words.filter(|w| w.chars().any(is_alnum)).join(" ")
    if out.chars().count() > SEG_TEXT_MAX_CHARS: out = truncate_at_space(out, SEG_TEXT_MAX_CHARS)
    return out
```

`SEG_TEXT_MAX_CHARS = 65536` 是本文档定义的实现常量（非契约），改动需在交付报告中记录。

### 2.3 为什么不做 Unicode lowercase

1. 会破坏偏移 1:1：`to_lowercase` 可能改变字符数（`İ` → 2 码点），据此算出的高亮区间整体错位。
2. 不需要：`unicode61` 默认对 ASCII 做大小写折叠（`case_sensitive` 取默认 0），写 `BERT`、查 `bert` 仍命中。**该默认值须先由探针 P2 确证**（§附录），未确证前不得假设。
3. 若探针显示未折叠，修法是建表时显式写 `tokenize='unicode61 remove_diacritics 2 case_sensitive 0'` —— 属 04 §3 的 DDL 变更，走「架构变更」流程，不得就地改。

### 2.4 偏移不变式

- I1：token 逐字节相等才算命中，查询侧与写入侧必须走同一 `build_seg_text` 链路（§3.1）。
- I2：**偏移计算只以 `raw_text` 为坐标系**，`seg_text` 的偏移不得参与高亮映射。归一化拆成两个函数——`normalize_keep_len`（宽窄 1:1 + 标点→空格，长度不变，供 M08 复用）与 `collapse_ws`（改变长度，只用于索引），不得混用。

## 3 jieba-rs 使用规范

| 项 | 规定与理由 |
|---|---|
| 实例 | 进程内单例 `static JIEBA: OnceLock<Jieba>`；加载词典是重操作，禁止每页/每查询新建 |
| 模式 | 精确模式 `cut(text, false)`（HMM 关闭）：切分确定、可复现，V-04 的前提 |
| 词典 | ① crate 内置默认词典；② 项目词表 `src-tauri/src/index/dict/user_dict.txt`（UTF-8 一行一词，`include_str!` 编译期内嵌，避免运行时缺文件）；③ 首版不支持用户自定义词典 |
| 未知词 | 不额外造词、不加停用词表：标点已在 §2 删除，停用词只会让短语查询与区间匹配更难解释 |
| 英文 | 连续拉丁字母必须是单一 token（探针 P5） |
| 线程 | `Jieba` 若非 `Sync`，则每个 `spawn_blocking` 线程持有一份（探针 P6） |

方法名以 jieba-rs 0.7 的实际导出为准（`cargo doc -p jieba-rs --no-deps` 抄录签名）；本文档只约束行为。

### 3.1 查询侧必须用同一配置（V-04）

FTS5 的匹配单位是 token 精确相等。文档侧把「中华人民共和国」切成 `中华人民共和国`、查询侧切成 `中华 人民 共和国`，两者无交集 → 召回 0 且**不报错**，表现为「搜不到但没坏」。因此：

- 唯一入口：M09 暴露 `TokenizerHandle::segment(&self, s: &str) -> Vec<String>`（03 M09 卡 L121-L123），M11 只经此分词，禁止自己 `use jieba_rs`。词典路径、HMM 开关、归一化全部封在 M09 内。
- 对称性测试（关闭 V-04 的判据）：对 500 条页面文本随机抽 3–8 字连续子串 `q`，断言 `segment(q)` 是 `segment(page)` 的**子序列**。这把「两侧同配置」变成可执行条件。

## 4 查询解析流水线

| 步 | 操作 | 规则 | 边界处理 |
|---|---|---|---|
| S1 | trim | 去首尾空白（含 U+3000） | 空 → §4.3 空查询分支 |
| S2 | 长度限制 | `chars().count() <= QUERY_MAX_CHARS = 200` | 超限**截断**并 `warn!` 记原长；不报 `E_INVALID_ARG`（该码留给参数结构错误，05 §3 L189） |
| S3 | 宽窄归一 | `normalize_keep_len`（§2.4 I2） | — |
| S4 | sanitize | 白名单提取，§4.1 | 结果为空 → 空查询分支 |
| S5 | 分词 | `TokenizerHandle::segment` | token 为空 → 空查询分支 |
| S6 | 构造 MATCH | 先去重（保序）丢弃空白 token，再按 §4.2 构造 | — |

### 4.1 sanitize 正则

```text
// 白名单：字母 / 组合符 / 十进制数字 / CJK 部首扩展 / CJK 统一表意文字 / 兼容表意文字
const KEEP: Regex = r"[\p{L}\p{M}\p{Nd}\u2E80-\u2EFF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+";
// 用法：取出 KEEP 的全部匹配，用一个空格按出现顺序连接，得到「纯词面」中间串
```

白名单提取**天然**剔除 FTS5 语法字符：`" * ( ) : ^ + -` 全部落在白名单外。`AND/OR/NOT/NEAR` 是字母，不靠字符剔除（否则用户搜英文 `and` 会莫名丢词），而靠 §4.2 的引号包裹消除运算符歧义。不用黑名单的理由：黑名单永远漏字符（`{}`、列过滤 `col:`、`^` 行锚），且失败模式是**语法错误**；白名单的失败模式只有少召回。

### 4.2 MATCH 构造

```text
fn build_match(tokens: &[String], mode: SearchMode) -> String:
    assert!(tokens.iter().all(|t| !t.contains('"')))        # 引号不得进入 token，防御性
    quoted = tokens.map(|t| format!(""{}"", t))
    match mode:
        "phrase" => if tokens.len() == 1 { quoted[0] } else { format!(""{}"", tokens.join(" ")) }
        "terms"  => quoted.join(" AND ")
```

- 不变式 M1：每个 token 都被双引号包裹 → 表达式里不可能出现裸运算符。这是唯一的注入防线，比「删危险字符」可靠。
- phrase：FTS5 的引号短语 = 相邻 token 序列（04 §7 L185），与 `build_seg_text` 的连接顺序天然对齐。
- terms：`"t1" AND "t2"`，任一 token 命中即进入候选。

### 4.3 空查询与短查询

- S1 后为空、S4 后为空（纯标点）、S5 后 token 为空 → 返回 `GlobalSearchPageDto{ items: [], totalDocuments: 0, offset, limit, tookMs }`（05 §2 L143-L146），不抛错。
- token 数 = 1 且为单个汉字 → 见 §5；token 数 = 1 且含拉丁字母 → 精确匹配，不加前缀（`t*` 会把 the/this/there 全拉进来）。

## 5 为什么不用 trigram；<3 字符中文查询的真实行为

依据：master_plan §3.4 L239 明确警告 trigram 对 <3 字符查询有限制、不是中文搜索的万能补救；D05（02 §11 L295）选定 `unicode61 + jieba 预分词`，代价是查询侧必须同切分。三条量化理由：

1. **语义错位**：中文可检索性依赖 jieba 的**词**边界；trigram 按 3 字滑窗建倒排，会把跨词组合（如「确实/实在」的共享片段）变成命中，排序被噪声淹没，且无法与 `seg_text` 共用一套索引。
2. **体积**：100k 页、每页约 2KB 中文时，trigram 倒排条目约为按词方案的 3–8 倍。04 §8 L194-L195 给出按词方案 1000 篇 ≈ 150–250MB，乘 3–8 倍即 0.5–2GB，超出个人文献库可接受范围。
3. **没解决问题**：trigram 要求查询 ≥3 字符，1–2 字中文仍是盲区，只是把问题挪了位置。

当前方案的**真实行为**（无需额外实现即可推出）：2 字查询（`中华`/`算法`）通常自成 1 个 token，命中切出该词的页面，可用；1 字查询切出 `["中"]`，只命中「单独成词为 中」的页面，「中华」词内的「中」**不命中**。

1 字查询的三条路：A 前缀查询（推荐）、B 退化为 `LIKE '%中%'` 扫 `page_text.raw_text`、C 再建一张 trigram 表。

- 推荐 A：`"中"*` 可命中所有以「中」开头的 token，仍不命中词中部的字，但成本为零。
- 反对 B：100k 页 × 约 2KB ≈ 200MB 文本/次，无法下推分页，直接击穿 §11 的 P95 < 200ms。
- 反对 C：第二张 FTS 表让磁盘与写入翻倍，收益仅覆盖 1–2 字查询。

**A 的写法必须先验证**：前缀表达式的合法形态（`中*` 还是 `"中"*`）与 CJK 裸词在查询解析器中的边界定义均未在契约中确认 → 探针 P4。验证通过前走「精确 token」分支（1 字查询可能召回 0），结果面板需固定说明文案（文案由 M14 定，不在本文档范围）。

## 6 检索 SQL

```sql
-- 参数：:match(:4.2 产出) :root_n(0=不限) :root_ids(JSON) :hits_per_doc(≤5, 05 §8 L341)
--       :doc_limit(≤50, 05 §8 L342) :doc_offset
WITH matched AS (
  SELECT  t.document_id  AS document_id,
          t.page_no      AS page_no,
          t.id           AS page_text_id,
          bm25(page_fts) AS score            -- 负值，升序 = 更相关（04 §7 L187）
  FROM    page_fts
  JOIN    page_text t ON t.id = page_fts.rowid
  JOIN    documents d ON d.id = t.document_id
  WHERE   page_fts MATCH :match
    AND   d.deleted_at IS NULL
    AND   d.text_state = 'indexed'
    AND   (:root_n = 0 OR d.library_root_id IN (SELECT value FROM json_each(:root_ids)))
),
doc_rank AS (
  SELECT document_id, COUNT(*) AS hit_count, MIN(score) AS best_score
  FROM   matched GROUP BY document_id
),
doc_page AS (
  SELECT * FROM doc_rank ORDER BY best_score ASC, document_id ASC
  LIMIT :doc_limit OFFSET :doc_offset
),
page_rank AS (
  SELECT document_id, page_no, page_text_id, score,
         ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY score ASC, page_no ASC) AS rn
  FROM   matched
)
SELECT p.document_id, p.page_no, p.page_text_id, p.score, r.hit_count, r.best_score
FROM   page_rank p JOIN doc_page r ON r.document_id = p.document_id
WHERE  p.rn <= :hits_per_doc
ORDER  BY r.best_score ASC, p.document_id ASC, p.rn ASC;
```

要点：

1. **不要给 FTS 表起别名**：`bm25()` 的参数必须是 FTS 表名 `page_fts`；别名的兼容性以「先验证」为准，默认按表名写。
2. `page_text_id` 不进 DTO（05 §2 L133-L137 的 `GlobalSearchHitDto` 只有 `pageNo/snippet/ranges`），但它是取 `raw_text` 的主键，必须 SELECT。
3. `totalDocuments` 由 `SELECT COUNT(*) FROM doc_rank` 单独取一次写入 `GlobalSearchPageDto`（05 §2 L143-L146）。100k 页、常见词命中 2 万页时是对 2 万行的哈希计数，实测 < 5ms（记录表填实测值）。
4. `search_global_count`（05 §3 L190）复用同一 CTE：`documents = COUNT(*) FROM doc_rank`、`pages = COUNT(*) FROM matched`。它是「用户显式要统计」的路径（master_plan §3.4 L207），允许比 `search_global` 慢。

**先聚合再分页**（02 §7 L237）：分页单位是文档而非命中页——`GlobalSearchPageDto.items` 是 `GlobalSearchResultDto[]`、每个元素自带 `hits[]`（05 §2 L139-L146），所以 `LIMIT` 必须作用在 `doc_rank` 上。否则首屏 3 条可能全是同一篇论文的第 3/5/7 页，用户看到「一篇」而不是「一批」。`hitCount` 必须是该文档的**总命中页数**，不能等于本次返回的页数，故计数（`doc_rank.hit_count`）与截断（`page_rank.rn <= :hits_per_doc`）必须分两处。

**上下文计算后置**：最终只需 ≤ 50 × 5 = 250 行。顺序是「SQL 取 250 行 → 按 `page_text_id` 一次 `IN` 批量取 `raw_text` → 逐行算窗口」。禁止先 JOIN 出 2 万行 `raw_text`（≈40MB 无效传输）再丢弃。

## 7 上下文窗口算法

目标：`snippet` = 原始文本上下文（含省略号）、`ranges` = snippet 内命中区间（字符索引，左闭右开）（05 §2 L133-L137）。宽度取 40：命中两侧各 20（`CONTEXT_RADIUS = 20`），250 行 × 40 字 ≈ 10KB，远低于 05 §8 L343 的 1MB payload 目标。

```text
fn build_snippet(raw: &str, tokens: &[String]) -> (String, Vec<(usize, usize)>)
  occ = find_all(raw, tokens)                  # 字符索引；拉丁 token 按 ASCII 折叠比较，CJK 直接比较
  if occ.is_empty(): return (first_40_chars(raw), [])   # 极端情况，不 panic
  occ.sort_by_key(start)
  wins = for (s, e) in occ:
      a = s.saturating_sub(CONTEXT_RADIUS)     # 左夹到 0
      b = min(e + CONTEXT_RADIUS, char_len)    # 右夹到末尾
      if b - a < WINDOW: b = min(a + WINDOW, char_len)    # 不足 40 向另一侧补齐
      if b - a < WINDOW: a = b.saturating_sub(WINDOW)
      (a, b)
  merged = merge(wins, gap = WINDOW_MERGE_GAP(6), cap = MAX_WINDOWS_PER_PAGE(3))
  ranges = merged.map(|(a,b)| 把窗口内 occ 折算为相对区间并裁剪到 [a,b))
  snippet = merged.map(|(a,b)| raw[a..b]).join("…")                       # U+2026
  # 首尾不贴边时各加一个 '…'，所有 range 相应整体右移
  return (snippet, ranges)
```

- 合并规则：相邻窗口 `gap <= 6` 合并（避免出现「中文……分词」这种一段话被切成两个 3 字碎片）；一页最多 3 段，按 `start` 升序保留最早的三个，保证 `ranges` 顺序稳定。
- **`ranges` 统一定义为 UTF-16 码元索引**（与 JS 字符串下标一致）；Rust 侧在序列化前把码点偏移换算为 UTF-16 偏移，否则含 emoji 的页面会整体错位。

**为什么不用 snippet()（D06）**：① `page_fts` 是 contentless 表（`content=''`，04 §3 L95），没有原文可取；② 即便换成普通 FTS 表，`snippet()` 返回的是 `seg_text` 片段，中文会变成「中文 分词 的 效果」，与页面连续文本不一致，无法定位高亮（02 §7 L235）；③ 片段长度与省略号形态由 SQLite 控制，与 05 §2 的 `ranges` 语义对不齐，需要二次反查，更贵。

## 8 命中区间 → 页内坐标（供 M08）

**契约只给了这一条通道**：`GlobalSearchHitDto` 无「页内绝对偏移」字段（05 §2 L133-L137），因此 M08 只能靠 `snippet + ranges` 自行定位。**不能靠改 DTO 绕过**（改 DTO = 架构变更）。

两段映射：段 1（M11，已完成）`raw_text` 绝对区间 → snippet 相对区间；段 2（M08，本节约定）snippet 相对区间 → `TextItem` 矩形：

1. 取 `TextContentHandle.text` 与 `.items`（05 §7 L286-L291）。
2. 在 `normalize_keep_len(text)` 上查找锚串（`ranges[0]` 前后各 6 字符）；多处命中取**第一处**。
3. 锚点位置 + `ranges` 偏移 = 页内 `[g0, g1)`。
4. 累积长度表 `prefix[i] = sum(items[0..i].str.length)`，二分定位 `g` 所属 item。
5. `x = item.x + (k / item.str.length) * item.width`，`y = item.y`，高 `item.height`（逐字符等宽插值是近似：同一 item 内字形宽度不均时会有 ≤ 半个字宽的误差，可接受；精确方案需新增字形宽度接口，属契约变更）。

**必须与 M05 的实现约定一致**（对齐规则，任一条不成立则段 2 作废）：

| # | 约定 | 违反后果 | 保证方 |
|---|---|---|---|
| A1 | `text === items.map(i => i.str).join("")`，不插分隔符、不 trim | 累积长度表整体错位，高亮漂移 | M05 单测（12 §4） |
| A2 | `items` 顺序即 `text` 拼接顺序（05 §7 L288「按阅读顺序拼接」） | 跳行、跨列错位 | M05 |
| A3 | 不合并、不拆分 `str`（与 pdfjs textContent items 一一对应） | 长度与字形宽度不再线性对应 | M05 |
| A4 | 归一化只用 `normalize_keep_len`，M11 与 M08 共用同一实现（放 `src/core/text-normalize.ts`，归属 M02） | 全角/大小写场景锚点找不到 | M02 |

**A1 必须先验证**：pdfjs 的 textContent items 是否自带分隔语义属于 V-01 探查范围（02 §1 L30）。验证方法：在真实样本上打印 `text.length` 与 `sum(items.str.length)` 是否相等；不等则 M05 必须用 items 拼接构造 `text`，不得透传 pdfjs 原始文本。**在 M05 补上该断言前，M08 的段 2 视为无实现前提。**

接口边界：M11 → M14 传 `{documentId, pageNo, snippet, ranges}`；M08 完成段 2 换算后调 `goToPage(pageNo, { highlightRanges })`（05 §7 L331）。注意 `ReaderApi.goToPage` 的 `highlightRanges` 是**页内**区间，与 `GlobalSearchHitDto.ranges`（snippet 内）不是同一坐标系——直接把 snippet 区间透传给 `goToPage` 是本设计最容易出的坐标串号。

## 9 增量、重建与 text_state 联动

| text_state（04 §3 L62-L63） | 参与检索 | 理由 |
|---|---|---|
| `pending` | 否 | `page_fts` 可能仍含上一版内容（mtime 变更后同事务删除，04 §6 L177），会「搜到但页码对不上」 |
| `indexing` | 否 | 只写到批边界（02 §6 L210），半截索引让结果随进度抖动 |
| `indexed` | **是** | 唯一可检索态 |
| `no_text` | 否 | 无 FTS 行（扫描件，D11）；过滤只是省一次 join |
| `failed` | 否 | 无 FTS 行，终态 |

结论：SQL 里的 `text_state = 'indexed' AND deleted_at IS NULL` 是**语义正确性**要求，不是性能优化。

重建（`index_rebuild_all`，05 §3 L188；04 §6 L180）：清空 `page_fts` 与 `page_text` → 未删除文档全置 `pending` → 重新入队。**重建中途可读**：已完成重建的文档立即重新可搜，未完成的搜不到；进度来自 `index://progress`（05 §4 L217），文案由 M14 定。

增量三入口（02 §8 L243-L264）：新增 → `insert documents(text_state='pending')` 并入队 `kind='text'`；`size/mtime` 变化 → 同事务删该文档全部 FTS 行与 `page_text` 行（04 §6 L177）再置 `pending`；文件消失 → 软删除 `deleted_at` 并清索引，检索被 `deleted_at IS NULL` 挡住。

## 10 排序与相关性

1. 相关度：`ORDER BY bm25(page_fts) ASC`（04 §7 L187：bm25 返回负值，越小越相关）。
2. 同分稳定次序：文档级 `(best_score ASC, document_id ASC)`，页级 `(score ASC, page_no ASC)`。理由：无全序 ORDER BY 时 SQLite 不保证行序，「下一页」会出现重复或漏项。
3. 文档级分数取 `MIN(score)`（该文档最好那一页）而非平均：用户判断相关性看最佳命中，平均会被几百个弱命中拉平。
4. 不启用列权重（`bm25(page_fts, w)`）也不做时间/库根加权：前者只有一列、无意义，后者因 `GlobalSearchParams` 无排序字段（05 §2 L125-L131）而等于自行扩契约。

## 11 性能目标与验证

目标：100k 页、常见中文双字词，`search_global` 端到端（含 DTO 组装）**P95 < 200ms**。

| 手段 | 做法 | 检查点 |
|---|---|---|
| 只查倒排 | `WHERE page_fts MATCH` 强制走 FTS5 索引 | 计划含 `SCAN page_fts VIRTUAL TABLE INDEX` |
| 主键 join | `ON t.id = page_fts.rowid` | 计划含 `SEARCH t USING INTEGER PRIMARY KEY` |
| 不 `count(*)` 全扫 | 计数走 `doc_rank` | 计划里无 `SCAN page_text` |
| 截断在前 | `LIMIT` 作用在 `doc_rank`（≤50 行） | `doc_page` 带 `LIMIT` |
| 上下文后置 | 只对 ≤250 行取 `raw_text`（§6） | 日志 `rows` ≤ 250 |
| 预编译 + 只读连接 | 三条固定 SQL 用 `prepare_cached`，MATCH 只做绑定；检索走只读连接池（04 §2 L22） | 无每次拼 SQL；读写不互相 `busy_timeout` |

`EXPLAIN QUERY PLAN` 检查（在 100k 页基准库上，参数用常量占位）：

```text
EXPLAIN QUERY PLAN
WITH matched AS (
  SELECT t.document_id, t.page_no, t.id, bm25(page_fts) AS score
  FROM page_fts JOIN page_text t ON t.id = page_fts.rowid
  JOIN documents d ON d.id = t.document_id
  WHERE page_fts MATCH '"中文" AND "分词"'
    AND d.deleted_at IS NULL AND d.text_state = 'indexed'
) SELECT * FROM matched;
```

三条判据全部满足才算通过：① 首行含 `VIRTUAL TABLE INDEX` 且属 `page_fts`；② 出现对 `page_text` 的 `SEARCH ... INTEGER PRIMARY KEY`；③ **不出现** `SCAN page_text` / `SCAN documents`（带 `rootIds` 时允许用 `idx_documents_root`，04 §3 L73）。

计时：Rust 内用 `Instant::now()` 包住「SQL + 上下文 + DTO 组装」，写进 `GlobalSearchPageDto.tookMs`（05 §2 L146）并 `tracing::info!(elapsed_ms)`。基准：同一查询连跑 20 次取 **P95**（不是平均），100 条预置查询各跑一次组成样本，丢弃第一次（冷缓存）。记录表模板见 `docs/12-testing-strategy.md` §6。若首轮不达标，先降 `hitsPerDocument` 到 1 复测以定位瓶颈（上下文计算 vs FTS 查询），再决定优化方向。

## 12 边界用例表

| # | 输入 | 期望行为 | 判定方式 |
|---|---|---|---|
| 1 | `""` 空串 / `"   "` 空格串 | `items: []`、`totalDocuments: 0`、`tookMs` 有值；不抛 `ApiError` | 断言 DTO 三字段 |
| 3 | `中` 单汉字 | P4 通过则走前缀查询并返回以「中」开头的词；未通过则返回空结果且不报错 | 单测 + §5 决策记录 |
| 4 | `transformer` 英文单词 | 精确 token 匹配，命中 `Transformer`（依赖 P2 折叠结论） | 单测（P2 通过后） |
| 5 | `"` 单个双引号 | 白名单提取为空 → 空结果；不会构造 MATCH | 断言 `build_match` 未被调用 |
| 6 | `*` | 同上（`*` 是 FTS 前缀通配符，必须不进表达式） | 同上 |
| 7 | `AND` | 变成 `"AND"` 作为普通词检索；库中无该词则空结果 | 断言 MATCH 含 `"AND"`，SQL 无语法错 |
| 8 | `NEAR` | 同 #7，不得被当作邻接运算符 | 同上 |
| 9 | `(中文)` | 白名单取 `中文`，括号丢弃 → 短语检索 | 断言 MATCH = `"中文"` |
| 10 | `，。！？` 纯标点 | 空结果，不报错 | 同 #1 |
| 11 | 300 字长串 | 截断到 200 字符后处理，`warn!` 记原长，不报 `E_INVALID_ARG` | 断言切分输入长度 = 200 |
| 12 | `使用BERT的模型` | seg_text = `使用 BERT 的模型`；查 `BERT` 可命中 | 断言两侧 token 有交集 |
| 13 | `中華民國` 繁体 | 繁体原样切分存储；查简体 `中华` **不命中**（不做简繁转换） | 断言召回 0，UI 文案由 M14 说明 |
| 14 | `😀😀` emoji | 非字母非数字 → 白名单提取为空 → 空结果 | 同 #1 |
| 15 | `\u3000中文\u3000` 全角空格 | trim 后正常检索 `中文` | 断言 S1 后长度 = 2 |
| 16 | `"中文 分词"` 双词 | phrase = 邻近短语；terms = `"中文" AND "分词"`，两者结果可不同 | 两模式各一条断言，phrase 命中数 ≤ terms |
| 17 | 一个词同页命中 20 次 | `ranges` ≤ 3 组（§7 上限）；该页在 `hits` 中只出现一次 | 断言 `ranges.len() <= 3` 且 pageNo 不重复 |

## 附录 · 探针清单（V-03 扩展用例；关闭后方可进入实现）

| 用例 | 执行内容 | 通过判据 |
|---|---|---|
| P1（= V-03） | `CREATE VIRTUAL TABLE temp.t USING fts5(a, content='', contentless_delete=1)` | 不报错；失败走 §1 分支 B |
| P2 | 普通 FTS5 表插 `BERT`，查 `bert` | 返回 1 行 → unicode61 默认折叠 ASCII 大小写 |
| P3 | 插 `中文 分词`，查 `"中文 分词"` | 返回 1 行 → 短语语义符合 §4.2 |
| P4 | 分别执行 `"中"*` 与 `中*` | 至少一种被接受且命中以「中」开头的 token → 才可启用 §5 方案 A |
| P5（= V-04） | `cut("Transformer-based 模型", false)` | 英文串不被拆分；同文本两次切分结果逐字节相同 |
| P6 | 编译期断言 `Jieba: Sync` | 通过用单例，否则每线程一份 |
| P7 | 同一文本调 `build_seg_text` 两次 | 结果逐字节相等 |
