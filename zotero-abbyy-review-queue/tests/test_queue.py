import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bridge_queue", Path(__file__).parents[1] / "bridge_queue.py")
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class FakeZotero:
    def __init__(self, source):
        self.source = source
        self.parent = "PARENTAA"
        self.attached = {}
        self.imports = 0
        self.lose_response = False
    def ping(self):
        return {"userLibraryID": 1}
    def item(self, key):
        if key == "SOURCEAA":
            return {"key": key, "itemType": "attachment", "parentItem": self.parent,
                    "contentType": "application/pdf"}
        if key == "PARENTAA":
            return {"key": key, "itemType": "journalArticle"}
        return self.attached[key]["meta"]
    def file(self, key):
        return self.source if key == "SOURCEAA" else self.attached[key]["path"]
    def children(self, key):
        return [x["meta"] for x in self.attached.values()]
    def import_file(self, parent, path, title, library):
        self.imports += 1
        key = "OUTPUTAA"
        dst = self.source.parent / "zotero-result.pdf"
        dst.write_bytes(Path(path).read_bytes())
        self.attached[key] = {"path": dst, "meta": {"key": key, "itemType": "attachment",
            "parentItem": parent, "title": title, "contentType": "application/pdf"}}
        if self.lose_response:
            raise TimeoutError("response lost")
        return key


