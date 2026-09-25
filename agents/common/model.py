import os

from google.adk.models.google_llm import Gemini
from google.adk.planners import BuiltInPlanner
from google.genai import types

MODEL = os.environ.get("MODEL", "gemini-3.8-flash")


def gemini() -> Gemini:
    return Gemini(
        model=MODEL, retry_options=types.HttpRetryOptions(initial_delay=2, attempts=5)
    )


def thinking(level: types.ThinkingLevel = types.ThinkingLevel.HIGH) -> BuiltInPlanner:
    return BuiltInPlanner(
        thinking_config=types.ThinkingConfig(
            include_thoughts=True, thinking_level=level
        )
    )
