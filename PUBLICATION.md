# Publication record and remaining acceptance checks

## Source and provenance

The source was copied from locally installed Zotero ABBYY Review Queue 0.2.2 and Zotero MCP Local Bridge 0.2.0, then changed **only in this publication candidate**. The local installations and OCR queue have not been upgraded or reconfigured as part of publication preparation. Source and documentation are offered under the MIT license in this repository; ABBYY and DEVONthink remain separately licensed products.

Public-candidate changes: remove the fixed `Codex Data` database name in favor of an explicit config name; refuse permanent deletion through the bridge; constrain both manifests to the Zotero 9.0.x series tested locally; replace nonfunctional update URLs with a repository release plan; provide a disabled-by-default config initializer, public documentation, and deterministic binary/update-manifest build.

## v0.3.0 pre-release

**v0.3.0 (candidate)**

- Adds a configurable database name while retaining UUID checks for the database and both OCR groups.
- Creates a separate searchable PDF attachment under the original Zotero parent; the original remains intact.
- Includes a local bridge for the queue and local MCP callers. Its item-deletion route supports trash only.
- Supports Zotero 9.0.x on macOS. A clean external installation, Zotero 10, and non-macOS systems have not been verified.
- Uses the ABBYY OCR capability of an independently installed DEVONthink. No OCR engine is bundled.

## Published and verified

- Public source repository: https://github.com/luciferer/zotero-devonthink-abbyy-ocr
- MIT license, source, build script, tests, update manifests, and documentation are on `main`.
- The pre-release page links to two versioned XPI files stored under `downloads/v0.3.0/`. The first attempt to attach files directly as GitHub Release assets did not persist them; the built-in Assets section therefore contains only GitHub's source archives. Use the explicit XPI links in the release description or README.
- Both versioned files were fetched through their public raw GitHub URLs and passed SHA-256 and ZIP/manifest checks against their update JSON entries. The local runtime installed on the owner's Mac remains on the earlier private versions.

## Remaining acceptance checks

1. Repeat installation and one synthetic PDF cycle on a **separate disposable Zotero profile and DEVONthink ordinary database**. Do not use a live research library for a release acceptance run.
2. Obtain an external security review of the write-capable local bridge before recommending it broadly.
3. When Zotero offers an official plugin-directory submission route, follow that route. Its current official documentation says the directory is still planned. A community directory or a Zotero Forums announcement is a separate publication decision.

## Known limitation

This is a locally validated prototype prepared for publication. Library write routes in the bridge warrant an external security review before general recommendation. OCR text is not guaranteed scientifically correct: units and column reading order can be wrong. Automatically publishing a new sibling attachment is a technical completion signal, not expert review of its contents.
