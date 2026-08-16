"""classify 测试：FakeClient 替代真实 LLM。"""
import pytest
import requests

from app.classify import (
    ClassifyError,
    LLMClient,
    classify_or_degrade,
    parse_analysis,
    translate_abstract,
)

GOOD = ('{"relevance":"core","subfield":"criminal_law_core","worth_score":9,'
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
        parse_analysis('{"relevance":"nope","subfield":"criminal_law_core","worth_score":9,'
                       '"title_zh":"a","tldr_zh":"b","inclusion_reason_zh":"c"}')
    with pytest.raises(ClassifyError):
        parse_analysis("不是 JSON")


def test_parse_analysis_rejects_bad_worth_score():
    # 缺失 / 越界 / 非整数 均拒绝
    for raw in (
        GOOD.replace('"worth_score":9,', ''),
        GOOD.replace('"worth_score":9', '"worth_score":11'),
        GOOD.replace('"worth_score":9', '"worth_score":"9"'),
    ):
        with pytest.raises(ClassifyError):
            parse_analysis(raw)


def test_translate_abstract_roundtrip():
    client = FakeClient(['{"translation_zh":"本文研究罪过理论。"}'])
    assert translate_abstract("abstract text", client) == "本文研究罪过理论。"


def test_translate_abstract_rejects_empty():
    client = FakeClient(['{"translation_zh":"  "}'])
    with pytest.raises(ClassifyError):
        translate_abstract("abstract text", client)


def test_classify_or_degrade_success_first_try():
    client = FakeClient([GOOD])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client)
    assert degraded is False and analysis["relevance"] == "core"
    assert client.calls == 1


def test_classify_or_degrade_retries_once_then_degrades():
    client = FakeClient([ClassifyError("boom"), ClassifyError("boom")])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client)
    assert degraded is True
    assert analysis["relevance"] == "borderline"
    assert analysis["tldr_zh"] is None
    assert client.calls == 2


def test_classify_or_degrade_degrades_on_request_exception():
    client = FakeClient([requests.ConnectionError("net"), requests.ConnectionError("net")])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client)
    assert degraded is True and analysis["relevance"] == "borderline"


def test_classify_or_degrade_succeeds_on_retry():
    client = FakeClient([ClassifyError("bad"), GOOD])
    analysis, degraded = classify_or_degrade("T", "A", "lex", client)
    assert degraded is False and analysis["relevance"] == "core"
    assert client.calls == 2
