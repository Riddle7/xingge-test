"""规范化纯函数：DOI 清洗、日期解析、摘要重建、记录组装、去重。无 IO。"""
import html
import re

from langdetect import DetectorFactory, detect

DetectorFactory.seed = 0  # 结果确定性

DOI_RE = re.compile(r"^10\.\S+/\S+$")
DOI_PREFIX_RE = re.compile(r"^(?i:(?:https?://)?(?:dx\.)?doi\.org/|doi:\s*)")


def clean_doi(raw):
    """清洗为规范 DOI（小写、去前缀）；非法返回 None。"""
    if not raw or not isinstance(raw, str):
        return None
    doi = DOI_PREFIX_RE.sub("", raw.strip()).lower()
    return doi if DOI_RE.match(doi) else None


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
