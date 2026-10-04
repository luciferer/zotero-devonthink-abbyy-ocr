/* global Zotero, Components, OS */

const BRIDGE_VERSION = "0.3.0";
const ENDPOINT_PREFIX = "/mcp-bridge";
let registeredEndpoints = [];

function startup() {
  registerEndpoints();
  Zotero.debug(`Zotero MCP Local Bridge ${BRIDGE_VERSION} started`);
}

function shutdown() {
  unregisterEndpoints();
  Zotero.debug("Zotero MCP Local Bridge stopped");
}

function install() {}
function uninstall() {}

function registerEndpoints() {
  if (!Zotero?.Server?.Endpoints) {
    throw new Error("Zotero HTTP server is not available");
  }

  registerEndpoint("/ping", ["GET", "POST"], async () => ({
    version: BRIDGE_VERSION,
    zoteroVersion: Zotero.version,
    userLibraryID: Zotero.Libraries.userLibraryID
  }));

  registerEndpoint("/items/create", ["POST"], async (req) => {
    const data = req.data.item || req.data;
    const item = new Zotero.Item(data.itemType || "journalArticle");
    item.libraryID = resolveLibraryID(req.data);
    item.fromJSON(data, { strict: false });
    await item.saveTx();
    return objectResult(item);
  });

  registerEndpoint("/items/update", ["POST"], async (req) => {
    const item = await getItem(req.data);
    await item.loadAllData();
    applyItemFields(item, req.data.fields || {});
    await item.saveTx();
    return objectResult(item);
  });

  registerEndpoint("/items/delete", ["POST"], async (req) => {
    if (req.data.permanent === true) {
      throw new Error("Permanent deletion is unavailable through this bridge");
    }
    const keys = req.data.itemKeys || (req.data.itemKey ? [req.data.itemKey] : []);
    if (!keys.length) throw new Error("itemKeys is required");

    const deleted = [];
    for (const itemKey of keys) {
      const item = await getItem({ ...req.data, itemKey });
      if (req.data.permanent) {
        await item.eraseTx();
      } else {
        item.deleted = true;
        await item.saveTx();
      }
      deleted.push({ key: itemKey });
    }
    return { deleted };
  });

  registerEndpoint("/collections/create", ["POST"], async (req) => {
    if (!req.data.name) throw new Error("name is required");
    const collection = new Zotero.Collection();
    collection.libraryID = resolveLibraryID(req.data);
    collection.fromJSON({
      name: req.data.name,
      parentCollection: req.data.parentKey || false
    });
    await collection.saveTx();
    return objectResult(collection);
  });

  registerEndpoint("/collections/update", ["POST"], async (req) => {
    const collection = getCollection(req.data);
    await collection.loadAllData();
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(req.data.fields || {}, "name")) {
      patch.name = req.data.fields.name;
    } else {
      patch.name = collection.name;
    }
    if (Object.prototype.hasOwnProperty.call(req.data.fields || {}, "parentCollection")) {
      patch.parentCollection = req.data.fields.parentCollection || false;
    } else {
      patch.parentCollection = collection.parentKey || false;
    }
    collection.fromJSON(patch);
    await collection.saveTx();
    return objectResult(collection);
  });

  registerEndpoint("/collections/delete", ["POST"], async (req) => {
    const collection = getCollection(req.data);
    await collection.eraseTx({ deleteItems: false });
    return { deleted: [{ key: req.data.collectionKey }] };
  });

  registerEndpoint("/collections/add-items", ["POST"], async (req) => {
    const collection = getCollection(req.data);
    const itemIDs = await itemIDsFromKeys(req.data);
    await Zotero.DB.executeTransaction(async () => {
      await collection.addItems(itemIDs);
    });
    return { collectionKey: collection.key, itemKeys: req.data.itemKeys || [] };
  });

  registerEndpoint("/collections/remove-items", ["POST"], async (req) => {
    const collection = getCollection(req.data);
    const itemIDs = await itemIDsFromKeys(req.data);
    await Zotero.DB.executeTransaction(async () => {
      await collection.removeItems(itemIDs);
    });
    return { collectionKey: collection.key, itemKeys: req.data.itemKeys || [] };
  });

  registerEndpoint("/attachments/import-file", ["POST"], async (req) => {
    if (!req.data.parentKey) throw new Error("parentKey is required");
    if (!req.data.filePath) throw new Error("filePath is required");
    const parent = await getItem({ ...req.data, itemKey: req.data.parentKey });
    const attachment = await Zotero.Attachments.importFromFile({
      file: req.data.filePath,
      parentItemID: parent.id,
      title: req.data.title,
      contentType: req.data.contentType
    });
    return objectResult(attachment);
  });

  registerEndpoint("/attachments/link-file", ["POST"], async (req) => {
    if (!req.data.parentKey) throw new Error("parentKey is required");
    if (!req.data.filePath) throw new Error("filePath is required");
    const parent = await getItem({ ...req.data, itemKey: req.data.parentKey });
    const attachment = await Zotero.Attachments.linkFromFile({
      file: req.data.filePath,
      parentItemID: parent.id,
      title: req.data.title,
      contentType: req.data.contentType
    });
    return objectResult(attachment);
  });

  registerEndpoint("/attachments/link-url", ["POST"], async (req) => {
    if (!req.data.parentKey) throw new Error("parentKey is required");
    if (!req.data.url) throw new Error("url is required");
    const parent = await getItem({ ...req.data, itemKey: req.data.parentKey });
    const attachment = await Zotero.Attachments.linkFromURL({
      url: req.data.url,
      parentItemID: parent.id,
      title: req.data.title,
      contentType: req.data.contentType
    });
    return objectResult(attachment);
  });
}

