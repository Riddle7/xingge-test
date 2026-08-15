# SSCI 刑法论文每日雷达 · 一期 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 `cl-digest/` 流水线：每日从 Crossref 发现 SSCI 白名单期刊新论文 → OpenAlex 补全 → LLM 刑法分诊 + 中文导读 → 渲染静态日页/归档/RSS 到仓库根 `digest/`（git push 即部署到主站 `/digest/`）→ GitHub Actions 自动运行。

**Architecture:** 五个单一职责模块（fetch 抓取 / normalize 纯函数规范化 / classify LLM 分诊 / render 渲染 / daily 编排），数据全部为 JSONL+CSV 文件（无数据库），状态（papers/seen/review-queue）提交进 git。渲染输出直接写仓库根 `digest/`，与 `cpti/`、`nebula/` 同级（主站由仓库根静态服务，已核实 remote=Riddle7/xingge-test）。

**Tech Stack:** Python 3.12 · requests · jinja2 · feedgen · langdetect · python-dotenv · pytest + responses（测试）· fuse.js 7（客户端搜索，本地 vendored）· GitHub Actions。

**规格文档:** `docs/superpowers/specs/2026-08-15-ssci-criminal-law-digest-design.md`

**约定:** 以下所有命令均在工作目录 `d:\trae\cl-digest\` 下执行（Task 1 创建）。Python 模块统一绝对导入 `from app import ...`，入口一律 `python -m app.<module>`。

---

### Task 1: 项目骨架与期刊白名单种子

**Files:**
- Create: `cl-digest/app/__init__.py`（空文件）
- Create: `cl-digest/app/config.py`
- Create: `cl-digest/data/journals.csv`
- Create: `cl-digest/data/lexicon.md`
- Create: `cl-digest/data/seen.jsonl`（空文件）
- Create: `cl-digest/app/verify_journals.py`
- Create: `cl-digest/requirements.txt`
- Create: `cl-digest/requirements-dev.txt`
- Create: `cl-digest/.env.example`
- Create: `cl-digest/tests/__init__.py`（空文件）
- Modify: `d:\trae\.gitignore`（追加 `.env`、`__pycache__/`）

- [ ] **Step 1: 创建目录与基础文件**

```powershell
# 在 d:\trae 下执行
mkdir cl-digest, cl-digest/app, cl-digest/data, cl-digest/data/review-queue, cl-digest/static, cl-digest/tests, cl-digest/eval
New-Item cl-digest/app/__init__.py, cl-digest/tests/__init__.py, cl-digest/eval/__init__.py, cl-digest/data/seen.jsonl | Out-Null
```

- [ ] **Step 2: 写入 config.py**

```python
"""cl-digest 全局配置：路径常量 + 环境变量。"""
import os
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent          # cl-digest/app
PROJECT_DIR = APP_DIR.parent                        # cl-digest
REPO_ROOT = PROJECT_DIR.parent                      # 仓库根（主站）
DATA_DIR = PROJECT_DIR / "data"
STATIC_DIR = PROJECT_DIR / "static"                 # style.css / fuse.min.js
TEMPLATES_DIR = APP_DIR / "templates"
SITE_DIR = REPO_ROOT / "digest"                     # 主站 /digest/ 子路径，git push 即部署
JOURNALS_CSV = DATA_DIR / "journals.csv"
SEEN_JSONL = DATA_DIR / "seen.jsonl"
REVIEW_DIR = DATA_DIR / "review-queue"

load_dotenv(PROJECT_DIR / ".env")  # 本地开发时读取 cl-digest/.env

MAILTO = os.environ.get("CL_DIGEST_MAILTO", "digest-bot@example.com")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "glm-4.6")
SITE_URL = os.environ.get("SITE_URL", "")  # 可选，RSS 自引用用

RELEVANCE_TIERS = ("core", "related", "borderline")
SUBFIELDS = (
    "criminal_law_core", "criminal_procedure", "international_criminal_law",
    "criminology", "penology", "interdisciplinary",
)
```

- [ ] **Step 3: 写入 journals.csv 种子（32 刊）**

说明：ISSN 为种子值，Step 6 用 Crossref 逐条核验；`verified_at` 留空，SSCI 属性须用户按 Task 12 的步骤在 Clarivate MJL 人工确认后回填。

```csv
journal_name,issn_l,print_issn,online_issn,wos_category,coverage_start,verified_at
Criminology,0011-1384,0011-1384,1745-9125,Criminology & Penology,,
British Journal of Criminology,0007-0955,0007-0955,,Criminology & Penology,,
Journal of Criminal Law and Criminology,0091-4169,0091-4169,,Law; Criminology & Penology,,
Journal of Criminal Justice,0047-2352,0047-2352,,Criminology & Penology,,
Punishment & Society,1469-4737,1469-4737,1741-2605,Criminology & Penology; Law,,
Theoretical Criminology,1362-4806,1362-4806,,Criminology & Penology,,
European Journal of Criminology,1477-3708,1477-3708,,Criminology & Penology,,
Journal of Quantitative Criminology,0748-4518,0748-4518,1573-7799,Criminology & Penology,,
Journal of Research in Crime and Delinquency,0022-4278,0022-4278,,Criminology & Penology,,
Criminal Justice and Behavior,0093-8548,0093-8548,,Criminology & Penology; Psychology,,
Journal of Experimental Criminology,1573-3750,1573-3750,1573-3769,Criminology & Penology,,
International Journal of Offender Therapy and Comparative Criminology,0306-624X,0306-624X,,Criminology & Penology; Psychology,,
Journal of Contemporary Criminal Justice,1043-9862,1043-9862,,Criminology & Penology,,
Criminology & Public Policy,1531-0287,1531-0287,,Criminology & Penology; Law,,
Criminology & Criminal Justice,1748-8958,1748-8958,1748-8966,Criminology & Penology,,
Youth Violence and Juvenile Justice,1541-2040,1541-2040,,Criminology & Penology,,
Sexual Abuse,1079-0632,1079-0632,1573-2851,Criminology & Penology; Psychology,,
Aggression and Violent Behavior,1359-1789,1359-1789,1873-6137,Criminology & Penology; Psychology,,
Trauma Violence & Abuse,1524-8380,1524-8380,1552-8321,Criminology & Penology; Psychology,,
Journal of Interpersonal Violence,0886-2605,0886-2605,,Criminology & Penology; Psychology,,
Psychology Public Policy and Law,1076-8971,1076-8971,1935-970X,Law; Psychology,,
Law and Human Behavior,0147-7307,0147-7307,1573-661X,Law; Psychology,,
International Journal of Law Crime and Justice,1756-0616,1756-0616,,Law; Criminology & Penology,,
Crime Law and Social Change,0925-4994,0925-4994,1573-0751,Law; Criminology & Penology,,
Journal of International Criminal Justice,1478-1387,1478-1387,,Law,,
Psychology Crime & Law,1068-316X,1068-316X,1477-2744,Psychology; Law,,
Journal of Law and Society,0263-323X,0263-323X,1467-6478,Law,,
Law & Social Inquiry,0897-6546,0897-6546,1747-4469,Law,,
Journal of Empirical Legal Studies,1540-429X,1540-429X,1740-1461,Law,,
Legal Studies,0261-3881,0261-3881,,Law,,
Criminal Law and Philosophy,1875-6648,1875-6648,,Law,,
Journal of Scandinavian Studies in Criminology and Crime Prevention,1404-3858,1404-3858,,Criminology & Penology,,
```

- [ ] **Step 4: 写入 lexicon.md（LLM 分诊词表，prompt 附件）**

```markdown
# 刑法分诊词表（供 LLM 分诊使用）

## subfield 判定线索
- criminal_law_core（实体刑法核心）: criminal law, criminal liability, mens rea, actus reus,
  culpability, criminal responsibility, elements of the offence, attempted crime, complicity,
  joint offending, self-defence/self-defense, justification, necessity, insanity defence,
  intoxication, strict liability, homicide, murder, manslaughter, assault, theft, robbery,
  burglary, fraud, corruption, bribery, drug offences/trafficking, cybercrime, terrorism,
  terrorist financing, money laundering, corporate criminal liability, criminalization,
  decriminalization, overcriminalization, theory of punishment, retribution, deterrence,
  proportionality of punishment, sentencing theory, penal theory, purposes of punishment
- criminal_procedure: criminal procedure, due process, presumption of innocence, standard of
  proof, exclusionary rule, right to counsel, custodial interrogation, confession, plea
  bargaining, prosecutorial discretion, pretrial detention, jury trial, double jeopardy,
  wrongful conviction, criminal appeal, evidence law (criminal context)
- international_criminal_law: international criminal court, ICC, Rome Statute, war crimes,
  crimes against humanity, genocide, crime of aggression, universal jurisdiction,
  international criminal tribunal, transnational organised crime, extradition
- criminology: crime rate, offending, recidivism, criminal careers, victimization, fear of
  crime, crime prevention, situational prevention, deterrence studies (empirical)
- penology: imprisonment, prison, incarceration, parole, probation, community sanctions,
  solitary confinement, prisoner reentry, rehabilitation programmes
- interdisciplinary: 法律与心理学/经济学/技术交叉且与刑事实体法或刑事程序相关

## relevance=borderline 的典型情形
- 纯犯罪学实证研究（问卷、统计建模）而完全不涉及规范讨论
- 警务管理、监狱卫生、受害者心理干预、青少年司法社会工作
- 仅在结论或背景中顺带提及刑法问题
- 无法从标题和摘要判断研究对象是否为刑法问题

