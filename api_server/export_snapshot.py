from __future__ import annotations

import argparse
from pathlib import Path

from .main import app
from .service import players_envelope


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(content, encoding="utf-8")
    temp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the real M.E.S.S.I. API response for static staging.")
    parser.add_argument("--frontend-public", type=Path, required=True)
    parser.add_argument("--season", default="2025/2026")
    parser.add_argument("--scope", type=int, choices=(3, 5, 7), default=7)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    envelope = players_envelope(args.season, args.scope, args.limit)
    write_text(args.frontend_public / "api/v1/players.json", envelope.model_dump_json(indent=2))
    write_text(args.frontend_public / "openapi.json", __import__("json").dumps(app.openapi(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
