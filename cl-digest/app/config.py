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
