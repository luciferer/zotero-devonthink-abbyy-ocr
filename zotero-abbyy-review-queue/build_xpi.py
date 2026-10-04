from pathlib import Path
import json
from zipfile import ZIP_DEFLATED, ZipFile
root=Path(__file__).parent
version=json.loads((root/"addon"/"manifest.json").read_text())["version"]
out=root/("zotero-abbyy-review-queue-"+version+".xpi")
with ZipFile(out,"w",ZIP_DEFLATED) as z:
  for name in ("manifest.json","bootstrap.js","auto-dispatcher.js"): z.write(root/"addon"/name,name)
print(out)
