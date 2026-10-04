/* global Zotero, Services, Components, IOUtils, PathUtils */
const PREFIX = "abbyy-review-queue-";
let alive = false, busy = false, dispatcher = null, observerID = null;
let logChain = Promise.resolve();
const windows = new Set();
const popupHandlers = new Map();

function rootPath() {
  return PathUtils.join(Services.dirsvc.get("Home", Components.interfaces.nsIFile).path,
    ".local", "share", "zotero-devonthink-ocr");
}
function file(name) { return PathUtils.join(rootPath(), name); }
async function config() { return JSON.parse(await IOUtils.readUTF8(file("config.json"))); }
async function writeJSON(path, value) {
  const tmp = path + ".tmp";
  await IOUtils.writeUTF8(tmp, JSON.stringify(value, null, 2));
  await IOUtils.move(tmp, path, {noOverwrite:false});
}
function identity() { return String(Zotero.DataDirectory.dir) + ":personal"; }
function notify(title, text) {
  if (!alive) return;
  const p = new Zotero.ProgressWindow({closeOnClick:true});
  p.changeHeadline(title);
  p.addDescription(String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"));
  p.show();
  p.startCloseTimer(14000);
}
async function log(data) {
  logChain = logChain.catch(() => {}).then(async () => {
    const path = file("auto-log.jsonl");
    // IOUtils append requires an existing file. Logging must not relabel a
    // successfully published attachment as an OCR failure.
    if (!await IOUtils.exists(path)) await IOUtils.writeUTF8(path, "");
    await IOUtils.writeUTF8(path,
      JSON.stringify({at:new Date().toISOString(),...data}) + "\n", {mode:"append"});
  }).catch(error => Zotero.logError(error));
  return logChain;
}
function dateAddedMillis(value) {
  if (!value) return null;
  const s = String(value);
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(" ","T")+"Z" : s);
}
async function describeItem(id) {
  const item = await Zotero.Items.getAsync(Number(id));
  if (!item) return null;
  const attachment = item.isAttachment();
  let path = null;
  if (attachment) {
    try { path = await item.getFilePathAsync(); } catch (_) {}
  }
  return {id:item.id,key:item.key,libraryID:item.libraryID,
    personal:item.libraryID===Zotero.Libraries.userLibraryID,attachment,
    deleted:!!item.deleted,parentKey:item.parentKey,
    contentType:attachment?item.attachmentContentType:null,
    filePath:path,title:item.getField("title")||item.key,dateAdded:dateAddedMillis(item.dateAdded)};
}
async function executeWorker(cfg, req) {
  const dir = file("ui-requests");
  await IOUtils.makeDirectory(dir,{ignoreExisting:true});
  const nonce = Services.uuid.generateUUID().toString().replace(/[{}]/g,"");
  const input = PathUtils.join(dir,nonce+".json"), output = PathUtils.join(dir,nonce+".response.json");
  await IOUtils.writeUTF8(input,JSON.stringify(req));
  let failure;
  try {
    await Zotero.Utilities.Internal.exec(cfg.python,[cfg.worker,"--config",file("config.json"),
      "--request-file",input,"--response-file",output]);
  } catch(e) { failure = e; }
  if (!await IOUtils.exists(output)) {
    return {error:"没有收到任务回执，请检查作业记录，勿盲目重试。" + (failure?.message||"")};
  }
  return JSON.parse(await IOUtils.readUTF8(output));
}
async function startup({rootURI,version}) {
  alive = true;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (!alive) return;
  try {
    const scope = {};
    Services.scriptloader.loadSubScript(rootURI+"auto-dispatcher.js",scope);
    dispatcher = new scope.AutoDispatcher({
      now:()=>Date.now(),identity,config,busy:()=>busy,setBusy,
      item:describeItem,
      stat:async path=>{
        if(!await IOUtils.exists(path)) return null;
        const s=await IOUtils.stat(path);
        return {size:s.size,mtime:s.lastModified};
      },
      load:async()=>await IOUtils.exists(file("auto-pending.json"))
        ? JSON.parse(await IOUtils.readUTF8(file("auto-pending.json"))) : {version:1,tasks:{}},
      save:value=>writeJSON(file("auto-pending.json"),value),
      setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:id=>clearTimeout(id),
      execute:executeWorker,notify,log
    });
    await dispatcher.start();
    observerID = Zotero.Notifier.registerObserver({
      notify(event,type,ids) {
        if(type==="item" && ["add","modify"].includes(event)) {
          dispatcher.observe(event,ids).catch(e=>log({event:"observer-error",error:String(e)}));
        }
      }
    },["item"],"abbyy-review-queue",100);
    await writeJSON(file("auto-status.json"),{version,observing:true,startedAt:new Date().toISOString()});
  } catch(e) {
    dispatcher?.stop();
    await log({event:"startup-error",error:String(e)});
    notify("ABBYY 自动队列未启动",String(e));
  }
  for(const win of Zotero.getMainWindows()) addMenus(win);
}
function onMainWindowLoad({window}) { if(alive) addMenus(window); }
function onMainWindowUnload({window}) { removeMenus(window); }
function install() {}
function uninstall() {}
async function shutdown() {
  alive=false;
  dispatcher?.stop();
  if(observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID=null;
  for(const win of Array.from(windows)) removeMenus(win);
  try { await writeJSON(file("auto-status.json"),{observing:false,stoppedAt:new Date().toISOString()}); } catch(_) {}
}
function addMenus(win) {
  const popup=win.document.getElementById("menu_ToolsPopup");
  if(!popup || win.document.getElementById(PREFIX+"submit")) return;
  windows.add(win);
  const separator=win.document.createXULElement("menuseparator");
  separator.id=PREFIX+"separator";popup.appendChild(separator);
  for(const [action,label] of [["submit","提交所选 PDF 到 ABBYY OCR"],
    ["publish","导入已验收 OCR 结果"],["auto","新增 PDF 自动识别并追加"]]) {
    const el=win.document.createXULElement("menuitem");
    el.id=PREFIX+action;el.setAttribute("label",label);
    if(action==="auto") {
      el.setAttribute("type","checkbox");
      el.addEventListener("command",()=>toggleAuto(win));
    } else {
      el.disabled=busy;
      el.addEventListener("command",()=>run(win,action));
    }
    popup.appendChild(el);
  }
  const refresh=()=>refreshAuto(win);
  popup.addEventListener("popupshowing",refresh);
  popupHandlers.set(win,refresh);
  refreshAuto(win);
}
function removeMenus(win) {
  const popup=win.document.getElementById("menu_ToolsPopup");
  const fn=popupHandlers.get(win);
  if(fn) popup?.removeEventListener("popupshowing",fn);
  popupHandlers.delete(win);
  for(const suffix of ["separator","submit","publish","auto"]) win.document.getElementById(PREFIX+suffix)?.remove();
  windows.delete(win);
}
function setBusy(value) {
  busy=value;
  for(const win of windows) for(const action of ["submit","publish"]) {
    const el=win.document.getElementById(PREFIX+action);if(el) el.disabled=value;
  }
}
async function refreshAuto(win) {
  try {
    const cfg=await config(),el=win.document.getElementById(PREFIX+"auto");
    el?.setAttribute("checked",String(cfg.autoEnabled===true && cfg.autoPublish===true));
  } catch(_) {}
}
async function toggleAuto(win) {
  try {
    const cfg=await config();
    cfg.autoEnabled=!(cfg.autoEnabled && cfg.autoPublish);
    cfg.autoPublish=true;
    if(cfg.autoEnabled) cfg.autoEnabledAt=new Date().toISOString();
    await writeJSON(file("config.json"),cfg);
    for(const window of windows) await refreshAuto(window);
    if(cfg.autoEnabled) dispatcher?.schedule();
    notify("ABBYY 自动队列",cfg.autoEnabled
      ?"已开启：今后新增个人库 PDF 将自动识别并追加；已有文库不会被扫描。"
      :"已停止接收新任务；当前正在处理的任务会安全完成。");
  } catch(e) { Services.prompt.alert(win,"ABBYY 自动队列",e.message||String(e)); }
}
async function selection(win) {
  const items=win.ZoteroPane.getSelectedItems();
  if(!items?.length) throw new Error("请在文库列表中选中个人库 PDF 子附件。");
  const requests=[];
  for(const item of items) {
    if(!item.isAttachment() || item.libraryID!==Zotero.Libraries.userLibraryID ||
      item.attachmentContentType!=="application/pdf" || !item.parentKey) {
      throw new Error("仅支持个人库中已有父条目的 PDF 子附件。本次未提交文件。");
    }
    const path=await item.getFilePathAsync();
    if(!path || !await IOUtils.exists(path)) throw new Error("有附件尚未下载或不存在。");
    requests.push({key:item.key,parentKey:item.parentKey,path,title:item.getField("title")||item.key,
      libraryID:item.libraryID,libraryIdentity:identity()});
  }
  return requests;
}
async function run(win,action) {
  if(busy) return;
  setBusy(true);
  try {
    const requests=await selection(win),cfg=await config();
    if(action==="publish" && !Services.prompt.confirm(win,"ABBYY OCR 结果验收",
      "确认已检查 OCR 输出。结果会作为同父条目的新附件，原件保留。\n结果目录："+cfg.requestsDir)) return;
    const automatic=action==="submit" && cfg.autoEnabled===true && cfg.autoPublish===true;
    const lines=[];
    for(const req of requests) {
      const result=await executeWorker(cfg,{...req,action:automatic?"auto":action,
        automatic,approved:automatic||action==="publish"});
      if(result.error) throw new Error(result.error);
      lines.push(req.title+"："+(result.state==="published"?"已追加 OCR 新附件，文字内容待复核":"OCR 完成，等待验收"));
    }
    notify("ABBYY OCR 任务完成",lines.join("\n"));
  } catch(e) { Services.prompt.alert(win,"ABBYY OCR 队列",e.message||String(e)); }
  finally {setBusy(false);dispatcher?.schedule();}
}
