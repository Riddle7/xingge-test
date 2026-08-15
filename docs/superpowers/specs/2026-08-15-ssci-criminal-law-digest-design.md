# SSCI 刑法论文每日雷达 · 设计文档

- 日期：2026-08-15
- 状态：已获用户批准
- 项目位置：`d:\trae\cl-digest\`（新建）
- 目标用户：刑法学研究人员
- 产品定义：经 SSCI 期刊白名单核验、刑法语义分层、带中文导读的每日论文雷达 —— 网站快读 + RSS 订阅，全程可追溯、可纠错。

## 1. 定案参数

| 参数 | 决定 |
|---|---|
| 期刊范围 | 仅 SSCI（Law + Criminology & Penology 等相关类别，人工核验） |
| 内容口径 | 宽口径收录，按相关性三档 + 子领域标签分层呈现 |
| 一期渠道 | 静态站 + RSS（邮件二期，接合规 ESP） |
| 部署 | 挂入现有站点生态（Cloudflare），GJ 主站加入口卡片，公开访问 |

既知限制（记录在案）：仅 SSCI 会漏掉部分 ESCI 刑法教义学专门刊；二期用漏收率数据评估后再决定是否加扩展层。

## 2. 背景与方案审查结论

原始方案（gpt5.6sol 提供）经全面审查，以下判断成立、直接继承：

- 两阶段筛选：SSCI 期刊维度 × 文章内容维度分离；
- 回看 7—14 天窗口 + DOI 去重 + `first_seen_at`（页面写"首次监测到"，不声称"今日发表"）;
- 相关性三档 + 边界人工审核 + `inclusion_reason` 可解释性；
- LLM 防幻觉原则（只基于标题+摘要、不虚构、原始摘要可核对）；
- 分层呈现（重点 3—5 篇全字段 / 其余标题+导读 / 边界待审），不堆摘要。

实质性改进（相对原方案）：

1. 数据源主次反转：Crossref 负责"发现"（from-created-date 当天可见、及时），OpenAlex 负责"补全"（摘要倒排索引重建、topics、作者规范化）。原方案以 OpenAlex 为主查询源会因收录滞后把日报做成周报。
2. 不 fork `X-PG13/paper-digest`：核查确认其概念模型是 arXiv 中心的 feed/topic 订阅，与本需求的"ISSN 白名单 × 语义分层 × 法学元数据"错位，改造需动三层，收益低于自建精简流水线（约 600—800 行 Python）。该仓库及原方案列出的其余 8 个仓库一律降级为架构参考，不是依赖。
3. 中文一句话导读提前到一期：对中文研究者，纯英文标题+摘要列表信息价值低，导读是核心增量。
4. 邮件后置到二期：邮件基建（域名、SPF/DKIM、退订、送达率）是独立合规工程。
5. 存储：JSONL + Git，不用 SQLite，避免"库文件提交进 Git → 将来迁 PostgreSQL"的弯路。日均 <50 篇，JSONL 可 diff 审计、静态站直读、CI 无状态。
6. 补评估与监控：人工标注 golden set（~150 篇）、prompt/阈值变更跑 precision/recall 回归、零结果告警、每周 catch-up 全量重扫。
7. 分类体系一期瘦身：相关性三档 + 子领域单标签；法域、研究类型（规范/实证/比较）二期再加。
8. 执行细节：type 过滤放宽为 `article + review`（只留 article 会漏综述）；SSCI 含德/法/西语刊，需语言检测字段，中文导读基于原文而非英文转译。

## 3. 系统架构

```
journals.csv（SSCI 白名单，MJL 官方导出初始化 + 人工核验，季度复核）
      │
 ① 发现  Crossref：ISSN 过滤 + from-created-date 回看 14 天，type=journal-article|review
      │
 ② 补全  OpenAlex：摘要倒排索引重建、topics、作者规范化（失败则降级为仅元数据）
      │
 ③ 规范化去重  DOI 清洗 → seen.jsonl 指纹比对 → 只保留未推送记录
      │
 ④ LLM 分诊（全量，单次调用/篇）
      输入：标题 + 原始摘要 + 白名单刑法术语词表（prompt 附件）
      输出：relevance 三档 + 子领域标签 + 中文标题 + 一句话导读 + 收录理由
      约束：temperature 0 · JSON Schema 校验 · 失败重试 1 次后降级 borderline
      │
  ├─ core / related → 当日简报（重点 3—5 篇全字段，其余标题+导读）
  ├─ borderline     → review-queue/ 当日 markdown，GitHub Web UI 人工裁决
  └─ 无摘要         → 正常收录，标"摘要暂缺"，导读仅基于标题并明确标注
      │
 ⑤ 渲染  静态日页 + 归档页（日期/期刊/子领域筛选，fuse.js 客户端搜索）
          + RSS feed.xml + papers-YYYY-MM.jsonl 入库
      │
 ⑥ git commit → 部署（全流程成功才提交，保证原子性）
