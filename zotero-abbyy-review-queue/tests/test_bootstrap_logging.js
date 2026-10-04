const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function harness(fail=false){
 const files=new Map(),errors=[];
 const ctx={PathUtils:path,Services:{dirsvc:{get:()=>({path:'/test'})}},Components:{interfaces:{nsIFile:{}}},Zotero:{logError:e=>errors.push(String(e))},IOUtils:{exists:async p=>files.has(p),writeUTF8:async(p,s,o={})=>{if(fail)throw Error('disk unavailable');if(o.mode==='append'&&!files.has(p))throw Error('missing');files.set(p,o.mode==='append'?files.get(p)+s:s);}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../addon/bootstrap.js'),'utf8'),ctx);
 return {ctx,files,errors};
}
test('first log creates file then appends complete JSON lines',async()=>{
 const h=harness();await h.ctx.log({event:'one'});await h.ctx.log({event:'two'});
 const lines=[...h.files.values()][0].trim().split('\n').map(JSON.parse);
 assert.deepEqual(lines.map(x=>x.event),['one','two']);assert.equal(h.errors.length,0);
});
test('log failure cannot reject a successful OCR publication',async()=>{
 const h=harness(true);await assert.doesNotReject(h.ctx.log({event:'auto-result',state:'published'}));assert.equal(h.errors.length,1);
});