## 明确 irrelevant 的情形（此情形仍输出 borderline 由人工裁决，不直接丢弃）
- 民商法、宪法、行政法、国际公法（非刑事）、纯方法学/统计学研究
```

注意：一期不设 irrelevant 自动丢弃——凡进入流水线的论文至少标记 borderline 进入人工审核（与 spec 一致）。

- [ ] **Step 5: 写入 verify_journals.py（ISSN 核验工具）**

```python
"""逐条核验 journals.csv 的 ISSN 是否能在 Crossref 解析：python -m app.verify_journals"""
import csv
import sys

import requests

from . import config


def main() -> int:
    with open(config.JOURNALS_CSV, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    bad = 0
    for row in rows:
        issn = row["issn_l"]
        try:
            r = requests.get(
                f"https://api.crossref.org/journals/{issn}",
                params={"mailto": config.MAILTO}, timeout=30,
            )
            if r.status_code == 200:
                title = r.json()["message"]["title"]
                print(f"OK   {issn}  {title}")
            else:
                bad += 1
                print(f"FAIL {issn}  {row['journal_name']}  HTTP {r.status_code}")
        except requests.RequestException as e:
            bad += 1
            print(f"FAIL {issn}  {row['journal_name']}  {e}")
    print(f"\n{len(rows)} 刊，{bad} 条核验失败")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: 运行核验**

Run: `python -m app.verify_journals`
Expected: 每行 OK；若出现 FAIL，用 `https://api.crossref.org/journals/<issn>` 浏览器核对正确 ISSN 并修正 journals.csv 后重跑，直到 0 失败。同时人工比对每行 Crossref 返回的 title 与 journal_name（改名/错配须修正）。

- [ ] **Step 7: 写入依赖与 .env.example，更新 .gitignore**

`requirements.txt`:

```text
requests>=2.31
jinja2>=3.1
feedgen>=1.0
langdetect>=1.0.9
python-dotenv>=1.0
```

`requirements-dev.txt`:

```text
-r requirements.txt
pytest>=8.0
responses>=0.25
```

`cl-digest/.env.example`:

```text
# 复制为 cl-digest/.env（已 gitignore）并填写
CL_DIGEST_MAILTO=your-email@example.com
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_API_KEY=
LLM_MODEL=glm-4.6
# 可选：站点绝对地址（RSS 自引用链接），如 https://<你的域名>
SITE_URL=
```

在 `d:\trae\.gitignore` 末尾追加：

```text
cl-digest/.env
__pycache__/
```

- [ ] **Step 8: 安装依赖并提交**

```powershell
pip install -r requirements-dev.txt
cd d:\trae
git add cl-digest .gitignore
git commit -m "feat(digest): 项目骨架、SSCI 期刊白名单种子与分诊词表"
```

---

### Task 2: normalize — DOI 清洗

**Files:**
- Create: `cl-digest/app/normalize.py`
- Test: `cl-digest/tests/test_normalize.py`

- [ ] **Step 1: 写失败测试**

```python
"""normalize 纯函数单元测试。"""
from app.normalize import clean_doi


def test_clean_doi_strips_url_prefix():
    assert clean_doi("https://doi.org/10.1093/oxresgr/rgaa014") == "10.1093/oxresgr/rgaa014"


def test_clean_doi_strips_doi_prefix_and_lowercases():
    assert clean_doi("DOI:10.X/Y") == "10.x/y"
    assert clean_doi("doi:10.1007/s12345-026-00123-4") == "10.1007/s12345-026-00123-4"


def test_clean_doi_rejects_invalid():
    assert clean_doi("not a doi") is None
    assert clean_doi("") is None
    assert clean_doi(None) is None
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: FAIL / ERROR（`No module named 'app.normalize'`）

- [ ] **Step 3: 实现**

```python
"""规范化纯函数：DOI 清洗、日期解析、摘要重建、记录组装、去重。无 IO。"""
import html
import re

DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
DOI_PREFIX_RE = re.compile(r"^(?i:(?:https?://)?(?:dx\.)?doi\.org/|doi:\s*)")


def clean_doi(raw):
    """清洗为规范 DOI（小写、去前缀）；非法返回 None。"""
    if not raw or not isinstance(raw, str):
        return None
    doi = DOI_PREFIX_RE.sub("", raw.strip()).lower()
    return doi if DOI_RE.match(doi) else None
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: 3 passed

- [ ] **Step 5: 提交**

```powershell
git add app/normalize.py tests/test_normalize.py
git commit -m "feat(digest): DOI 清洗函数"
```

---

### Task 3: normalize — 日期解析、倒排索引重建、JATS 剥离

**Files:**
- Modify: `cl-digest/app/normalize.py`
- Test: `cl-digest/tests/test_normalize.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
from app.normalize import parse_date, rebuild_abstract, strip_jats


def test_parse_date_full_and_partial():
    assert parse_date({"date-parts": [[2026, 8, 15]]}) == "2026-08-15"
    assert parse_date({"date-parts": [[2026, 8]]}) == "2026-08"
    assert parse_date({"date-parts": [[2026]]}) == "2026"
    assert parse_date({}) is None
    assert parse_date(None) is None


def test_rebuild_abstract_orders_by_position():
    inv = {"world": [2], "hello": [0], ",": [1]}
    assert rebuild_abstract(inv) == "hello , world"
    assert rebuild_abstract(None) is None
    assert rebuild_abstract({}) == ""


def test_strip_jats_removes_tags_and_unescapes():
    assert strip_jats("<p>A &amp; B</p>") == "A & B"
    assert strip_jats("Plain") == "Plain"
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: 新增 3 个 FAIL（函数未定义）

- [ ] **Step 3: 实现（追加到 normalize.py）**

```python
JATS_RE = re.compile(r"<[^>]+>")


def parse_date(msg_part):
    """Crossref/OpenAlex 日期对象 {'date-parts': [[Y,M,D?]]} → 'YYYY-MM-DD'|'YYYY-MM'|'YYYY'|None。"""
    try:
        parts = (msg_part or {}).get("date-parts", [[]])[0]
    except (AttributeError, IndexError, TypeError):
        return None
    if not parts:
        return None
    return "-".join(f"{int(p):02d}" if i else str(int(p)) for i, p in enumerate(parts))


def rebuild_abstract(inverted):
    """OpenAlex abstract_inverted_index {词: [位置]} → 按位置重排的原文；None 入参返回 None。"""
    if inverted is None:
        return None
    slots = {}
    for word, positions in inverted.items():
        for pos in positions:
            slots[pos] = word
    return " ".join(slots[p] for p in sorted(slots))


def strip_jats(text):
    """剥离 Crossref 摘要中的 JATS XML 标签并反转义实体。"""
    return html.unescape(JATS_RE.sub("", text or "")).strip()
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: 6 passed

- [ ] **Step 5: 提交**

```powershell
git add app/normalize.py tests/test_normalize.py
git commit -m "feat(digest): 日期解析、OpenAlex 摘要重建与 JATS 剥离"
```

---

### Task 4: normalize — 语言检测、记录组装、去重过滤

**Files:**
- Modify: `cl-digest/app/normalize.py`
- Test: `cl-digest/tests/test_normalize.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
from app.normalize import build_record, detect_lang, filter_new

CROSSREF_ITEM = {
    "DOI": "10.1093/oxresgr/rgaa014",
    "title": ["Criminal Liability for Robots"],
    "author": [{"given": "A.", "family": "Author"}, {"name": "B. Author"}],
    "container-title": ["Some Journal"],
    "ISSN": ["0000-0000"],
    "issued": {"date-parts": [[2026, 8, 15]]},
    "published-print": {"date-parts": [[2026, 9]]},
    "abstract": "<p>We argue that <i>mens rea</i> matters.</p>",
}
OPENALEX_WORK = {
    "doi": "https://doi.org/10.1093/oxresgr/rgaa014",
    "language": "en",
    "abstract_inverted_index": {"We": [0], "argue": [1]},
}


def test_detect_lang_defaults_and_detects():
    assert detect_lang("Kriminalität und Schuld", None) in ("de", "other")
    assert detect_lang("", None) == "other"


def test_build_record_prefers_openalex_abstract():
    rec = build_record(CROSSREF_ITEM, OPENALEX_WORK, first_seen="2026-08-15")
    assert rec["doi"] == "10.1093/oxresgr/rgaa014"
    assert rec["abstract_original"] == "We argue"
    assert rec["abstract_source"] == "openalex"
    assert rec["lang"] == "en"
    assert rec["pub_date_online"] == "2026-08-15"
    assert rec["pub_date_issue"] == "2026-09"
    assert rec["authors"] == ["A. Author", "B. Author"]
    assert rec["relevance"] is None  # 待 classify 填充


def test_build_record_falls_back_to_crossref_abstract():
    rec = build_record(CROSSREF_ITEM, None, first_seen="2026-08-15")
    assert rec["abstract_original"] == "We argue that mens rea matters."
    assert rec["abstract_source"] == "crossref"
    assert rec["lang"] in ("en", "other")


def test_build_record_skips_no_title():
    item = dict(CROSSREF_ITEM, title=[])
    assert build_record(item, None, first_seen="x") is None


def test_filter_new():
    recs = [{"doi": "10.a/b"}, {"doi": "10.c/d"}]
    assert filter_new(recs, {"10.a/b"}) == [{"doi": "10.c/d"}]
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: 新增 5 个 FAIL

- [ ] **Step 3: 实现（追加到 normalize.py）**

```python
from langdetect import DetectorFactory, detect

DetectorFactory.seed = 0  # 结果确定性

_KNOWN_LANGS = {"en", "de", "fr", "es"}


def detect_lang(title, abstract):
    """语言检测：en/de/fr/es，其余或失败归为 'other'。"""
    text = (title or "") + " " + (abstract or "")
    if not text.strip():
        return "other"
    try:
        lang = detect(text)
    except Exception:
        return "other"
    return lang if lang in _KNOWN_LANGS else "other"


def _authors(item):
    out = []
    for a in item.get("author") or []:
        if a.get("family"):
            out.append(f"{a.get('given', '').strip()} {a['family']}".strip())
        elif a.get("name"):
            out.append(a["name"])
    return out


def build_record(item, enrich, first_seen):
    """Crossref work + OpenAlex 补全 → 统一记录；标题缺失返回 None。

    enrich 为 OpenAlex work 字典或 None。
    """
    doi = clean_doi(item.get("DOI"))
    titles = item.get("title") or []
    title = titles[0].strip() if titles else ""
    if not doi or not title:
        return None
    enrich = enrich or {}

    abstract_oa = rebuild_abstract(enrich.get("abstract_inverted_index"))
    abstract_cr = strip_jats(item.get("abstract"))
    if abstract_oa:
        abstract_original, abstract_source = abstract_oa, "openalex"
    elif abstract_cr:
        abstract_original, abstract_source = abstract_cr, "crossref"
    else:
        abstract_original, abstract_source = None, "none"

    container = item.get("container-title") or [""]
    return {
        "doi": doi,
        "title_original": title,
        "title_zh": None,           # classify 填充
        "authors": _authors(item),
        "journal_name": container[0],
        "journal_issn_l": (item.get("ISSN") or [""])[0],
        "pub_date_online": parse_date(item.get("published-online") or item.get("issued")),
        "pub_date_issue": parse_date(item.get("published-print")),
        "first_seen_at": first_seen,
        "abstract_original": abstract_original,
        "abstract_source": abstract_source,
        "lang": enrich.get("language") or detect_lang(title, abstract_original),
        "relevance": None,          # classify 填充
        "subfield": None,           # classify 填充
        "tldr_zh": None,            # classify 填充
        "inclusion_reason_zh": None,  # classify 填充
        "llm_model": None,
        "generated_at": None,
    }


def filter_new(records, seen):
    """过滤掉已在 seen 集合中的 DOI。"""
    return [r for r in records if r["doi"] not in seen]
```

注意：`from langdetect import ...` 放在文件顶部 import 区（与其他 import 合并，实现时放在 `import re` 之后即可）。

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_normalize.py -v`
Expected: 11 passed

- [ ] **Step 5: 提交**

```powershell
git add app/normalize.py tests/test_normalize.py
git commit -m "feat(digest): 记录组装（Crossref+OpenAlex 合并）、语言检测与去重过滤"
```

---

### Task 5: fetch — Crossref 发现 + OpenAlex 批量补全

**Files:**
- Create: `cl-digest/app/fetch.py`
- Test: `cl-digest/tests/test_fetch.py`

- [ ] **Step 1: 写失败测试**

```python
"""fetch HTTP 层测试（responses mock）。"""
import responses

from app import fetch


@responses.activate
def test_fetch_crossref_paginates_with_cursor():
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/1"}], "next-cursor": "CUR2"}},
    )
    responses.get(
        "https://api.crossref.org/works",
        json={"message": {"items": [{"DOI": "10.a/2"}], "next-cursor": None}},
    )
    items = fetch.fetch_crossref(["0000-0000"], since="2026-08-01")
    assert [i["DOI"] for i in items] == ["10.a/1", "10.a/2"]
    # 过滤条件组装正确
    req = responses.calls[0].request
    assert "from-created-date:2026-08-01" in req.url
    assert "type:journal-article" in req.url
    assert "0000-0000" in req.url


@responses.activate
def test_fetch_openalex_chunks_and_keys_by_doi():
    responses.get(
        "https://api.openalex.org/works",
        json={"results": [{"doi": "https://doi.org/10.a/1", "language": "en"}]},
    )
    out = fetch.fetch_openalex(["10.a/1"])
    assert out["10.a/1"]["language"] == "en"


@responses.activate
def test_get_json_retries_on_500():
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", status=500)
    responses.get("https://api.crossref.org/journals/x", json={"ok": True})
    assert fetch._get_json("https://api.crossref.org/journals/x", {}) == {"ok": True}
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_fetch.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 fetch.py**

```python
"""HTTP 抓取层：Crossref 发现 + OpenAlex 补全。带重试与礼貌池 mailto。"""
import time

import requests

from . import config
from .normalize import clean_doi


def _get_json(url, params, tries=3, timeout=30):
    """GET JSON，指数退避重试。"""
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if i == tries - 1:
                raise
            time.sleep(2**i)


def fetch_crossref(issns, since, until=None):
    """按 ISSN 集合 + from-created-date 拉取新 DOI，游标分页，返回 message.items 列表。

    注：Crossref 中综述与论文同为 type=journal-article，无需额外 type 区分。
    """
    flt = f"issn:{'|'.join(issns)},from-created-date:{since},type:journal-article"
    if until:
        flt += f",until-created-date:{until}"
    items, cursor = [], "*"
    while True:
        js = _get_json(
            "https://api.crossref.org/works",
            {"filter": flt, "rows": 200, "cursor": cursor, "mailto": config.MAILTO},
        )
        msg = js.get("message", {})
        batch = msg.get("items", [])
        items.extend(batch)
        cursor = msg.get("next-cursor")
        if not cursor or not batch:
            return items


def fetch_openalex(dois):
    """按 DOI 批量取 OpenAlex work（25 个/次），返回 {规范doi: work}。缺失 DOI 不在结果中。"""
    out = {}
    for i in range(0, len(dois), 25):
        chunk = [d for d in dois[i : i + 25]]
        js = _get_json(
            "https://api.openalex.org/works",
            {
                "filter": "doi:" + "|".join(chunk),
                "select": "doi,language,authorships,primary_location,abstract_inverted_index",
                "per-page": 50,
                "mailto": config.MAILTO,
            },
        )
        for w in js.get("results", []):
            doi = clean_doi(w.get("doi"))
            if doi:
                out[doi] = w
    return out
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_fetch.py -v`
Expected: 3 passed

- [ ] **Step 5: 真实 API 冒烟（一次性，验证过滤语法有效）**

Run: `python -c "from app.fetch import fetch_crossref; from app import config; import csv; issns=[r['print_issn'] for r in csv.DictReader(open(config.JOURNALS_CSV, encoding='utf-8'))]; items=fetch_crossref(issns[:5], '2026-07-01'); print(len(items), items[0]['DOI'] if items else '')"`
Expected: 输出条数 > 0（近一个多月必有新论文）；若 0，检查过滤语法与日期。

- [ ] **Step 6: 提交**

```powershell
git add app/fetch.py tests/test_fetch.py
git commit -m "feat(digest): Crossref 游标分页发现与 OpenAlex 批量补全"
```

---

### Task 6: classify — LLM 分诊 + 校验 + 降级

**Files:**
- Create: `cl-digest/app/classify.py`
- Test: `cl-digest/tests/test_classify.py`

- [ ] **Step 1: 写失败测试**

```python
"""classify 测试：FakeClient 替代真实 LLM。"""
import pytest

from app.classify import ClassifyError, LLMClient, classify_or_degrade, parse_analysis

GOOD = ('{"relevance":"core","subfield":"criminal_law_core",'
        '"title_zh":"机器人刑事责任","tldr_zh":"本文主张归责应立足规范论。",'
        '"inclusion_reason_zh":"摘要明确讨论刑事责任归属"}')


class FakeClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def chat(self, system, user):
        self.calls += 1
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def test_parse_analysis_strips_code_fence():
    assert parse_analysis("```json\n" + GOOD + "\n```")["relevance"] == "core"


def test_parse_analysis_rejects_bad_payload():
    with pytest.raises(ClassifyError):
        parse_analysis('{"relevance":"nope","subfield":"criminal_law_core",'
                       '"title_zh":"a","tldr_zh":"b","inclusion_reason_zh":"c"}')
    with pytest.raises(ClassifyError):
        parse_analysis("不是 JSON")


def test_classify_or_degrade_success_first_try():
    client = FakeClient([GOOD])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client, "test-model")
    assert degraded is False and analysis["relevance"] == "core"
    assert client.calls == 1


