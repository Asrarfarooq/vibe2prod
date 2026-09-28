from pathlib import Path

from google.adk.plugins.base_plugin import BasePlugin

from .events import Emitter

PROTECTED_PARTS = {".git", ".github"}


class PathNotAllowed(ValueError):
    pass


def safe_path(root: Path, relative: str) -> Path:
    """Resolves a model-supplied path and rejects anything outside root or in protected folders."""
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise PathNotAllowed(f"{relative} is outside the app folder")
    if PROTECTED_PARTS.intersection(target.relative_to(root).parts):
        raise PathNotAllowed(f"{relative} is in a protected folder")
    return target


class GuardrailPlugin(BasePlugin):
    """Blocks tools outside the stage allowlist and file paths outside the app folder."""

    def __init__(self, allowed_tools: set[str], app_dir: Path, emitter: Emitter):
        super().__init__(name="guardrails")
        self._allowed = allowed_tools
        self._root = app_dir
        self._emitter = emitter

    async def _block(self, tool_name: str, reason: str) -> dict:
        await self._emitter.safe_emit(
            "error", "guardrails", f"Blocked {tool_name}: {reason}"
        )
        return {"status": "blocked", "reason": reason}

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        if tool.name not in self._allowed:
            return await self._block(tool.name, "tool not allowed for this stage")
        path = tool_args.get("path")
        if path is not None:
            try:
                safe_path(self._root, str(path))
            except PathNotAllowed as err:
                return await self._block(tool.name, str(err))
        return None

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
        # An uncaught tool exception aborts the whole workflow; the model can recover from most of them.
        message = f"{error.__class__.__name__}: {error}"[:500]
        await self._emitter.safe_emit(
            "error", "guardrails", f"{tool.name} failed: {message}"
        )
        return {"status": "error", "error": message}
