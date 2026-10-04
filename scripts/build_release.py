#!/usr/bin/env python3
"""Build reproducible Zotero XPIs and their update manifests."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
OWNER_REPO = "luciferer/zotero-devonthink-abbyy-ocr"
PLUGINS = (
    ("zotero-mcp-local-bridge", "updates-bridge.json", ("manifest.json", "bootstrap.js")),
    ("zotero-abbyy-review-queue", "updates-ocr.json", ("addon/manifest.json", "addon/bootstrap.js", "addon/auto-dispatcher.js")),
)


def build(verify: bool = False) -> list[dict[str, str]]:
    dist = ROOT / "dist"
    if not verify:
        dist.mkdir(exist_ok=True)
    results = []
    for directory, updates_name, members in PLUGINS:
        plugin = ROOT / directory
        manifest = json.loads((plugin / members[0]).read_text())
        version = manifest["version"]
        addon_id = manifest["applications"]["zotero"]["id"]
        asset = f"{directory}-{version}.xpi"
        target = dist / asset
        if not verify:
            with ZipFile(target, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
                for member in members:
                    data = (plugin / member).read_bytes()
                    entry = ZipInfo(member.split("/", 1)[-1], date_time=(2020, 1, 1, 0, 0, 0))
                    entry.compress_type = ZIP_DEFLATED
                    entry.external_attr = 0o644 << 16
                    archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        spec = {
            "addons": {
                addon_id: {
                    "updates": [{
                        "version": version,
                        "update_link": f"https://raw.githubusercontent.com/{OWNER_REPO}/main/downloads/v0.3.0/{asset}",
                        "update_hash": f"sha256:{digest}",
                        "applications": {"zotero": {"strict_min_version": "9.0", "strict_max_version": "9.0.*"}},
                    }]
                }
            }
        }
        update_path = ROOT / updates_name
        expected = json.dumps(spec, indent=2, ensure_ascii=False) + "\n"
        if verify:
            if update_path.read_text() != expected:
                raise SystemExit(f"Update manifest or binary hash mismatch: {update_path}")
        else:
            update_path.write_text(expected)
        results.append({"asset": asset, "sha256": digest, "id": addon_id})
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="do not rewrite update manifests; fail on mismatch")
    print(json.dumps(build(parser.parse_args().verify), ensure_ascii=False, indent=2))
