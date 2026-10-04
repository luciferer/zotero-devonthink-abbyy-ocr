# Publication checklist and release note draft

## Source and provenance

The source was copied from locally installed Zotero ABBYY Review Queue 0.2.2 and Zotero MCP Local Bridge 0.2.0, then changed **only in this publication candidate**. The local installations and OCR queue have not been upgraded or reconfigured as part of publication preparation. Source and documentation are offered under the MIT license in this repository; ABBYY and DEVONthink remain separately licensed products.

Public-candidate changes: remove the fixed `Codex Data` database name in favor of an explicit config name; refuse permanent deletion through the bridge; constrain both manifests to the Zotero 9.0.x series tested locally; replace nonfunctional update URLs with a repository release plan; provide a disabled-by-default config initializer, public documentation, and deterministic binary/update-manifest build.

## Release note draft

**v0.3.0 (candidate)**

- Adds a configurable database name while retaining UUID checks for the database and both OCR groups.
- Creates a separate searchable PDF attachment under the original Zotero parent; the original remains intact.
- Includes a local bridge for the queue and local MCP callers. Its item-deletion route supports trash only.
- Supports Zotero 9.0.x on macOS. A clean external installation, Zotero 10, and non-macOS systems have not been verified.
- Uses the ABBYY OCR capability of an independently installed DEVONthink. No OCR engine is bundled.

## Gates before a public release

1. MIT licensing and the `luciferer` repository owner have been selected; verify the GitHub release and repository visibly show this before treating the public release as complete.
2. Run source/secret scanning, repeatable builds, JS/Python tests, and an isolated fresh-install test on a disposable Zotero profile and DEVONthink ordinary database. Do not use a live research library for a release acceptance run.
3. Create the repository under the verified GitHub account, publish the source, create tag `v0.3.0`, and attach **both** named XPI assets from `dist/`.
4. Fetch the public `updates-*.json` URLs and release assets, compare their SHA-256 values, then install the released binaries in the isolated profile.
5. When Zotero offers an official plugin-directory submission route, follow that route. Its current official documentation says the directory is still planned. A community directory or a Zotero Forums announcement is a separate publication decision.

## Known limitation

This is a locally validated prototype prepared for publication. Library write routes in the bridge warrant an external security review before general recommendation. OCR text is not guaranteed scientifically correct: units and column reading order can be wrong. Automatically publishing a new sibling attachment is a technical completion signal, not expert review of its contents.