```

简化说明：不设独立"规则召回"层——白名单刊日均新文 20—80 篇，LLM 全量分诊成本可忽略，词表退化为 prompt 附件。

## 4. 模块与数据契约

目录结构：

```
cl-digest/
├── app/
│   ├── fetch.py          # ①② Crossref 发现 + OpenAlex 补全（重试+礼貌池 mailto）
│   ├── normalize.py      # ③ DOI 清洗 / 日期解析 / 倒排索引重建 / 去重
│   ├── classify.py       # ④ LLM 分诊 + Schema 校验 + 降级
│   ├── render.py         # ⑤ 静态页 / RSS / 审核队列
│   └── daily.py          # 编排入口（原子提交）
├── data/
│   ├── journals.csv      # 白名单：journal_name, issn_l, print_issn, online_issn,
│   │                     #         wos_category, coverage_start, verified_at
│   ├── lexicon.md        # 刑法术语/罪名/法域词表（prompt 附件）
│   ├── seen.jsonl        # DOI 指纹（防重发）
│   ├── papers-YYYY-MM.jsonl
│   └── review-queue/2026-08-15.md
├── （渲染输出直接写入仓库根 digest/，即主站 /digest/ 子路径，git push 即部署）
├── eval/golden.jsonl + run_eval.py   # 人工标注集 + P/R 回归
└── .github/workflows/daily.yml
```

papers.jsonl 单条记录（一期精简，法域/研究类型二期再加）：

```json
{
  "doi": "10.1093/oxresgr/rgaa014",
  "title_original": "...",
  "title_zh": "（机器翻译）...",
  "authors": ["..."],
  "journal_name": "...", "journal_issn_l": "...",
  "pub_date_online": "2026-08-15", "pub_date_issue": null,
  "first_seen_at": "2026-08-15",
  "abstract_original": "（重建后原文，可能 null）",
  "abstract_source": "openalex | crossref | none",
  "lang": "en | de | fr | es",
  "relevance": "core | related | borderline",
  "subfield": "criminal_law_core | criminal_procedure | international_criminal_law | criminology | penology | interdisciplinary",
  "tldr_zh": "一句话导读（只复述摘要既有信息）",
  "inclusion_reason_zh": "为什么收录",
  "llm_model": "...", "generated_at": "..."
}
```

LLM 契约：

- OpenAI 兼容接口，`LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 环境变量配置，模型可换；
- 导读硬约束：禁止推断作者未陈述的结论、数据、法域；不虚构研究对象、样本、方法；
- 原始摘要在网站上折叠展示、标注来源与抓取时间，杜绝黑箱；
- 所有 AI 生成内容标注"机器生成，仅供快速浏览"。

## 5. 运维与评估

- 调度：GitHub Actions 每日 UTC 00:10（北京早 8:10）+ 每周一 catch-up 全量重扫 30 天（覆盖 cron 抖动与索引滞后长尾）。
- 告警：当日 Crossref 结果为 0 且白名单非空 → 视为流水线故障，任务失败并通知；Actions 失败本身即通知。
- 评估：人工标注约 150 篇 golden set；每次改 prompt/词表/阈值跑 `run_eval.py` 出 precision/recall，core 类目标 P ≥ 0.90，不达标不合并。
- 版权：不碰付费墙；网站元数据 + 自产导读为主，原摘要折叠 + 来源标注；RSS 不输出全文，只给标题+导读+链接。

## 6. 测试策略

- `normalize.py`：DOI 清洗、日期解析、倒排索引重建的单元测试（pytest）；
- `classify.py`：Schema 校验、失败降级路径测试（mock LLM）；
- `render.py`：产物冒烟测试（日页含 N 篇、RSS 合法 XML）；
- 端到端：golden set 回归即集成测试。

## 7. 分期

| 期 | 交付 |
|---|---|
| 一期 | 白名单 25—40 刊核验 · Crossref+OpenAlex 双源采集 · 去重 · LLM 分诊 + 中文导读 · 静态日页/归档/RSS · 审核队列 · golden set · 部署上线 |
| 二期 | 邮件简报（ESP + 退订）· 法域/研究类型标签 · 分主题 RSS · 用户纠错反馈环 · 漏收率评估（复议 ESCI 层） |
| 三期 | 关键词/期刊个性化订阅 · Zotero/RIS/BibTeX 导出 · 周趋势 · 与文献星云图（nebula/）联动 |

## 8. 工程约束对照（AGENTS.md）

- 不保留向后兼容：全新项目，无历史包袱；
- 最简实现：JSONL 而非数据库、LLM 全量分诊省掉召回层、一期无鉴权无后端；
- 分层生长：一期端到端跑通（发现→导读→上站），二三期在其上叠加；
- 组件模块化：fetch / normalize / classify / render / daily 五个职责单一模块；
- 成熟库：requests、jinja2（或等价模板）、feedgen/feedformatter、fuse.js（前端搜索）优先，不自造轮子。