def test_classify_or_degrade_retries_once_then_degrades():
    client = FakeClient([ClassifyError("boom"), ClassifyError("boom")])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client, "test-model")
    assert degraded is True
    assert analysis["relevance"] == "borderline"
    assert analysis["tldr_zh"] is None
    assert client.calls == 2
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_classify.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 classify.py**

```python
"""LLM 分诊：相关性三档 + 子领域 + 中文标题/导读/收录理由。失败重试一次后降级。"""
import json
import re

import requests

from . import config

FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class ClassifyError(Exception):
    """LLM 输出无法解析或校验失败。"""


SYSTEM_PROMPT = """你是刑法学术文献分诊员。输入一篇论文的标题与摘要（可能为英/德/法/西语）及分诊词表，
只输出严格 JSON（无其他文字、无代码围栏）：
{"relevance":"core|related|borderline",
 "subfield":"criminal_law_core|criminal_procedure|international_criminal_law|criminology|penology|interdisciplinary",
 "title_zh":"中文参考标题","tldr_zh":"一句话中文导读(不超过100字)","inclusion_reason_zh":"一句话收录理由"}
判定规则：
1. relevance：core=以刑事实体法/刑事责任/刑罚的教义或理论为主要研究对象；related=刑事诉讼、
   国际刑法、刑罚学、犯罪学交叉且对刑法研究有参考价值；borderline=按词表所列边界情形，需人工判断。
2. tldr_zh 与 inclusion_reason_zh 只能复述标题与摘要中已有信息，禁止推断作者未陈述的结论、
   数据、样本、法域；无摘要时仅基于标题并保持极简。
3. title_zh 为参考翻译，术语遵从刑法学通行译法。"""


class LLMClient:
    """OpenAI 兼容 chat/completions 薄封装。temperature=0 + json_object 输出模式。"""

    def __init__(self, base_url=None, api_key=None, model=None):
        self.base_url = (base_url or config.LLM_BASE_URL).rstrip("/")
        self.api_key = api_key or config.LLM_API_KEY
        self.model = model or config.LLM_MODEL

    def chat(self, system, user):
        r = requests.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=120,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


def parse_analysis(raw):
    """解析并校验 LLM 输出；非法抛 ClassifyError。"""
    try:
        data = json.loads(FENCE_RE.sub("", (raw or "").strip()))
    except (json.JSONDecodeError, TypeError):
        raise ClassifyError(f"无法解析 LLM 输出: {raw!r:.200}")
    if data.get("relevance") not in config.RELEVANCE_TIERS:
        raise ClassifyError(f"relevance 非法: {data.get('relevance')}")
    if data.get("subfield") not in config.SUBFIELDS:
        raise ClassifyError(f"subfield 非法: {data.get('subfield')}")
    for key in ("title_zh", "tldr_zh", "inclusion_reason_zh"):
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ClassifyError(f"{key} 缺失或为空")
    if len(data["tldr_zh"]) > 120:
        raise ClassifyError("tldr_zh 超长")
    return data


def _user_message(title, abstract, lexicon):
    return f"标题: {title}\n摘要: {abstract or '（无摘要）'}\n\n词表:\n{lexicon}"


def classify_paper(title, abstract, lexicon, client):
    """单次分诊；失败抛 ClassifyError。"""
    return parse_analysis(client.chat(SYSTEM_PROMPT, _user_message(title, abstract, lexicon)))


def classify_or_degrade(title, abstract, lexicon, client, model_name):
    """分诊（重试 1 次）；两次失败降级为 borderline 待人工。返回 (analysis, degraded)。"""
    for _ in range(2):
        try:
            return classify_paper(title, abstract, lexicon, client), False
        except (ClassifyError, requests.RequestException):
            continue
    return {
        "relevance": "borderline",
        "subfield": "interdisciplinary",
        "title_zh": None,
        "tldr_zh": None,
        "inclusion_reason_zh": "LLM 分诊失败，待人工处理",
    }, True
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_classify.py -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```powershell
git add app/classify.py tests/test_classify.py
git commit -m "feat(digest): LLM 分诊、JSON 校验与失败降级"
```

---

### Task 7: render — 模板、静态资产、日页/首页/归档/RSS

**Files:**
- Create: `cl-digest/app/templates/base.html`
- Create: `cl-digest/app/templates/index.html`
- Create: `cl-digest/app/templates/day.html`
- Create: `cl-digest/app/templates/archive.html`
- Create: `cl-digest/static/style.css`
- Create: `cl-digest/static/fuse.min.js`（vendored）
- Create: `cl-digest/app/render.py`
- Test: `cl-digest/tests/test_render.py`

- [ ] **Step 1: 下载 fuse.js 到 static/**

```powershell
curl -L https://cdn.jsdelivr.net/npm/fuse.js@7.1.0/dist/fuse.min.js -o static/fuse.min.js
```

Expected: `static/fuse.min.js` 约 20KB。若无外网，从 https://cdn.jsdelivr.net/npm/fuse.js@7.1.0/dist/fuse.min.js 浏览器另存。

- [ ] **Step 2: 写模板 base.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{% block title %}SSCI 刑法论文每日雷达{% endblock %}</title>
<link rel="stylesheet" href="{{ base }}assets/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="{{ base }}index.html">SSCI 刑法论文每日雷达</a>
  <nav>
    <a href="{{ base }}index.html">今日</a>
    <a href="{{ base }}archive.html">归档</a>
    <a href="{{ base }}feed.xml">RSS</a>
    <a href="{{ base }}../index.html">← 返回主站</a>
  </nav>
</header>
<main>
{% block content %}{% endblock %}
</main>
<footer class="footer">
  数据来源 Crossref / OpenAlex · 中文导读为 AI 生成仅供快速浏览 ·
  原始摘要以出版社页面为准 · <a href="{{ base }}../index.html">Generative Jurisprudence</a>
</footer>
</body>
</html>
```

