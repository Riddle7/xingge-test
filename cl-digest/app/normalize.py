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
