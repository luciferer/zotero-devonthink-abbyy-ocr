#!/usr/bin/env python3
"""Explicit-selection ABBYY queue. Application records are changed only via APIs."""
from __future__ import annotations
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request


class SafetyError(RuntimeError):
    pass


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, obj):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def pdf_info(path):
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        raise SafetyError("加密 PDF 不在此队列的处理范围内")
    chars, geometry = [], []
    for page in reader.pages:
        chars.append(len((page.extract_text() or "").strip()))
        geometry.append([*[float(x) for x in page.mediabox],
                         *[float(x) for x in page.cropbox], int(page.rotation or 0)])
    if not chars:
        raise SafetyError("PDF 没有页面")
    return {"pages": len(chars), "chars": chars, "geometry": geometry}


def text_layer_report(info):
    """Record existing text only; it never prevents user-requested OCR."""
    counts = info["chars"]
    zero = [i + 1 for i, count in enumerate(counts) if count == 0]
    sparse = [i + 1 for i, count in enumerate(counts) if 0 < count < 80]
    return {"totalPages": len(counts), "textPages": len(counts) - len(zero),
              "zeroTextPages": zero, "sparseTextPages": sparse, "totalChars": sum(counts)}


class NativeMCP:
    ALLOWED = {"get_databases", "get_record_properties", "import_file",
               "ocr_record", "move_record", "export_record"}

    def __init__(self, cfg):
        self.timeout = max(300, cfg.get("ocrTimeoutSeconds", 600))
        self.messages = queue.Queue()
        self.serial = 0
        self.proc = subprocess.Popen([cfg["devonthinkMcp"], "--stdio"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=str(Path.home()))
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "zotero-abbyy-review-queue", "version": "0.1.0"}}, 30)
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            self.close()
            raise

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    self.messages.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
        finally:
            self.messages.put(None)

    def send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def rpc(self, method, params, timeout):
        self.serial += 1
        ident = self.serial
        self.send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("DEVONthink 响应超时，应用端操作可能仍在进行")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("DEVONthink 响应超时，应用端操作可能仍在进行")
            if message is None:
                raise SafetyError("DEVONthink MCP 连接中断")
            if message.get("id") != ident:
                continue
            if "error" in message:
                raise SafetyError(str(message["error"])[:1000])
            return message.get("result", {})

    def call(self, name, args):
        if name not in self.ALLOWED:
            raise SafetyError("未授权的 DEVONthink 操作")
        result = self.rpc("tools/call", {"name": name, "arguments": args},
                          self.timeout if name == "ocr_record" else 90)
        texts = [c["text"] for c in result.get("content", []) if c.get("type") == "text"]
        if result.get("isError"):
            raise SafetyError("DEVONthink: " + "\n".join(texts)[:1000])
        if result.get("structuredContent") is not None:
            return result["structuredContent"]
        if len(texts) == 1:
            try:
                return json.loads(texts[0])
            except json.JSONDecodeError:
                return texts[0]
        return texts

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def record_obj(value, expected=None, different=None):
    for obj in objects(value):
        uid = obj.get("uuid")
        if not uid or (expected and uid.upper() != expected.upper()) or uid == different:
            continue
        return obj
    raise SafetyError("DEVONthink 没有返回可核对的记录 UUID")