- [ ] **Step 3: 写模板 index.html**

```html
{% extends "base.html" %}
{% block content %}
<h1>每日雷达</h1>
<p class="muted">SSCI 期刊 · 刑法语义筛选 · 每日更新。收录原则见<a href="archive.html">归档页</a>筛选器。</p>
{% for d in days %}
<section class="day-card">
  <h2><a href="day/{{ d.date }}.html">{{ d.date }}</a></h2>
  <p class="muted">重点 {{ d.core }} 篇 · 相关 {{ d.related }} 篇 · 待人工确认 {{ d.borderline }} 篇</p>
  <ul class="paper-list">
    {% for p in d.top %}
    <li>
      <span class="tag tag-{{ p.relevance }}">{{ '重点' if p.relevance == 'core' else '相关' }}</span>
      <a class="p-title" href="https://doi.org/{{ p.doi }}">{{ p.title_zh or p.title_original }}</a>
      <span class="muted">{{ p.journal_name }}</span>
      {% if p.tldr_zh %}<p class="tldr">{{ p.tldr_zh }}</p>{% endif %}
    </li>
    {% endfor %}
  </ul>
</section>
{% else %}
<p>暂无数据。流水线首次运行后将在此显示日报。</p>
{% endfor %}
{% endblock %}
```

- [ ] **Step 4: 写模板 day.html**

```html
{% extends "base.html" %}
{% block title %}{{ date }} · 每日雷达{% endblock %}
{% block content %}
<h1>{{ date }}</h1>
<p class="muted">首次监测到 {{ core | length + related | length + borderline | length }} 篇（非"今日正式发表"）。重点/core 全字段，相关/related 标题+导读，边界/borderline 折叠待人工确认。</p>

<h2>重点 <span class="muted">({{ core | length }})</span></h2>
{% for p in core %}
<article class="paper">
  <h3><a href="https://doi.org/{{ p.doi }}">{{ p.title_zh or p.title_original }}</a></h3>
  {% if p.title_zh %}<p class="orig-title">{{ p.title_original }}</p>{% endif %}
  <p class="tldr">{{ p.tldr_zh }}</p>
  <dl class="meta">
    <div><dt>作者</dt><dd>{{ p.authors | join(', ') or '—' }}</dd></div>
    <div><dt>期刊</dt><dd>{{ p.journal_name }}</dd></div>
    <div><dt>在线发表</dt><dd>{{ p.pub_date_online or '—' }}</dd></div>
    <div><dt>子领域</dt><dd>{{ p.subfield }}</dd></div>
    <div><dt>收录理由</dt><dd>{{ p.inclusion_reason_zh }}</dd></div>
  </dl>
  {% if p.abstract_original %}
  <details><summary>英文/原文摘要（来源：{{ p.abstract_source }}）</summary>
    <p class="abstract">{{ p.abstract_original }}</p>
  </details>
  {% else %}<p class="muted">摘要暂缺</p>{% endif %}
</article>
{% else %}<p>今日无重点论文。</p>{% endfor %}

<h2>相关 <span class="muted">({{ related | length }})</span></h2>
<ul class="paper-list">
  {% for p in related %}
  <li><a class="p-title" href="https://doi.org/{{ p.doi }}">{{ p.title_zh or p.title_original }}</a>
    <span class="muted">{{ p.journal_name }} · {{ p.subfield }}</span>
    {% if p.tldr_zh %}<p class="tldr">{{ p.tldr_zh }}</p>{% endif %}
  </li>
  {% endfor %}
</ul>

<details class="borderline-block">
<summary>待人工确认（{{ borderline | length }}）</summary>
<ul class="paper-list">
  {% for p in borderline %}
  <li><a class="p-title" href="https://doi.org/{{ p.doi }}">{{ p.title_zh or p.title_original }}</a>
    <span class="muted">{{ p.journal_name }} · {{ p.inclusion_reason_zh }}</span></li>
  {% endfor %}
</ul>
</details>
{% endblock %}
```

- [ ] **Step 5: 写模板 archive.html（月份数据 + fuse.js 搜索 + 筛选）**

