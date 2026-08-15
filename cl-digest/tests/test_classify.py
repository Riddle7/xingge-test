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
