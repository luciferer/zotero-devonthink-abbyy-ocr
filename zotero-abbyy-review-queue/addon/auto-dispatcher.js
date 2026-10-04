/* Pure dispatcher; application/filesystem operations are injected. */
var AutoDispatcher = class AutoDispatcher {
  constructor(deps) {
    this.d = deps;
    this.tasks = {};
    this.alive = false;
    this.running = false;
    this.timer = null;
    this.saveChain = Promise.resolve();
    this.delay = deps.delayMs || 3000;
    this.maxWaits = deps.maxWaits || 30;
    this.longWaitDelay = deps.longWaitDelayMs || 60000;
  }
  async start() {
    const saved = await this.d.load();
    this.tasks = saved?.tasks || {};
    for (const task of Object.values(this.tasks)) {
      if (task.state === "running" || task.state === "waiting-file") {
        task.state = "waiting";
        task.attempts = 0;
        task.dueAt = this.d.now() + this.delay;
        task.recovered = true;
      }
    }
    this.alive = true;
    await this.persist();
    this.schedule();
  }
  stop() {
    this.alive = false;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }
  async persist() {
    const state = JSON.parse(JSON.stringify({version: 1, tasks: this.tasks}));
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.d.save(state));
    return this.saveChain;
  }
  derived(item) { return /^ABBYY OCR \[[0-9a-f]+\]/i.test(item?.title || ""); }
  invalid(item) {
    return item && (item.deleted || !item.personal || !item.attachment || this.derived(item));
  }
  async observe(event, ids) {
    if (!this.alive || !["add","modify"].includes(event)) return;
    const cfg = await this.d.config();
    if (!cfg.autoEnabled || !cfg.autoPublish) return;
    for (const id of ids) {
      const taskID = String(id);
      let task = this.tasks[taskID];
      if (event === "modify") {
        // A historical item's modification never creates an automatic task.
        if (!task || !["waiting","waiting-file"].includes(task.state)) continue;
        task.state = "waiting";
        task.attempts = 0;
        task.dueAt = this.d.now() + this.delay;
        continue;
      }
      if (task) continue;
      const item = await this.d.item(id);
      if (this.invalid(item)) continue;
      if (item?.contentType && item.contentType !== "application/pdf") continue;
      const cutoff = Date.parse(cfg.autoEnabledAt || "");
      if (Number.isFinite(cutoff) && item?.dateAdded &&
          item.dateAdded < cutoff - 2000) continue;
      // Recheck after awaited item lookup to dedupe overlapping add events.
      if (this.tasks[taskID]) continue;
      this.tasks[taskID] = {itemID: Number(id), key: item?.key || null,
        identity: this.d.identity(), capturedAt: this.d.now(), state: "waiting",
        attempts: 0, dueAt: this.d.now() + this.delay};
    }
    await this.persist();
    this.schedule();
  }
  schedule() {
    if (!this.alive || this.running || this.timer !== null) return;
    const waiting = Object.values(this.tasks).filter(x => ["waiting","waiting-file"].includes(x.state));
    if (!waiting.length) return;
    const next = Math.min(...waiting.map(x => x.dueAt || 0));
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      this.tick().catch(e => this.d.log({event:"scheduler-error",error:String(e)}));
    }, Math.max(50, next - this.d.now()));
  }
  async wait(task, reason) {
    task.attempts++;
    task.reason = reason;
    task.state = task.attempts >= this.maxWaits ? "waiting-file" : "waiting";
    task.dueAt = this.d.now() + (task.state === "waiting-file" ? this.longWaitDelay : this.delay);
    await this.persist();
  }
  async tick() {
    if (!this.alive || this.running) return;
    const cfg = await this.d.config();
    if (!cfg.autoEnabled || !cfg.autoPublish) return;
    if (this.d.busy()) {
      for (const task of Object.values(this.tasks)) {
        if (["waiting","waiting-file"].includes(task.state)) task.dueAt = Math.max(task.dueAt, this.d.now() + this.delay);
      }
      this.schedule();
      return;
    }
    const task = Object.values(this.tasks).filter(x => ["waiting","waiting-file"].includes(x.state) && x.dueAt <= this.d.now())
      .sort((a,b) => a.capturedAt - b.capturedAt)[0];
    if (!task) { this.schedule(); return; }
    this.running = true;
    try {
      if (task.identity !== this.d.identity()) throw new Error("任务属于另一 Zotero 数据目录，未处理");
      const item = await this.d.item(task.itemID);
      if (this.invalid(item)) {
        task.state = "ignored";
        await this.persist();
        return;
      }
      if (!item || !item.key || !item.parentKey || !item.filePath ||
          !item.contentType) {
        await this.wait(task, "等待附件元数据、父条目或本地文件");
        return;
      }
      if (item.contentType !== "application/pdf") {
        task.state = "ignored"; await this.persist(); return;
      }
      if (task.key && task.key !== item.key) throw new Error("附件身份发生变化");
      task.key = item.key;
      const stat = await this.d.stat(item.filePath);
      if (!stat || stat.size <= 0) {
        await this.wait(task, "等待文件下载");
        return;
      }
      const same = task.lastStat?.path === item.filePath &&
        task.lastStat.size === stat.size && task.lastStat.mtime === stat.mtime;
      if (!same || this.d.now() - task.lastStat.at < this.delay) {
        task.lastStat = {path:item.filePath,size:stat.size,mtime:stat.mtime,at:this.d.now()};
        task.attempts = 0;
        await this.wait(task, "等待文件大小和修改时间稳定");
        return;
      }
      task.state = "running";
      task.startedAt = this.d.now();
      await this.persist();
      const req = {action:"auto",automatic:true,approved:true,key:item.key,
        parentKey:item.parentKey,path:item.filePath,title:item.title || item.key,
        libraryID:item.libraryID,libraryIdentity:task.identity};
      this.d.setBusy(true);
      const result = await this.d.execute(cfg,req);
      // If Zotero/addon shuts down, the saved running task is reconciled on startup.
      if (!this.alive) return;
      task.result = result;
      task.finishedAt = this.d.now();
      if (result.error) {
        task.state = "error";
        task.error = result.error;
        await this.d.log({event:"auto-error",key:item.key,error:result.error});
        this.d.notify("ABBYY 自动处理待检查",item.title + "：" + result.error);
      } else {
        task.state = result.state === "published" ? "published" : "needs-attention";
        await this.d.log({event:"auto-result",key:item.key,jobId:result.jobId,state:result.state});
        if (result.state === "published") {
          this.d.notify("ABBYY 自动识别完成",item.title + "：已追加 OCR 附件，科学内容仍待复核。");
        } else {
          this.d.notify("ABBYY 自动处理待检查",item.title + "：结果状态 " + result.state + "，尚未确认追加完成。");
        }
      }
      await this.persist();
    } catch (e) {
      task.state = "error";
      task.error = String(e);
      await this.persist();
      await this.d.log({event:"dispatcher-error",key:task.key,error:String(e)});
      this.d.notify("ABBYY 自动处理待检查",String(e));
    } finally {
      this.d.setBusy(false);
      this.running = false;
      this.schedule();
    }
  }
};
if (typeof module !== "undefined") module.exports = {AutoDispatcher};