```html
{% extends "base.html" %}
{% block content %}
<h1>归档检索</h1>
<div class="filters">
  <select id="f-month"><option value="">全部月份（跨月搜索较慢）</option></select>
  <select id="f-relevance">
    <option value="">全部相关性</option><option value="core">重点</option>
    <option value="related">相关</option><option value="borderline">待确认</option>
  </select>
  <select id="f-subfield"><option value="">全部子领域</option></select>
  <input id="f-search" type="search" placeholder="搜索标题 / 期刊 / 导读…">
</div>
<ul class="paper-list" id="results"></ul>
<p class="muted" id="count"></p>
<script src="assets/fuse.min.js"></script>
<script>
window.PAPERS_MANIFEST = {{ months | tojson }};
const SUBFIELDS = {{ subfields | tojson }};
const cache = {};
const elM = document.getElementById('f-month'), elR = document.getElementById('f-relevance'),
      elS = document.getElementById('f-subfield'), elQ = document.getElementById('f-search'),
      elOut = document.getElementById('results'), elCnt = document.getElementById('count');
for (const m of window.PAPERS_MANIFEST) elM.add(new Option(m, m));
for (const s of SUBFIELDS) elS.add(new Option(s, s));

async function loadMonth(m) {
  if (!m) {  // 全部月份：按月文件顺序合并
    let all = [];
    for (const mo of window.PAPERS_MANIFEST) all = all.concat(await loadMonth(mo));
    return all;
  }
  if (cache[m]) return cache[m];
  await new Promise((ok, err) => {
    const s = document.createElement('script');
    s.src = `assets/data/papers-${m}.js`; s.onload = ok; s.onerror = err;
    document.head.appendChild(s);
  });
  cache[m] = window['PAPERS_' + m.replace(/-/g, '_')];
  return cache[m];
}

function apply() {
  loadMonth(elM.value).then(list => {
    let out = list.filter(p => (!elR.value || p.relevance === elR.value)
                            && (!elS.value || p.subfield === elS.value));
    const q = elQ.value.trim();
    if (q) out = new Fuse(out, { keys: ['t', 'j', 'tl'], threshold: 0.35 }).search(q).map(r => r.item);
    elCnt.textContent = `${out.length} 篇`;
    elOut.innerHTML = out.map(p =>
      `<li><span class="tag tag-${p.relevance}">${p.relevance}</span>` +
      `<a class="p-title" href="https://doi.org/${p.doi}">${p.t}</a>` +
      `<span class="muted">${p.j} · ${p.subfield} · ${p.d}</span>` +
      (p.tl ? `<p class="tldr">${p.tl}</p>` : '') + `</li>`).join('');
  });
}
[elM, elR, elS].forEach(el => el.addEventListener('change', apply));
elQ.addEventListener('input', apply);
apply();
</script>
{% endblock %}
```

- [ ] **Step 6: 写 static/style.css**

```css
/* 轻学术风：浅底 + 靛/琥珀点缀，JetBrains Mono 元信息 */
:root { --ink:#1f2937; --muted:#6b7280; --brand:#3730a3; --brand-soft:#eef2ff;
        --amber:#b45309; --amber-soft:#fffbeb; --border:#e5e7eb; }
* { box-sizing: border-box; }
body { margin:0; color:var(--ink); background:#fafaf9;
       font-family:"Source Han Serif SC","Noto Serif SC",Georgia,serif; line-height:1.7; }
.topbar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;
          padding:14px 24px; background:#fff; border-bottom:1px solid var(--border); }
.brand { font-weight:700; color:var(--brand); text-decoration:none; font-size:18px; }
.topbar nav a { margin-left:16px; color:var(--ink); text-decoration:none; font-size:14px; }
.topbar nav a:hover { color:var(--brand); }
main { max-width:860px; margin:0 auto; padding:28px 20px 64px; }
h1 { font-size:26px; } h2 { font-size:19px; margin-top:36px; }
.muted { color:var(--muted); font-size:13px; }
.day-card { border:1px solid var(--border); border-radius:12px; padding:16px 20px; margin:16px 0;
            background:#fff; }
.paper-list { list-style:none; padding:0; margin:8px 0; }
.paper-list li { padding:10px 0; border-bottom:1px dashed var(--border); }
.p-title { color:var(--ink); font-weight:600; text-decoration:none; }
.p-title:hover { color:var(--brand); }
.tldr { margin:4px 0 0; font-size:14px; }
.paper { border:1px solid var(--border); border-left:3px solid var(--brand); border-radius:10px;
         padding:16px 20px; margin:14px 0; background:#fff; }
.paper h3 { margin:0 0 4px; font-size:17px; }
.paper h3 a { color:var(--ink); text-decoration:none; }
.orig-title { margin:0 0 8px; font-size:13px; color:var(--muted); font-style:italic; }
.meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:4px 16px;
        margin:10px 0; font-size:13px; }
.meta div { display:flex; gap:8px; }
.meta dt { color:var(--muted); white-space:nowrap; } .meta dd { margin:0; }
.abstract { font-size:14px; background:var(--brand-soft); border-radius:8px; padding:12px; }
.tag { display:inline-block; font:600 11px/1.6 "JetBrains Mono",ui-monospace,monospace;
       padding:0 8px; border-radius:999px; margin-right:8px; vertical-align:1px; }
.tag-core { background:var(--amber-soft); color:var(--amber); border:1px solid #fcd34d; }
.tag-related { background:var(--brand-soft); color:var(--brand); border:1px solid #c7d2fe; }
.tag-borderline { background:#f3f4f6; color:var(--muted); border:1px solid var(--border); }
.borderline-block { margin-top:28px; }
.filters { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
.filters select,.filters input { padding:6px 10px; border:1px solid var(--border); border-radius:8px;
                                 background:#fff; font-size:14px; }
.footer { border-top:1px solid var(--border); color:var(--muted); font-size:12px;
          text-align:center; padding:18px; background:#fff; }
details summary { cursor:pointer; color:var(--brand); font-size:14px; }
```

- [ ] **Step 7: 写失败测试 tests/test_render.py**

```python
"""render 冒烟测试：产物存在、内容包含关键信息、RSS 可解析。"""
import xml.etree.ElementTree as ET
from pathlib import Path

from app.render import load_papers, render_site

PAPERS = [
    {"doi": "10.a/1", "title_original": "Criminal Liability", "title_zh": "刑事责任",
     "authors": ["A. B"], "journal_name": "J1", "journal_issn_l": "0000-0000",
     "pub_date_online": "2026-08-10", "pub_date_issue": None, "first_seen_at": "2026-08-15",
     "abstract_original": "abs text", "abstract_source": "openalex", "lang": "en",
     "relevance": "core", "subfield": "criminal_law_core", "tldr_zh": "导读一",
     "inclusion_reason_zh": "理由一", "llm_model": "m", "generated_at": "t"},
    {"doi": "10.a/2", "title_original": "Policing Study", "title_zh": "警务研究",
     "authors": [], "journal_name": "J2", "journal_issn_l": "0000-0001",
     "pub_date_online": None, "pub_date_issue": None, "first_seen_at": "2026-08-15",
     "abstract_original": None, "abstract_source": "none", "lang": "en",
     "relevance": "borderline", "subfield": "criminology", "tldr_zh": None,
     "inclusion_reason_zh": "LLM 分诊失败，待人工处理", "llm_model": "m", "generated_at": "t"},
]


def test_render_site_products(tmp_path):
    render_site(PAPERS, site_dir=tmp_path)
    day = (tmp_path / "day" / "2026-08-15.html").read_text(encoding="utf-8")
    assert "刑事责任" in day and "待人工确认" in day and "摘要暂缺" in day
    idx = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert "2026-08-15" in idx
    data_js = (tmp_path / "assets" / "data" / "papers-2026-08.js").read_text(encoding="utf-8")
    assert "window.PAPERS_2026_08" in data_js
    ET.parse(tmp_path / "feed.xml")  # RSS 为合法 XML
    assert (tmp_path / "assets" / "fuse.min.js").exists()
    assert (tmp_path / "archive.html").read_text(encoding="utf-8").count("f-month")


def test_load_papers_reads_monthly_files(tmp_path):
    (tmp_path / "papers-2026-08.jsonl").write_text(
        "\n".join(__import__("json").dumps(p) for p in PAPERS) + "\n", encoding="utf-8")
    papers = load_papers(data_dir=tmp_path)
    assert len(papers) == 2
```

- [ ] **Step 8: 运行确认失败**

Run: `python -m pytest tests/test_render.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 9: 实现 render.py**

```python
"""渲染层：全量重建 digest/ 静态站点（日页/首页/归档/RSS/月度数据）。"""
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from feedgen.feed import FeedGenerator
from jinja2 import Environment, FileSystemLoader

from . import config

_LEAN_KEYS = ("doi", "relevance", "subfield", "journal_name", "first_seen_at",
              "title_zh", "title_original", "tldr_zh")


