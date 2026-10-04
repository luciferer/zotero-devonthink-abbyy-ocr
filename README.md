# Zotero ↔ DEVONthink ABBYY OCR (community plugins)

Two independently installable Zotero plugins for a macOS-only, append-only OCR workflow. These are third-party plugins. They are not published or endorsed by Zotero, DEVONtechnologies, or ABBYY. The ABBYY OCR component is supplied by a separately licensed DEVONthink installation; no ABBYY binary is included here.

**Release status:** [v0.3.0 public pre-release](https://github.com/luciferer/zotero-devonthink-abbyy-ocr/releases/tag/v0.3.0). The local workflow was tested with Zotero 9.0.6 and DEVONthink 4 on macOS. A fresh install on another computer has not yet been verified. The upstream Zotero plugin directory has no submission route as of October 2026; see [Zotero's plugins page](https://www.zotero.org/support/plugins).

## What is included

| Folder | Function | Version |
| --- | --- | --- |
| [`zotero-mcp-local-bridge`](zotero-mcp-local-bridge/) | Exposes local Zotero CRUD routes used by the queue and compatible local MCP callers | 0.3.0 |
| [`zotero-abbyy-review-queue`](zotero-abbyy-review-queue/) | Detects new personal-library PDF child attachments, processes a copy through DEVONthink ABBYY, and adds a separate searchable PDF under the same parent | 0.3.0 |

The original PDF and its Zotero annotations remain in place. An automatically generated attachment is marked “自动识别待复核” because OCR can misread numbers, units, names, and formulas. For one science paper, the local acceptance run found `3 μg/ml` misread as `3 Ng/ml`. Check the source page before citing extracted text.

## Requirements and installation

- macOS with Zotero **9.0.x** and DEVONthink 4 with its ABBYY OCR helper available.
- Python 3 with [`pypdf`](https://pypi.org/project/pypdf/) installed in the same interpreter used for the queue.
- DEVONthink's native MCP executable (its usual app-bundle path is the default in the setup script).
- Two ordinary DEVONthink groups in one ordinary database: one for working copies, another for OCR results. Do not target an encrypted or credential database.

1. Build the two XPIs with `python3 scripts/build_release.py`. Install **Local Bridge first**, then **ABBYY Review Queue**, through Zotero → Tools → Plugins → Install Plugin From File.
2. In DEVONthink, copy the database and two group item links. Find their UUIDs in those `x-devonthink-item://...` links. Supply the database name exactly as DEVONthink displays it.
3. Run `python3 zotero-abbyy-review-queue/init_config.py --database <DATABASE-LINK> --database-name '<NAME>' --working-group <WORKING-GROUP-LINK> --result-group <RESULT-GROUP-LINK>`. The script validates the local dependencies, writes only under `~/.local/share/zotero-devonthink-ocr`, and starts with automatic processing **off**. If you already have that runtime directory, back it up and migrate its config intentionally; the script refuses to overwrite it.
4. Confirm Zotero and the intended DEVONthink database are running. In Zotero Tools, turn on **新增 PDF 自动识别并追加**. Add a disposable PDF as a child of a disposable bibliographic item and verify that a single new OCR attachment appears under the same parent. Check the original hash and PDF page count before using it on research material.

This workflow currently watches **new personal-library PDF child attachments**. Existing attachments are processed only when explicitly selected from the menu. Group libraries, top-level PDFs without a parent, encrypted PDFs, and PDFs lacking a stable local file are outside the supported automatic path. A long download is rechecked at a lower frequency. In an uncertain OCR or publication state the job is retained for inspection rather than blindly replayed.

## Security and data boundaries

The bridge runs inside Zotero and its routes can create, update, link, import, and soft-delete library records. Zotero plugins have broad access to your computer and library; use these only on a trusted local machine. The bridge explicitly refuses **permanent item deletion**. Its routes are local and do not provide a public web service, but a local process with access to Zotero's HTTP server can still attempt calls. Do not forward port 23119 to a network.

The OCR worker imports **working copies** into the configured DEVONthink ordinary database, then appends an OCR-derived PDF into Zotero. Its configuration contains database/group IDs and local paths, so `config.json`, job directories, document contents, and extracted PDFs are deliberately absent from this repository. No API keys, Zotero data directory, DEVONthink database package, or ABBYY binaries are included.

## Build and verification

```sh
python3 scripts/build_release.py
python3 scripts/build_release.py --verify
python3 -m unittest discover -s zotero-abbyy-review-queue/tests -q
node --test zotero-abbyy-review-queue/tests/*.js zotero-mcp-local-bridge/tests/*.js
```

The build produces XPIs in `dist/` and update manifests in the repository root. The v0.3.0 binaries are stored in [`downloads/v0.3.0/`](downloads/v0.3.0/) and linked from the GitHub pre-release page. The update manifests point directly to those versioned files and include their SHA-256 values. The packaged compatibility range is limited to Zotero 9.0.x, the version series tested locally.

## Maintenance

The two plugin IDs retain the historical local IDs so an explicitly installed public version can update an earlier private prototype. **Do not run both versions in one Zotero profile.** Back up the dedicated queue directory and Zotero profile before replacing a local prototype. Keep its pending job JSON and original PDFs during migration. Release notes and test evidence are in [PUBLICATION.md](PUBLICATION.md).

This project is not an official Zotero plugin. Zotero's [official plugins documentation](https://www.zotero.org/support/plugins) currently says an official plugin directory is planned. Community registries are separate projects with their own review processes.
