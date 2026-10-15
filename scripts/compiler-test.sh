#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../services/compiler"
compiler_venv="${PARLANCE_COMPILER_VENV:-.venv}"

if [[ ! -x "$compiler_venv/bin/pytest" ]]; then
  compiler_python="${PARLANCE_COMPILER_PYTHON:-python3.12}"
  if ! command -v "$compiler_python" >/dev/null 2>&1; then
    compiler_python=python3
  fi
  "$compiler_python" -c 'import sys; assert sys.version_info >= (3, 12), "Compiler tests require Python 3.12 or newer"'
  "$compiler_python" -m venv "$compiler_venv"
  "$compiler_venv/bin/python" -m pip install -e '.[dev]'
fi

exec "$compiler_venv/bin/pytest"
