const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const item = { id: 1, key: 'TEST0001', libraryID: 1, version: 1,
    deleted: false, erased: false, async saveTx() {}, async eraseTx() { this.erased = true; } };
  const endpoints = {};
  const context = { Zotero: {
    Server: { Endpoints: endpoints }, Libraries: { userLibraryID: 1 },
    Items: { getByLibraryAndKeyAsync: async (_, key) => key === item.key ? item : null },
    debug() {}, logError() {},
  }};
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'bootstrap.js'), 'utf8');
  vm.runInContext(code, context);
  vm.runInContext('startup()', context);
  return { endpoint: endpoints['/mcp-bridge/items/delete'], item };
}

test('public bridge refuses permanent item deletion', async () => {
  const { endpoint, item } = setup();
  const [status, , body] = await new endpoint().init({ data: { itemKey: item.key, permanent: true } });
  assert.equal(status, 500);
  assert.match(JSON.parse(body).error, /Permanent deletion/);
  assert.equal(item.deleted, false);
  assert.equal(item.erased, false);
});

test('soft deletion moves a resolved item to Zotero trash', async () => {
  const { endpoint, item } = setup();
  const [status, , body] = await new endpoint().init({ data: { itemKey: item.key, permanent: false } });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body).result.deleted, [{ key: item.key }]);
  assert.equal(item.deleted, true);
  assert.equal(item.erased, false);
});