function unregisterEndpoints() {
  for (const path of registeredEndpoints) {
    delete Zotero.Server.Endpoints[path];
  }
  registeredEndpoints = [];
}

function registerEndpoint(path, methods, handler) {
  const fullPath = ENDPOINT_PREFIX + path;
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: methods,
    supportedDataTypes: ["application/json"],
    permitBookmarklet: false,
    allowRequestsFromUnsafeWebContent: false,
    init: async function (req) {
      try {
        const result = await handler(req);
        return json(200, { ok: true, result });
      } catch (e) {
        Zotero.logError(e);
        return json(500, {
          ok: false,
          error: e && e.message ? e.message : String(e)
        });
      }
    }
  };
  Zotero.Server.Endpoints[fullPath] = Endpoint;
  registeredEndpoints.push(fullPath);
}

function json(status, payload) {
  return [status, "application/json", JSON.stringify(payload)];
}

function resolveLibraryID(data) {
  if (data.libraryType === "group") {
    const groupID = Number(data.libraryID || data.groupID);
    const group = Zotero.Groups.get(groupID);
    if (!group) throw new Error(`Group not found: ${groupID}`);
    return group.libraryID;
  }
  return Zotero.Libraries.userLibraryID;
}

async function getItem(data) {
  const itemKey = data.itemKey || data.key;
  if (!itemKey) throw new Error("itemKey is required");
  const item = await Zotero.Items.getByLibraryAndKeyAsync(resolveLibraryID(data), itemKey);
  if (!item) throw new Error(`Item not found: ${itemKey}`);
  return item;
}

function getCollection(data) {
  if (!data.collectionKey) throw new Error("collectionKey is required");
  const collection = Zotero.Collections.getByLibraryAndKey(
    resolveLibraryID(data),
    data.collectionKey
  );
  if (!collection) throw new Error(`Collection not found: ${data.collectionKey}`);
  return collection;
}

async function itemIDsFromKeys(data) {
  const keys = data.itemKeys || [];
  if (!keys.length) throw new Error("itemKeys is required");
  const ids = [];
  for (const itemKey of keys) {
    const item = await getItem({ ...data, itemKey });
    ids.push(item.id);
  }
  return ids;
}

function objectResult(obj) {
  return {
    id: obj.id,
    key: obj.key,
    libraryID: obj.libraryID,
    version: obj.version
  };
}

function applyItemFields(item, fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (field === "key" || field === "version" || field === "itemType") {
      continue;
    }
    if (field === "creators") {
      item.setCreators(value || []);
      continue;
    }
    if (field === "tags") {
      item.setTags(value || []);
      continue;
    }
    if (field === "collections") {
      item.setCollections(value || []);
      continue;
    }
    if (field === "parentItem") {
      item.parentKey = value || false;
      continue;
    }
    if (field === "note") {
      item.setNote(value || "");
      continue;
    }
    if (field === "deleted") {
      item.deleted = !!value;
      continue;
    }
    if (isAttachmentField(field)) {
      setAttachmentField(item, field, value);
      continue;
    }
    if (!Zotero.ItemFields.getID(field)) {
      throw new Error(`Unknown item field: ${field}`);
    }
    item.setField(field, value || false);
  }
}

function isAttachmentField(field) {
  return field === "linkMode" ||
    field === "filename" ||
    field === "contentType" ||
    field === "charset" ||
    field === "path";
}

function setAttachmentField(item, field, value) {
  if (field === "linkMode") {
    const linkMode = Zotero.Attachments[`LINK_MODE_${String(value).toUpperCase()}`];
    if (linkMode === undefined) throw new Error(`Unknown attachment link mode: ${value}`);
    item.attachmentLinkMode = linkMode;
    return;
  }
  if (field === "filename") {
    item.attachmentFilename = value;
    return;
  }
  item[`attachment${field[0].toUpperCase()}${field.slice(1)}`] = value;
}
