import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

DEBUG_LOG_PATH = Path(os.getenv("DEBUG_LOG_PATH", "/app/debug/pokecollector-debug.log"))
_HANDLER_NAME = "pokecollector_debug_file"
_enabled = False
_previous_root_level: int | None = None
_previous_handler_levels: dict[int, int] = {}


def _get_handler() -> RotatingFileHandler | None:
    root = logging.getLogger()
    for handler in root.handlers:
        if getattr(handler, "name", None) == _HANDLER_NAME:
            return handler
    return None


def configure_debug_logging(enabled: bool) -> None:
    """Enable/disable app-wide debug file logging.

    The file handler is attached to the root logger so existing module loggers
    are captured without invasive code changes. While enabled, non-debug-file
    handlers are kept at INFO or above to avoid spamming container/stdout logs.
    """
    global _enabled, _previous_root_level, _previous_handler_levels
    root = logging.getLogger()
    existing = _get_handler()

    if enabled:
        DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        DEBUG_LOG_PATH.touch(exist_ok=True)
        if _previous_root_level is None:
            _previous_root_level = root.level
            _previous_handler_levels = {
                id(handler): handler.level
                for handler in root.handlers
                if getattr(handler, "name", None) != _HANDLER_NAME
            }
        if existing is None:
            handler = RotatingFileHandler(
                DEBUG_LOG_PATH,
                maxBytes=2 * 1024 * 1024,
                backupCount=3,
                encoding="utf-8",
            )
            handler.name = _HANDLER_NAME
            handler.setLevel(logging.DEBUG)
            handler.setFormatter(logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
            ))
            root.addHandler(handler)
        for handler in root.handlers:
            if getattr(handler, "name", None) != _HANDLER_NAME and handler.level < logging.INFO:
                handler.setLevel(logging.INFO)
        root.setLevel(logging.DEBUG)
        _enabled = True
        logging.getLogger(__name__).info("Debug logging enabled")
        return

    if existing is not None:
        logging.getLogger(__name__).info("Debug logging disabled")
        root.removeHandler(existing)
        existing.close()
    if _previous_root_level is not None:
        root.setLevel(_previous_root_level)
        _previous_root_level = None
    for handler in root.handlers:
        previous_level = _previous_handler_levels.get(id(handler))
        if previous_level is not None:
            handler.setLevel(previous_level)
    _previous_handler_levels = {}
    _enabled = False


def is_debug_logging_enabled() -> bool:
    return _enabled


def get_debug_log_path() -> Path:
    DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    DEBUG_LOG_PATH.touch(exist_ok=True)
    return DEBUG_LOG_PATH
