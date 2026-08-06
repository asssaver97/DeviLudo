import assert from "node:assert/strict";
import test from "node:test";
import { cachedValue, clearClientCache, expireCached, loadCached, storeCached } from "../lib/product/client-cache";

test("client cache coalesces concurrent reads and reuses fresh data",async()=>{
  clearClientCache();
  let reads=0;
  let release:(value:string)=>void=()=>undefined;
  const pending=new Promise<string>(resolve=>{release=resolve;});
  const loader=()=>{reads++;return pending;};
  const first=loadCached("projects",10_000,loader);
  const second=loadCached("projects",10_000,loader);
  assert.equal(reads,1);
  release("value");
  assert.deepEqual(await Promise.all([first,second]),["value","value"]);
  assert.equal(await loadCached("projects",10_000,async()=>"unexpected"),"value");
  assert.equal(reads,1);
});

test("expired data stays renderable while one background refresh replaces it",async()=>{
  clearClientCache();
  storeCached("project:1","stale",10_000);
  expireCached("project:1");
  assert.equal(cachedValue("project:1"),"stale");
  let reads=0;
  const refreshed=await Promise.all([
    loadCached("project:1",10_000,async()=>{reads++;return"fresh";}),
    loadCached("project:1",10_000,async()=>{reads++;return"duplicate";}),
  ]);
  assert.deepEqual(refreshed,["fresh","fresh"]);
  assert.equal(reads,1);
  assert.equal(cachedValue("project:1"),"fresh");
});