def load_papers(data_dir=config.DATA_DIR):
    """读取全部 papers-*.jsonl，按 first_seen_at 降序。"""
    papers = []
    for f in sorted(Path(data_dir).glob("papers-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                papers.append(json.loads(line))
    papers.sort(key=lambda p: (p.get("first_seen_at") or "", p.get("doi")), reverse=True)
    return papers


def _month(p):
    return (p.get("first_seen_at") or "")[:7]


def _lean(p):
    """归档页数据精简字段：t=标题 j=期刊 tl=导读 d=日期。"""
    return {"doi": p["doi"], "relevance": p["relevance"], "subfield": p["subfield"],
            "j": p["journal_name"], "d": p["first_seen_at"],
            "t": p.get("title_zh") or p["title_original"], "tl": p.get("tldr_zh")}


def _write_feed(papers, site_dir):
    fg = FeedGenerator()
    fg.title("SSCI 刑法论文每日雷达")
    site = config.SITE_URL or "https://github.com/Riddle7/xingge-test"
    fg.id(site)
    fg.link(href=site, rel="alternate")
    fg.subtitle("SSCI 期刊 · 刑法语义筛选 · 每日更新")
    for p in [x for x in papers if x["relevance"] in ("core", "related")][:30]:
        fe = fg.add_entry()
        fe.id(f"https://doi.org/{p['doi']}")
        fe.title(p.get("title_zh") or p["title_original"])
        fe.link(href=f"https://doi.org/{p['doi']}")
        fe.description(p.get("tldr_zh") or "")
        d = p.get("first_seen_at") or "1970-01-01"
        fe.pubDate(datetime.fromisoformat(d).replace(tzinfo=timezone.utc))
    fg.rss_file(str(site_dir / "feed.xml"))


def render_site(papers, site_dir=config.SITE_DIR):
    """全量重建站点目录（无关记录不展示）。"""
    site_dir = Path(site_dir)
    visible = [p for p in papers if p.get("relevance") not in (None, "irrelevant")]
    env = Environment(loader=FileSystemLoader(config.TEMPLATES_DIR), autoescape=True)

    # 静态资产
    (site_dir / "assets" / "data").mkdir(parents=True, exist_ok=True)
    for f in config.STATIC_DIR.iterdir():
        shutil.copy(f, site_dir / "assets" / f.name)

    # 月度数据 JS（供归档页按需加载）
    months = sorted({_month(p) for p in visible}, reverse=True)
    for m in months:
        rows = [_lean(p) for p in visible if _month(p) == m]
        js = f"window.PAPERS_{m.replace('-', '_')} = {json.dumps(rows, ensure_ascii=False)};"
        (site_dir / "assets" / "data" / f"papers-{m}.js").write_text(js, encoding="utf-8")

    # 日页
    (site_dir / "day").mkdir(parents=True, exist_ok=True)
    day_tpl = env.get_template("day.html")
    for d in sorted({p["first_seen_at"] for p in visible}, reverse=True):
        ps = [p for p in visible if p["first_seen_at"] == d]
        (site_dir / "day" / f"{d}.html").write_text(day_tpl.render(
            date=d,
            core=[p for p in ps if p["relevance"] == "core"],
            related=[p for p in ps if p["relevance"] == "related"],
            borderline=[p for p in ps if p["relevance"] == "borderline"],
        ), encoding="utf-8")

    # 首页：最近 7 个日期，每天最多列 5 条 core+related
    days = []
    for d in sorted({p["first_seen_at"] for p in visible}, reverse=True)[:7]:
        ps = [p for p in visible if p["first_seen_at"] == d]
        days.append({"date": d,
                     "core": sum(1 for p in ps if p["relevance"] == "core"),
                     "related": sum(1 for p in ps if p["relevance"] == "related"),
                     "borderline": sum(1 for p in ps if p["relevance"] == "borderline"),
                     "top": [p for p in ps if p["relevance"] in ("core", "related")][:5]})
    (site_dir / "index.html").write_text(
        env.get_template("index.html").render(days=days), encoding="utf-8")

    # 归档页
    (site_dir / "archive.html").write_text(env.get_template("archive.html").render(
        months=months, subfields=list(config.SUBFIELDS)), encoding="utf-8")

    _write_feed(visible, site_dir)
```

- [ ] **Step 10: 运行确认通过**

Run: `python -m pytest tests/test_render.py -v`
Expected: 2 passed

- [ ] **Step 11: 提交**

```powershell
git add app/render.py app/templates static tests/test_render.py
git commit -m "feat(digest): 静态站点渲染（日页/首页/归档fuse.js搜索/RSS）"
```

---

### Task 8: daily — 编排、防重、零结果告警、原子提交

**Files:**
- Create: `cl-digest/app/daily.py`
- Test: `cl-digest/tests/test_daily.py`

- [ ] **Step 1: 写失败测试**

```python
"""daily 编排测试：fake fetch/classify，tmp 目录，不 commit。"""
import json

import app.daily as daily
from app import config


def _fake_fetch(monkeypatch):
    item = {"DOI": "10.a/1", "title": ["T"], "author": [], "container-title": ["J"],
            "ISSN": ["0000-0000"], "issued": {"date-parts": [[2026, 8, 15]]}}
    monkeypatch.setattr(daily, "fetch_crossref", lambda issns, since, until=None: [item])
    monkeypatch.setattr(daily, "fetch_openalex", lambda dois: {})


def _fake_classify(monkeypatch):
    def fake(title, abstract, lexicon, client, model):
        return {"relevance": "core", "subfield": "criminal_law_core", "title_zh": "中题",
                "tldr_zh": "导读", "inclusion_reason_zh": "理由"}, False
    monkeypatch.setattr(daily, "classify_or_degrade", fake)


def test_run_end_to_end(tmp_path, monkeypatch):
    _fake_fetch(monkeypatch)
    _fake_classify(monkeypatch)
    daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    papers = json.loads((tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert papers["relevance"] == "core" and papers["title_zh"] == "中题"
    seen = (tmp_path / "seen.jsonl").read_text(encoding="utf-8").splitlines()
    assert "10.a/1" in seen
    assert (tmp_path / "site" / "day" / "2026-08-15.html").exists()
    assert (tmp_path / "review-queue" / "2026-08-15.md").exists()  # 空队列也留痕


def test_run_dedups_seen(tmp_path, monkeypatch):
    _fake_fetch(monkeypatch)
    _fake_classify(monkeypatch)
    daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    daily.run(lookback_days=14, today="2026-08-16", do_commit=False,
              data_dir=tmp_path, site_dir=tmp_path / "site")
    lines = (tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1  # 第二次运行无新增


def test_run_zero_results_alarm(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "fetch_crossref", lambda issns, since, until=None: [])
    monkeypatch.setattr(daily, "fetch_openalex", lambda dois: {})
    try:
        daily.run(lookback_days=14, today="2026-08-15", do_commit=False,
                  data_dir=tmp_path, site_dir=tmp_path / "s")
    except RuntimeError as e:
        assert "零结果" in str(e)
    else:
        raise AssertionError("应触发零结果告警")
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_daily.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 daily.py**

```python
"""每日编排：发现→补全→规范化→分诊→入库→渲染→审核队列→原子提交。"""
import argparse
import csv
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config
from .classify import classify_or_degrade
from .fetch import fetch_crossref, fetch_openalex
from .normalize import build_record, filter_new
from .render import load_papers, render_site

TZ = ZoneInfo("Asia/Shanghai")


def load_journals(path=config.JOURNALS_CSV):
    """读白名单，返回 (rows, 用于过滤的 ISSN 列表=印刷+电子并集)。"""
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    issns = {r["print_issn"] for r in rows if r["print_issn"]}
    issns |= {r["online_issn"] for r in rows if r["online_issn"]}
    return rows, sorted(issns)


def load_seen(data_dir):
    p = Path(data_dir) / "seen.jsonl"
    if not p.exists():
        return set()
    return {l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip()}


def append_line(path, line):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def write_review_queue(today, papers, data_dir):
    """当日 borderline/降级论文写入人工审核 markdown（GitHub Web UI 可直接裁决）。"""
    pend = [p for p in papers
            if p["first_seen_at"] == today and p["relevance"] == "borderline"]
    lines = [f"# 待人工确认 · {today}", "",
             "逐条点击 DOI 判断，裁决命令：", "```",
             "python -m app.resolve <doi> core|related|irrelevant [--subfield ...] [--note ...]",
             "```", ""]
    for p in pend:
        lines += [f"## {p.get('title_zh') or p['title_original']}",
                  f"- DOI: https://doi.org/{p['doi']}",
                  f"- 原标题: {p['title_original']}",
                  f"- 期刊: {p['journal_name']} · 语言: {p['lang']}",
                  f"- 收录理由: {p['inclusion_reason_zh']}",
                  f"- 摘要: {(p['abstract_original'] or '（暂缺）')[:400]}", ""]
    out = Path(data_dir) / "review-queue" / f"{today}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")


def git_commit(paths, message, push=False):
    """原子提交：所有路径 add 后一次 commit；push 供 CI 使用。"""
    subprocess.run(["git", "add", *paths], check=True, cwd=config.REPO_ROOT)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=config.REPO_ROOT).returncode
    if diff != 0:
        subprocess.run(["git", "-c", "user.name=cl-digest-bot",
                        "-c", "user.email=cl-digest-bot@users.noreply.github.com",
                        "commit", "-m", message], check=True, cwd=config.REPO_ROOT)
        if push:
            subprocess.run(["git", "push"], check=True, cwd=config.REPO_ROOT)


def run(lookback_days=14, today=None, do_classify=True, do_commit=True, push=False,
        data_dir=config.DATA_DIR, site_dir=config.SITE_DIR):
    today = today or datetime.now(TZ).date().isoformat()
    data_dir, site_dir = Path(data_dir), Path(site_dir)
    since = (datetime.fromisoformat(today) - timedelta(days=lookback_days)).date().isoformat()

    _, issns = load_journals()
    items = fetch_crossref(issns, since=since)
    if not items:
        raise RuntimeError(f"零结果告警：Crossref 返回 0 条（白名单 {len(issns)} 个 ISSN，"
                           f"since={since}）。流水线疑似故障，请检查 API 与过滤条件。")

    enrich = fetch_openalex([i["DOI"] for i in items if i.get("DOI")])
    records = []
    for it in items:
        rec = build_record(it, enrich.get((it.get("DOI") or "").lower()), first_seen=today)
        if rec:
            records.append(rec)

    new = filter_new(records, load_seen(data_dir))
    print(f"发现 {len(items)} 条 · 规范化 {len(records)} 条 · 新增 {len(new)} 条")

    if do_classify and new:
        lexicon = (data_dir / "lexicon.md").read_text(encoding="utf-8")
        from .classify import LLMClient  # 延迟导入便于测试注入
        client = LLMClient()
        for rec in new:
            analysis, degraded = classify_or_degrade(
                rec["title_original"], rec["abstract_original"], lexicon, client,
                client.model)
            rec.update(analysis)
            rec["llm_model"] = "none" if degraded else client.model
            rec["generated_at"] = datetime.now(TZ).isoformat(timespec="seconds")
    elif new:  # --no-classify 调试模式：全部置空待下轮补
        for rec in new:
            rec.update({"relevance": "borderline", "subfield": "interdisciplinary",
                        "title_zh": None, "tldr_zh": None,
                        "inclusion_reason_zh": "跳过分诊（调试模式）"})

    for rec in new:
        line = json.dumps(rec, ensure_ascii=False)
        append_line(data_dir / f"papers-{today[:7]}.jsonl", line)
        append_line(data_dir / "seen.jsonl", rec["doi"])

    papers = load_papers(data_dir)
    render_site(papers, site_dir=site_dir)
    write_review_queue(today, papers, data_dir)

    if do_commit:
        git_commit([str(data_dir), str(site_dir)],
                   f"digest(cl): {today} 日报（新增 {len(new)} 篇）", push=push)
    print(f"完成：{today} 新增 {len(new)} 篇")


def main():
    ap = argparse.ArgumentParser(description="SSCI 刑法论文每日雷达")
    ap.add_argument("--lookback", type=int, default=14)
    ap.add_argument("--today", default=None, help="覆盖运行日期（YYYY-MM-DD，测试用）")
    ap.add_argument("--no-classify", action="store_true", help="跳过 LLM 分诊（调试）")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--push", action="store_true", help="commit 后 push（CI 用）")
    args = ap.parse_args()
    run(lookback_days=args.lookback, today=args.today, do_classify=not args.no_classify,
        do_commit=not args.no_commit, push=args.push)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/ -v`
Expected: 全部通过（此前所有任务的测试 + 本任务 3 个）

- [ ] **Step 5: 提交**

```powershell
git add app/daily.py tests/test_daily.py
git commit -m "feat(digest): 每日编排、seen 防重、零结果告警与原子提交"
```

---

### Task 9: resolve — 边界论文人工裁决

**Files:**
- Create: `cl-digest/app/resolve.py`
- Test: `cl-digest/tests/test_resolve.py`

- [ ] **Step 1: 写失败测试**

```python
"""resolve 测试：更新记录并重渲染。"""
import json

from app.resolve import update_paper


def _write(tmp_path):
    rec = {"doi": "10.a/1", "title_original": "T", "relevance": "borderline",
           "subfield": "criminology", "first_seen_at": "2026-08-15"}
    (tmp_path / "papers-2026-08.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    return rec


def test_update_paper_promotes_to_core(tmp_path):
    _write(tmp_path)
    update_paper("10.a/1", "core", subfield="criminal_law_core",
                 note="摘要实为教义学讨论", data_dir=tmp_path, site_dir=tmp_path / "site")
    line = (tmp_path / "papers-2026-08.jsonl").read_text(encoding="utf-8").splitlines()[0]
    rec = json.loads(line)
    assert rec["relevance"] == "core" and rec["subfield"] == "criminal_law_core"
    assert rec["inclusion_reason_zh"] == "摘要实为教义学讨论"


def test_update_paper_missing_doi(tmp_path):
    _write(tmp_path)
    try:
        update_paper("10.z/9", "core", data_dir=tmp_path, site_dir=tmp_path / "site")
    except SystemExit:
        pass
    else:
        raise AssertionError("应报错退出")
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_resolve.py -v`
Expected: FAIL

- [ ] **Step 3: 实现 resolve.py**

```python
"""人工裁决：python -m app.resolve <doi> core|related|irrelevant [--subfield S] [--note N]"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config
from .render import load_papers, render_site

TZ = ZoneInfo("Asia/Shanghai")


def update_paper(doi, relevance, subfield=None, note=None,
                 data_dir=config.DATA_DIR, site_dir=config.SITE_DIR):
    """在 papers-*.jsonl 中原地更新该 DOI 的裁决结果并重渲染站点。"""
    if relevance not in config.RELEVANCE_TIERS + ("irrelevant",):
        raise SystemExit(f"relevance 须为 {config.RELEVANCE_TIERS + ('irrelevant',)}")
    if subfield and subfield not in config.SUBFIELDS:
        raise SystemExit(f"subfield 须为 {config.SUBFIELDS}")
    for f in sorted(Path(data_dir).glob("papers-*.jsonl")):
        lines = f.read_text(encoding="utf-8").splitlines()
        hit = False
        for i, line in enumerate(lines):
            rec = json.loads(line)
            if rec["doi"] == doi:
                rec["relevance"] = relevance
                if subfield:
                    rec["subfield"] = subfield
                if note:
                    rec["inclusion_reason_zh"] = note
                rec["resolved_at"] = datetime.now(TZ).isoformat(timespec="seconds")
                lines[i] = json.dumps(rec, ensure_ascii=False)
                hit = True
                break
        if hit:
            f.write_text("\n".join(lines) + "\n", encoding="utf-8")
            render_site(load_papers(data_dir), site_dir=site_dir)
            print(f"已裁决 {doi} → {relevance}，站点已重渲染")
            return
    raise SystemExit(f"未找到 DOI: {doi}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("doi")
    ap.add_argument("relevance", choices=list(config.RELEVANCE_TIERS) + ["irrelevant"])
    ap.add_argument("--subfield", default=None)
    ap.add_argument("--note", default=None, help="覆盖收录理由（人工说明）")
    ap.add_argument("--no-commit", action="store_true")
    args = ap.parse_args()
    update_paper(args.doi, args.relevance, args.subfield, args.note)
    if not args.no_commit:
        from .daily import git_commit
        git_commit([str(config.DATA_DIR), str(config.SITE_DIR)],
                   f"digest(cl): 人工裁决 {args.doi} → {args.relevance}")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_resolve.py -v`
Expected: 2 passed

- [ ] **Step 5: 提交**

```powershell
git add app/resolve.py tests/test_resolve.py
git commit -m "feat(digest): 边界论文人工裁决命令"
```

---

### Task 10: eval — golden 标注与 P/R 回归

**Files:**
- Create: `cl-digest/eval/make_golden.py`
- Create: `cl-digest/eval/run_eval.py`
- Test: `cl-digest/tests/test_eval.py`

- [ ] **Step 1: 写失败测试**

```python
"""eval 测试：指标计算。"""
from eval.run_eval import compute_metrics


def test_compute_metrics_core_precision():
    preds = [
        {"doi": "1", "relevance": "core", "subfield": "criminal_law_core"},
        {"doi": "2", "relevance": "core", "subfield": "criminology"},
        {"doi": "3", "relevance": "related", "subfield": "criminology"},
    ]
    golds = [
        {"doi": "1", "relevance": "core", "subfield": "criminal_law_core"},
        {"doi": "2", "relevance": "borderline", "subfield": "criminology"},
        {"doi": "3", "relevance": "related", "subfield": "criminology"},
    ]
    m = compute_metrics(preds, golds)
    # core 预测 2，命中 1 → precision 0.5；gold core 1，命中 1 → recall 1.0
    assert m["core"]["precision"] == 0.5
    assert m["core"]["recall"] == 1.0
```

- [ ] **Step 2: 运行确认失败**

Run: `python -m pytest tests/test_eval.py -v`
Expected: FAIL

- [ ] **Step 3: 实现 eval/make_golden.py 与 eval/run_eval.py**

`eval/make_golden.py`:

```python
"""生成待标注 golden 集：python -m eval.make_golden --sample 150 [--seed 42]"""
import argparse
import json
import random
from pathlib import Path

from app.render import load_papers

EVAL_DIR = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=150)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--finalize", action="store_true",
                    help="标注完成后把 golden_todo.jsonl 定稿为 golden.jsonl")
    args = ap.parse_args()
    if args.finalize:
        todo = EVAL_DIR / "golden_todo.jsonl"
        todo.rename(EVAL_DIR / "golden.jsonl")
        print("已定稿 eval/golden.jsonl")
        return
    papers = load_papers()
    sample = random.Random(args.seed).sample(papers, min(args.sample, len(papers)))
    with open(EVAL_DIR / "golden_todo.jsonl", "w", encoding="utf-8") as f:
        for p in sample:
            f.write(json.dumps({
                "doi": p["doi"], "title_original": p["title_original"],
                "abstract_original": p["abstract_original"],
                "relevance": None,   # 人工填 core|related|borderline|irrelevant
                "subfield": None,    # 人工填（可留空）
            }, ensure_ascii=False) + "\n")
    print(f"已生成 eval/golden_todo.jsonl（{len(sample)} 条），请人工填写 relevance/subfield 后 "
          f"运行 --finalize")


if __name__ == "__main__":
    main()
```

`eval/run_eval.py`:

```python
"""golden 回归：python -m eval.run_eval [--enforce]（需 LLM_API_KEY，逐条重新分诊）。"""
import argparse
import json
import sys
from pathlib import Path

from app import config
from app.classify import LLMClient, classify_or_degrade
from app.render import load_papers

EVAL_DIR = Path(__file__).resolve().parent
GOLDEN = EVAL_DIR / "golden.jsonl"


def compute_metrics(preds, golds):
    """逐档 precision/recall：pred=X 中 gold=X 为 TP；gold 非标定档不计入该档分母。"""
    gold_by_doi = {g["doi"]: g for g in golds}
    metrics = {}
    for tier in ("core", "related", "borderline"):
        tp = sum(1 for p in preds
                 if p["relevance"] == tier and gold_by_doi[p["doi"]]["relevance"] == tier)
        pred_n = sum(1 for p in preds if p["relevance"] == tier)
        gold_n = sum(1 for g in golds if g["relevance"] == tier)
        metrics[tier] = {"precision": tp / pred_n if pred_n else None,
                         "recall": tp / gold_n if gold_n else None,
                         "pred_n": pred_n, "gold_n": gold_n}
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enforce", action="store_true",
                    help="core precision < 0.90 时以非零码退出（CI 门禁）")
    args = ap.parse_args()
    if not GOLDEN.exists():
        sys.exit("eval/golden.jsonl 不存在：先 make_golden --sample 150 并人工标注")
    golds = [json.loads(l) for l in GOLDEN.read_text(encoding="utf-8").splitlines() if l.strip()]
    papers = {p["doi"]: p for p in load_papers()}
    lexicon = (config.DATA_DIR / "lexicon.md").read_text(encoding="utf-8")
    client = LLMClient()
    preds = []
    for g in golds:
        p = papers.get(g["doi"])
        if not p:
            print(f"WARN 论文库中无 {g['doi']}，跳过")
            continue
        analysis, _ = classify_or_degrade(
            p["title_original"], p["abstract_original"], lexicon, client, client.model)
        preds.append({"doi": g["doi"], **{k: analysis[k] for k in ("relevance", "subfield")}})
    m = compute_metrics(preds, golds)
    print(json.dumps(m, ensure_ascii=False, indent=2))
    if args.enforce and (m["core"]["precision"] or 0) < 0.90:
        sys.exit("core precision < 0.90，不达标")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行确认通过**

Run: `python -m pytest tests/test_eval.py -v`
Expected: 1 passed

- [ ] **Step 5: 提交**

```powershell
git add eval/make_golden.py eval/run_eval.py tests/test_eval.py
git commit -m "feat(digest): golden 标注工具与分诊 P/R 回归评估"
```

---

### Task 11: GitHub Actions 工作流与主站入口

**Files:**
- Create: `d:\trae\.github\workflows\cl-digest-daily.yml`
- Modify: `d:\trae\index.html`（labs 区追加入口卡片）

- [ ] **Step 1: 写工作流 cl-digest-daily.yml**

```yaml
name: cl-digest daily

on:
  schedule:
    - cron: "10 0 * * *"   # 每日 UTC 00:10（北京 08:10）
    - cron: "30 0 * * 1"   # 每周一 catch-up（UTC 00:30）
  workflow_dispatch:
    inputs:
      lookback:
        description: "回看天数"
        default: "14"

permissions:
  contents: write

jobs:
  digest:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: cl-digest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - name: Run digest
        env:
          CL_DIGEST_MAILTO: ${{ secrets.CL_DIGEST_MAILTO }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          LLM_BASE_URL: ${{ secrets.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4' }}
          LLM_MODEL: ${{ secrets.LLM_MODEL || 'glm-4.6' }}
        run: |
          python -m app.daily \
            --lookback "${{ github.event_name == 'workflow_dispatch' && inputs.lookback || (github.event.schedule == '30 0 * * 1' && '30' || '14') }}" \
            --push
```

- [ ] **Step 2: 在仓库 Settings → Secrets and variables → Actions 配置**

`CL_DIGEST_MAILTO`（联系邮箱）、`LLM_API_KEY`（必填）；可选 `LLM_BASE_URL`、`LLM_MODEL`。此步为 GitHub 网页人工操作，配置后用 workflow_dispatch 手动触发一次验证。

- [ ] **Step 3: 主站入口卡片**

在 `d:\trae\index.html` 中定位 `id="lab-lawexam"` 的卡片（约 1397 行），在其 `</a>` 闭合标签之后、同一容器内插入：

```html
<a href="digest/index.html" id="lab-digest" class="lab-pixel-card scroll-reveal group relative overflow-hidden rounded-[19px] block transition-all" style="background: #0f172a; border: 1.5px solid #a5b4fc; margin-top: 20px;">
  <div class="p-8 sm:p-12">
    <p class="font-mono text-[12px] tracking-widest" style="color:#a5b4fc;">// DAILY RADAR</p>
    <h3 class="mt-3 text-2xl font-bold text-white">SSCI 刑法论文日报</h3>
    <p class="mt-3 text-[14px] leading-relaxed" style="color:#94a3b8;">
      每日自动筛选 SSCI 期刊刑法新论文 · 中文导读 · 归档检索 · RSS 订阅
    </p>
    <p class="mt-6 inline-flex items-center gap-2 font-mono text-[13px]" style="color:#f59e0b;">
      VIEW TODAY <span aria-hidden="true">→</span>
    </p>
  </div>
</a>
```

插入后浏览器打开 `index.html` 确认卡片样式与相邻 lab 卡片一致、链接可达 `digest/index.html`。

- [ ] **Step 4: 提交**

```powershell
cd d:\trae
git add .github/workflows/cl-digest-daily.yml index.html
git commit -m "feat(digest): 每日 Actions 工作流与主站日报入口卡片"
```

---

### Task 12: 端到端验收

**Files:**
- 无新文件（运行 + 人工核验 + 数据回填）

- [ ] **Step 1: 本地真实运行**

配置 `cl-digest/.env`（按 `.env.example`，填 LLM_API_KEY），然后：

```powershell
python -m app.daily --lookback 14
```

Expected: 输出"发现 N 条 · … · 新增 M 条 · 完成"；`digest/index.html`、`digest/day/*.html`、`digest/feed.xml`、`data/review-queue/*.md` 生成；本地 `python -m http.server -d d:\trae` 后浏览器验证 `http://localhost:8000/digest/` 首页、日页、归档页搜索/筛选、RSS。

- [ ] **Step 2: 检查分诊质量**

人工浏览当日全部论文的 relevance/subfield/tldr_zh；若系统性偏差，调整 `lexicon.md` 或 `SYSTEM_PROMPT` 后删除当日 `papers-*.jsonl` 与 `seen.jsonl` 对应行重跑（或次日观察）。

- [ ] **Step 3: 生成并标注 golden 集第一版**

```powershell
python -m eval.make_golden --sample 150
# 人工填写 eval/golden_todo.jsonl 每行的 relevance（core|related|borderline|irrelevant）
python -m eval.make_golden --finalize
python -m eval.run_eval --enforce
```

Expected: 输出三档 P/R；core precision ≥ 0.90（不达标则回到 Step 2 迭代）。

- [ ] **Step 4: SSCI 属性人工核验（spec 硬要求）**

访问 https://mjl.clarivate.com 逐刊搜索确认 SSCI 收录与类别；非 SSCI 的刊从 journals.csv 删除，核验过的刊回填 `verified_at=2026-08-15`（与 coverage_start 如可知）。全部核验完成后重跑 `python -m app.verify_journals` 确认 0 失败。

- [ ] **Step 5: push 上线并验证 Actions**

```powershell
git push
```

GitHub → Actions → cl-digest daily → Run workflow 手动触发一次；确认运行成功、日报 commit 已推送、线上 `/digest/` 可访问、GJ 主站卡片可达。

- [ ] **Step 6: 验收清单（全部勾选才算一期完成）**

- [ ] 每日 cron 产出日页/RSS/审核队列，零结果时任务失败告警
- [ ] 白名单每刊 verified_at 已回填，verify_journals 0 失败
- [ ] golden 回归 core precision ≥ 0.90
- [ ] 无摘要论文正常收录并标"摘要暂缺"，无编造摘要
- [ ] 日页三档分层正确（core 全字段 / related 标题+导读 / borderline 折叠）
- [ ] 归档页月份/相关性/子领域筛选与搜索可用
- [ ] 主站入口卡片与 `/digest/` 可公开访问
- [ ] 仓库不含任何密钥（.env 已 gitignore，secrets 仅在 Actions）

- [ ] **Step 7: 提交验收产物**

```powershell
git add cl-digest/data cl-digest/eval digest
git commit -m "feat(digest): 一期验收——首日数据、golden 集与白名单核验回填"
git push
```

---

## 附：关键决策备忘（实现时不要再纠结）

1. **Crossref type 只用 `journal-article`**：综述在 Crossref 同为该 type，无需 OR review（spec 中"article+review"的意图由此满足）。
2. **不设独立规则召回层**：白名单刊量小，LLM 全量分诊；lexicon.md 仅作 prompt 附件。
3. **irrelevant 不自动丢弃**：LLM 只输出三档，人工 resolve 才可判 irrelevant。
4. **渲染输出 = 仓库根 `digest/`**：主站由仓库根静态服务（已核实），git push 即部署，无独立部署步骤。
5. **seen.jsonl 记"已处理"而非"已推送"**：borderline 进入审核队列后不重复分诊，防止每日重算。
6. **月度数据 JS（`window.PAPERS_YYYY_MM`）**：归档页按月懒加载，避免单文件随年限膨胀。
