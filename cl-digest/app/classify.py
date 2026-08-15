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