class FakeDT:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ocr_count = 0
        self.timeout = False
        self.wrong_group = False
    def call(self, name, args):
        db = self.cfg["sourceDatabaseUUID"]
        if name == "get_databases":
            return {"databases": [{"uuid": db, "name": "Codex Data"}]}
        if name == "get_record_properties":
            return {"uuid": args["uuid"], "kind": "Group",
                    "databaseUUID": "WRONG" if self.wrong_group else db}
        if name == "import_file":
            return {"uuid": "DTSOURCE", "databaseUUID": db}
        if name == "ocr_record":
            self.ocr_count += 1
            if self.timeout:
                raise TimeoutError("OCR still processing")
            return {"uuid": "DTRESULT", "databaseUUID": db}
        if name == "move_record":
            return {"uuid": "DTRESULT"}
        if name == "export_record":
            Path(args["path"], "result.pdf").write_bytes(b"derived search text")
            return {"path": str(Path(args["path"], "result.pdf"))}
        raise AssertionError(name)
    def close(self):
        pass


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "source.pdf"
        self.source.write_bytes(b"synthetic scan")
        self.cfg = {"requestsDir": str(self.root / "queue"), "configVersion": "v1",
            "sourceDatabaseName": "Codex Data",
            "sourceDatabaseUUID": "DB1", "sourceGroupUUID": "G1", "resultGroupUUID": "G2"}
        self.req = {"action": "submit", "key": "SOURCEAA", "parentKey": "PARENTAA",
            "libraryID": 1, "libraryIdentity": "test-profile:personal", "path": str(self.source)}
        self.z = FakeZotero(self.source)
        self.dt = FakeDT(self.cfg)
        self.counts = [0]
        def inspect(path):
            chars = [25]*len(self.counts) if Path(path).parent.name == "output" else list(self.counts)
            return {"pages": len(chars), "chars": chars, "geometry": [[0, 0, 600, 800, 0]]*len(chars)}
        self.engine = q.Engine(self.cfg, self.z, lambda: self.dt, inspect)
    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()
    def publish(self):
        return self.engine.publish({**self.req, "approved": True})
    def test_repeated_submit_and_publish_do_not_duplicate(self):
        one = self.engine.submit(self.req)
        self.assertEqual(one["state"], "review")
        self.assertEqual(self.engine.submit(self.req)["jobId"], one["jobId"])
        self.assertEqual(self.dt.ocr_count, 1)
        self.assertEqual(self.publish()["state"], "published")
        self.assertEqual(self.publish()["derivedAttachmentKey"], "OUTPUTAA")
        self.assertEqual(self.z.imports, 1)
        self.assertEqual(self.source.read_bytes(), b"synthetic scan")
    def test_wrong_parent_rejected_before_ocr(self):
        self.z.parent = "OTHERAAA"
        with self.assertRaises(q.SafetyError):
            self.engine.submit(self.req)
        self.assertEqual(self.dt.ocr_count, 0)
    def test_existing_text_is_ocr_processed(self):
        self.counts[:] = [12]
        self.assertEqual(self.engine.submit(self.req)["state"], "review")
        self.assertEqual(self.dt.ocr_count, 1)
    def test_timeout_not_retried(self):
        self.dt.timeout = True
        with self.assertRaises(TimeoutError):
            self.engine.submit(self.req)
        with self.assertRaises(q.SafetyError):
            self.engine.submit(self.req)
        self.assertEqual(self.dt.ocr_count, 1)
    def test_lost_publish_reply_recovers_without_duplicate(self):
        self.engine.submit(self.req)
        self.z.lose_response = True
        with self.assertRaises(TimeoutError):
            self.publish()
        self.assertEqual(self.publish()["state"], "published")
        self.assertEqual(self.z.imports, 1)
    def test_changed_source_cannot_publish_old_result(self):
        self.engine.submit(self.req)
        self.source.write_bytes(b"changed source")
        with self.assertRaises(q.SafetyError):
            self.publish()
        self.assertEqual(self.z.imports, 0)
    def test_modified_result_not_imported(self):
        result = self.engine.submit(self.req)
        Path(result["outputPath"]).write_bytes(b"tampered")
        with self.assertRaises(q.SafetyError):
            self.publish()
        self.assertEqual(self.z.imports, 0)
    def test_foreign_dt_group_rejected(self):
        self.dt.wrong_group = True
        with self.assertRaises(q.SafetyError):
            self.engine.submit(self.req)
        self.assertEqual(self.dt.ocr_count, 0)
    def test_unapproved_publish_rejected(self):
        self.engine.submit(self.req)
        with self.assertRaises(q.SafetyError):
            self.engine.publish(self.req)
        self.assertEqual(self.z.imports, 0)
    def test_wrong_selected_path_rejected(self):
        req = {**self.req, "path": str(self.root / "other.pdf")}
        with self.assertRaises(q.SafetyError):
            self.engine.submit(req)

    def test_dense_text_is_ocr_processed(self):
        self.counts[:] = [3500]
        result = self.engine.submit(self.req)
        self.assertEqual(result["state"], "review")
        self.assertEqual(result["preflight"]["textPages"], 1)
        self.assertEqual(self.dt.ocr_count, 1)

    def test_mixed_pdf_is_processed(self):
        self.counts[:] = [3500, 0]
        result=self.engine.submit(self.req)
        self.assertEqual(result["state"],"review")
        self.assertEqual(result["preflight"]["zeroTextPages"],[2])
        self.assertEqual(self.dt.ocr_count,1)

    def test_sparse_text_is_processed(self):
        self.counts[:] = [3500, 8]
        result=self.engine.submit(self.req)
        self.assertEqual(result["state"],"review")
        self.assertEqual(result["preflight"]["sparseTextPages"],[2])
        self.assertEqual(self.dt.ocr_count,1)

    def test_old_skip_is_processed_after_explicit_resubmit(self):
        self.counts[:] = [3500]
        source,sha=self.engine.validate_source(self.req)
        ident=self.engine.identity(self.req,sha)
        folder=self.engine.root/ident
        folder.mkdir()
        job={"jobId":ident,"state":"manual-review","directory":str(folder),
          "sourcePath":str(source),"sourceSHA256":sha,"parentKey":self.req["parentKey"],
          "attachmentKey":self.req["key"],"libraryID":1,
          "input":{"pages":1,"chars":[3500],"geometry":[[0,0,600,800,0]]}}
        self.engine.save(job, "manual-review")
        result = self.engine.submit(self.req)
        self.assertEqual(result["state"], "review")
        self.assertEqual(self.dt.ocr_count, 1)


if __name__ == "__main__":
    unittest.main()