class Zotero:
    def __init__(self, cfg):
        self.base = "http://127.0.0.1:23119"
        self.prefix = "/api/users/0"

    def request(self, path, data=None, text=False):
        headers = {"Zotero-Allowed-Request": "1"}
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        req = urllib.request.Request(self.base + path, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode("utf-8")
        return raw if text else json.loads(raw)

    def ping(self):
        reply = self.request("/mcp-bridge/ping")
        if not reply.get("ok"):
            raise SafetyError("Zotero 本地桥不可用")
        return reply["result"]

    def item(self, key):
        obj = self.request(self.prefix + "/items/" + key)
        return obj.get("data", obj)

    def children(self, key):
        return [x.get("data", x) for x in self.request(self.prefix + "/items/" + key + "/children")]

    def file(self, key):
        raw = self.request(self.prefix + "/items/" + key + "/file/view/url", text=True).strip()
        if raw.startswith('"'):
            raw = json.loads(raw)
        url = urllib.parse.urlparse(raw)
        if url.scheme != "file" or url.netloc not in ("", "localhost"):
            raise SafetyError("Zotero 没有返回本地附件文件")
        return Path(urllib.parse.unquote(url.path)).resolve()

    def import_file(self, parent, path, title, library_id):
        reply = self.request("/mcp-bridge/attachments/import-file", {
            "libraryType": "user", "libraryID": library_id, "parentKey": parent,
            "filePath": str(path), "title": title, "contentType": "application/pdf"})
        if not reply.get("ok") or not reply.get("result", {}).get("key"):
            raise SafetyError("Zotero 未返回新附件 key，需核查后恢复")
        return reply["result"]["key"]


class Engine:
    def __init__(self, cfg, zotero=None, dt_factory=None, inspector=pdf_info):
        self.cfg = cfg
        self.root = Path(cfg["requestsDir"]).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.z = zotero or Zotero(cfg)
        self.dt_factory = dt_factory or (lambda: NativeMCP(cfg))
        self.inspect = inspector
        self.db = sqlite3.connect(self.root / "queue.sqlite3")
        self.db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL)")
        self.db.commit()

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def locked(self):
        with open(self.root / ".worker.lock", "a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SafetyError("另一个队列任务正在运行，请稍后再试")
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def save(self, job, state=None):
        if state:
            job["state"] = state
        job["updatedAt"] = time.time()
        self.db.execute("INSERT INTO jobs(id,state,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
            (job["jobId"], job["state"], json.dumps(job, ensure_ascii=False)))
        self.db.commit()
        atomic_json(Path(job["directory"]) / "job.json", job)

    def load(self, ident):
        row = self.db.execute("SELECT data FROM jobs WHERE id=?", (ident,)).fetchone()
        return json.loads(row[0]) if row else None

    def validate_source(self, req):
        if not all(re.fullmatch("[A-Z0-9]{8}", str(req.get(k, ""))) for k in ("key", "parentKey")):
            raise SafetyError("无效 Zotero 条目标识")
        ping = self.z.ping()
        if req.get("libraryID") != ping["userLibraryID"]:
            raise SafetyError("仅支持当前个人库，不允许跨库")
        if not req.get("libraryIdentity"):
            raise SafetyError("缺少库身份")
        meta = self.z.item(req["key"])
        if (meta.get("itemType") != "attachment" or
            meta.get("parentItem") != req["parentKey"] or
            meta.get("contentType") != "application/pdf"):
            raise SafetyError("Zotero 附件类型或父条目不匹配")
        parent = self.z.item(req["parentKey"])
        if parent.get("itemType") in ("attachment", "note", "annotation") or parent.get("deleted"):
            raise SafetyError("父条目不是有效书目记录")
        source = self.z.file(req["key"])
        if source != Path(req["path"]).resolve() or not source.is_file():
            raise SafetyError("来源路径与 Zotero 实际附件不一致")
        if any(p.lower().endswith((".dtbase2", ".dtsparse", ".dtarchive")) for p in source.parts):
            raise SafetyError("不能直接访问 DEVONthink 数据库包中的文件")
        return source, digest(source)

    def identity(self, req, sha):
        values = [req["libraryIdentity"], str(req["libraryID"]), req["parentKey"],
                  req["key"], sha, self.cfg["configVersion"]]
        return hashlib.sha256(json.dumps(values).encode()).hexdigest()[:24]

    def check_source(self, job):
        if digest(job["sourcePath"]) != job["sourceSHA256"]:
            raise SafetyError("原附件在处理期间发生变化，停止发布")

    def verify_targets(self, dt):
        dbid = self.cfg["sourceDatabaseUUID"]
        db = record_obj(dt.call("get_databases", {"uuid": dbid}), expected=dbid)
        expected_name = self.cfg.get("sourceDatabaseName")
        if not expected_name or db.get("name") != expected_name:
            raise SafetyError("目标数据库名称与已配置的数据库不一致")
        for key in ("sourceGroupUUID", "resultGroupUUID"):
            uid = self.cfg[key]
            prop = record_obj(dt.call("get_record_properties", {"uuid": uid, "database_uuid": dbid}), expected=uid)
            if prop.get("databaseUUID") != dbid or prop.get("kind") != "Group":
                raise SafetyError("加工组身份或数据库归属不匹配")

    def submit(self, req):
        source, sha = self.validate_source(req)
        ident = self.identity(req, sha)
        job = self.load(ident)
        if job:
            if job["state"] in ("manual-review", "text-present") and job.get("input"):
                job["reason"] = "用户明确要求重新识别所有主动提交的 PDF"
                self.save(job, "queued")
            if job["state"] in ("review", "published"):
                return self.summary(job)
            if job["state"] in ("importing", "ocr-started", "uncertain", "publishing", "failed"):
                raise SafetyError("作业已中断或结果不确定；保留记录，请人工检查，未重新执行")
        else:
            folder = self.root / ident
            folder.mkdir(mode=0o700)
            job = {"jobId": ident, "state": "queued", "directory": str(folder),
                   "sourcePath": str(source), "sourceSHA256": sha,
                   "parentKey": req["parentKey"], "attachmentKey": req["key"],
                   "libraryID": req["libraryID"], "libraryIdentity": req["libraryIdentity"],
                   "sourceTitle": req.get("title", req["key"]), "configVersion": self.cfg["configVersion"],
                   "createdAt": time.time()}
            self.save(job)
        dt = None
        try:
            copied = Path(job["directory"]) / (ident + "-source.pdf")
            if not copied.exists():
                shutil.copyfile(source, copied)
                os.chmod(copied, 0o400)
            if digest(copied) != sha:
                raise SafetyError("工作副本哈希不匹配")
            self.check_source(job)
            job["input"] = self.inspect(copied)
            job["preflight"] = text_layer_report(job["input"])
            job["ocrPolicy"] = "all-selected"
            job["reason"] = "已有文字仅作记录，不作为跳过 OCR 的条件"
            dt = self.dt_factory()
            self.verify_targets(dt)
            if not job.get("sourceUUID"):
                self.save(job, "importing")
                prop = record_obj(dt.call("import_file", {"path": str(copied), "mode": "import",
                    "database_uuid": self.cfg["sourceDatabaseUUID"], "destination": self.cfg["sourceGroupUUID"]}))
                if prop.get("databaseUUID") != self.cfg["sourceDatabaseUUID"]:
                    raise SafetyError("导入工作副本到了错误数据库")
                job["sourceUUID"] = prop["uuid"]
                self.save(job, "imported")
            if not job.get("resultUUID"):
                self.save(job, "ocr-started")
                prop = record_obj(dt.call("ocr_record", {"uuid": job["sourceUUID"], "format": "pdf"}),
                                  different=job["sourceUUID"])
                if prop.get("databaseUUID") != self.cfg["sourceDatabaseUUID"]:
                    raise SafetyError("OCR 结果不在授权数据库")
                job["resultUUID"] = prop["uuid"]
                self.save(job, "ocr-done")
            dt.call("move_record", {"uuid": job["resultUUID"], "destination": self.cfg["resultGroupUUID"],
                                   "database_uuid": self.cfg["sourceDatabaseUUID"]})
            output = Path(job["directory"]) / "output"
            output.mkdir(exist_ok=True)
            dt.call("export_record", {"uuid": job["resultUUID"], "path": str(output)})
            files = list(output.glob("*.pdf"))
            if len(files) != 1:
                raise SafetyError("导出目录没有唯一 PDF")
            job["outputPath"] = str(files[0])
            job["output"] = self.inspect(files[0])
            job["outputSHA256"] = digest(files[0])
            if job["output"]["pages"] != job["input"]["pages"] or not any(job["output"]["chars"]):
                raise SafetyError("OCR 输出页数变化或没有可抽取文字，禁止发布")
            job["warnings"] = []
            if not all(job["output"]["chars"]):
                job["warnings"].append("部分页面没有文字，需检查空白页与遗漏")
            if job["output"]["geometry"] != job["input"]["geometry"]:
                job["warnings"].append("页面几何发生变化，需人工检查")
            self.check_source(job)
            self.save(job, "review")
            return self.summary(job)
        except Exception as error:
            job["error"] = str(error)
            self.save(job, "uncertain" if job["state"] in ("importing", "ocr-started") else "failed")
            raise
        finally:
            if dt:
                dt.close()

    def verify_attachment(self, key, job):
        meta = self.z.item(key)
        if meta.get("parentItem") != job["parentKey"] or meta.get("contentType") != "application/pdf":
            raise SafetyError("新附件父条目或类型读回不符")
        if digest(self.z.file(key)) != job["outputSHA256"]:
            raise SafetyError("新附件文件哈希读回不符")
        self.check_source(job)

    def publish(self, req):
        if req.get("approved") is not True:
            raise SafetyError("请先人工检查 OCR 结果，再确认导入")
        _, sha = self.validate_source(req)
        job = self.load(self.identity(req, sha))
        if not job:
            raise SafetyError("没有该原附件及版本对应的 OCR 作业")
        if job["state"] not in ("review", "publishing", "published", "publish-uncertain"):
            raise SafetyError("此作业不在可验收发布状态：" + job["state"])
        if digest(job["outputPath"]) != job["outputSHA256"]:
            raise SafetyError("OCR 结果文件发生变化，需重新验收")
        stable_title = "ABBYY OCR [" + job["jobId"] + "]"
        automatic_title = stable_title + " · 自动识别待复核"
        # Accept both titles so jobs created before the automatic path remains
        # recoverable.  A second matching attachment is always ambiguous.
        titles = {stable_title, automatic_title}
        matches = [x for x in self.z.children(job["parentKey"])
                   if x.get("itemType") == "attachment" and x.get("title") in titles]
        if len(matches) > 1:
            raise SafetyError("父条目下有多个同作业附件，请人工核查")
        if matches:
            key = matches[0]["key"]
        elif job["state"] != "review":
            raise SafetyError("发布结果不确定且没有匹配附件；未重复导入")
        else:
            self.save(job, "publishing")
            try:
                title = automatic_title if req.get("automatic") is True else stable_title
                key = self.z.import_file(job["parentKey"], job["outputPath"], title, job["libraryID"])
            except Exception as error:
                job["error"] = str(error)
                self.save(job, "publish-uncertain")
                raise
        try:
            self.verify_attachment(key, job)
        except Exception as error:
            job["error"] = str(error)
            job["derivedAttachmentKey"] = key
            self.save(job, "publish-uncertain")
            raise
        job["derivedAttachmentKey"] = key
        if req.get("automatic") is True:
            job["publicationMode"] = "automatic"
            job["qualityReview"] = "not-reviewed"
        self.save(job, "published")
        return self.summary(job)

    def auto(self, req):
        """Process a newly observed personal-library PDF exactly once.

        Automatic work is allowed only when both configuration gates and the
        request marker are present.  Existing publishable states go straight
        to publish so a lost response can be recovered without re-running OCR.
        """
        if self.cfg.get("autoEnabled") is not True or self.cfg.get("autoPublish") is not True:
            raise SafetyError("自动识别未启用或未允许自动追加")
        if req.get("automatic") is not True:
            raise SafetyError("自动识别请求缺少 automatic 标记")
        source, sha = self.validate_source(req)
        ident = self.identity(req, sha)
        job = self.load(ident)
        publishable = {"review", "publishing", "publish-uncertain", "published"}
        if job and job.get("state") in publishable:
            req = {**req, "approved": True, "automatic": True}
            job["publicationMode"] = "automatic"
            job["qualityReview"] = "not-reviewed"
            self.save(job)
            return self.publish(req)
        # submit performs source hashing and all OCR state transitions.  Its
        # refusal of importing/ocr-started/uncertain/failed is intentional.
        result = self.submit(req)
        job = self.load(ident)
        job["publicationMode"] = "automatic"
        job["qualityReview"] = "not-reviewed"
        self.save(job)
        return self.publish({**req, "approved": True, "automatic": True})

    def summary(self, job):
        return {k: job[k] for k in ("jobId", "state", "directory", "outputPath",
            "sourceUUID", "resultUUID", "derivedAttachmentKey", "warnings", "reason",
            "preflight", "publicationMode", "qualityReview") if k in job}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--request-file")
    parser.add_argument("--request-json")
    parser.add_argument("--response-file")
    args = parser.parse_args()
    result, status, engine = {}, 0, None
    try:
        cfg = json.loads(Path(args.config).read_text())
        req = json.loads(Path(args.request_file).read_text() if args.request_file else args.request_json)
        engine = Engine(cfg)
        with engine.locked():
            if req.get("action") == "submit":
                result = engine.submit(req)
            elif req.get("action") == "publish":
                result = engine.publish(req)
            elif req.get("action") == "auto":
                result = engine.auto(req)
            else:
                raise SafetyError("未知操作")
    except Exception as error:
        result, status = {"error": str(error)}, 1
    finally:
        if engine:
            engine.close()
    if args.response_file:
        atomic_json(args.response_file, result)
    print(json.dumps(result, ensure_ascii=False))
    return status


if __name__ == "__main__":
    sys.exit(main())
