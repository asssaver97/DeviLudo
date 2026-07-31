import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyRequest } from "fastify";
import { AccessResolver,STANDALONE_ACCOUNT_ID,STANDALONE_WORKSPACE_ID } from "../services/core/src/access";
import type { CoreConfig } from "../services/core/src/config";

function request(cookie?:string):FastifyRequest{return{headers:cookie?{cookie}:{}} as FastifyRequest;}
function config(accessMode:"standalone"|"platform"):CoreConfig{return{accessMode,platformAccountApiUrl:"http://account.internal",platformInternalToken:"service-token"} as CoreConfig;}

test("standalone access always resolves the fixed unrestricted local principal",async()=>{
  const principal=await new AccessResolver(config("standalone")).resolve(request());
  assert.equal(principal.user.id,STANDALONE_ACCOUNT_ID);
  assert.equal(principal.workspace.id,STANDALONE_WORKSPACE_ID);
  assert.equal(principal.role,"OWNER");
  assert.equal(principal.user.instanceAdmin,true);
});

test("platform access asserts opaque session state, caches reads, and refreshes mutations",async()=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=(async(_input,init)=>{calls+=1;assert.equal((init?.headers as Record<string,string>).authorization,"Bearer service-token");return Response.json({data:{principal:{accountId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",displayName:"Player",workspaceId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",workspaceName:"Organization",role:"Admin",sessionId:"session"},platformAdminRoles:["PlatformAgentAdmin"]}});}) as typeof fetch;
  try{
    const resolver=new AccessResolver(config("platform"));
    const browser=request("deviludo-session=opaque");
    const first=await resolver.resolve(browser);
    const cached=await resolver.resolve(browser);
    const refreshed=await resolver.resolve(browser,true);
    assert.equal(first.workspace.name,"Organization");assert.equal(first.role,"ADMIN");assert.equal(first.user.instanceAdmin,true);
    assert.equal(cached,first);assert.notEqual(refreshed,first);assert.equal(calls,2);
  }finally{globalThis.fetch=originalFetch;}
});

test("platform access fails closed without a session or when the authority is unavailable",async()=>{
  const resolver=new AccessResolver(config("platform"));
  await assert.rejects(resolver.resolve(request()),error=>(error as {statusCode?:number}).statusCode===401);
  const originalFetch=globalThis.fetch;globalThis.fetch=(async()=>{throw new Error("offline");}) as typeof fetch;
  try{await assert.rejects(resolver.resolve(request("deviludo-session=opaque")),error=>(error as {statusCode?:number}).statusCode===503);}
  finally{globalThis.fetch=originalFetch;}
});
