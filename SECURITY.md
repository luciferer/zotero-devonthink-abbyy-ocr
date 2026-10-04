# Security scope

Both Zotero plugins execute with Zotero's internal privileges. Install them only from a release you trust and verify the XPI hashes in the corresponding update manifests.

The Local Bridge adds write-capable endpoints on Zotero's existing local HTTP server. It does not expose a new network listener and marks its endpoints unsafe-web-content disallowed. A process on the same computer can still attempt local HTTP requests. Do not forward Zotero's port 23119 or expose it through a public proxy. Permanent item deletion is explicitly rejected; recoverable trash and other item/collection writes remain possible.

The OCR worker copies source PDFs, invokes DEVONthink's native MCP on a configured ordinary database, and imports a new attachment back into Zotero. Its own job directory can contain original and OCR-derived research documents. Treat that directory as private user data. Never submit it, a real `config.json`, DEVONthink database packages, Zotero profiles, or Keychain items to GitHub issues or pull requests.

Please report suspected vulnerabilities through GitHub's private vulnerability reporting feature if enabled for this repository. Otherwise open an issue containing only a redacted reproduction and ask the maintainer for a private contact route. Do not post credentials, document contents, or local paths in a public issue.
