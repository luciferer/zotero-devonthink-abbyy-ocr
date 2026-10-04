#!/usr/bin/env python3
"""Create a disabled-by-default local ABBYY queue configuration."""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = Path.home() / ".local/share/zotero-devonthink-ocr"
UUID = re.compile(r"^(?:x-devonthink-item://)?([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})$")


def record_id(value: str) -> str:
    match = UUID.fullmatch(value)
    if not match:
        raise argparse.ArgumentTypeError("Expected a DEVONthink UUID or x-devonthink-item:// link")
    return match.group(1).upper()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=record_id, required=True)
    parser.add_argument("--database-name", required=True)
    parser.add_argument("--working-group", type=record_id, required=True)
    parser.add_argument("--result-group", type=record_id, required=True)
    parser.add_argument("--devonthink-mcp", type=Path, default=Path("/Applications/DEVONthink.app/Contents/Library/LoginItems/DEVONthink MCP.app/Contents/MacOS/DEVONthink MCP"))
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This integration currently supports macOS only")
    if importlib.util.find_spec("pypdf") is None:
        parser.error("pypdf is missing from this Python; install it into the Python you use for this queue")
    if not args.devonthink_mcp.is_file():
        parser.error("DEVONthink MCP executable not found at the selected path")
    config_path = RUNTIME / "config.json"
    worker_path = RUNTIME / "worker.py"
    if config_path.exists() or worker_path.exists():
        parser.error(f"Existing runtime files at {RUNTIME}; back them up and migrate explicitly")
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    worker = ROOT / "bridge_queue.py"
    shutil.copy2(worker, worker_path)
    worker_path.chmod(0o700)
    config = {
        "configVersion": "abbyy-append-only-v1",
        "python": sys.executable,
        "worker": str(worker_path),
        "requestsDir": str(RUNTIME / "queue"),
        "sourceDatabaseUUID": args.database,
        "sourceDatabaseName": args.database_name,
        "sourceGroupUUID": args.working_group,
        "resultGroupUUID": args.result_group,
        "devonthinkMcp": str(args.devonthink_mcp),
        "ocrTimeoutSeconds": 600,
        "ocrPolicy": "all-selected",
        "autoEnabled": False,
        "autoPublish": False,
        "autoScope": "new-personal-pdf-attachments",
    }
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    config_path.chmod(0o600)
    (RUNTIME / "queue").mkdir(exist_ok=True, mode=0o700)
    print(f"Configuration created: {config_path}")
    print("Install both XPIs in Zotero, verify the groups, then enable automatic OCR from Zotero Tools.")


if __name__ == "__main__":
    main()
