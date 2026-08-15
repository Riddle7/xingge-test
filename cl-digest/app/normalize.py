"""规范化纯函数：DOI 清洗、日期解析、摘要重建、记录组装、去重。无 IO。"""
import html
import re

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
