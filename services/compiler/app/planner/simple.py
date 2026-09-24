"""Compatibility import for the compiler endpoint; C3A lives in compiler.py."""

from app.planner.compiler import compile_goal

__all__ = ["compile_goal"]
