import {randomUUID} from "node:crypto";
import {test,expect} from "../fixtures/stack";

test("self-hosted mode exposes one local instance and idempotent project creation",async({stack})=>{
  const initial=await stack.web("/api/instance");
  const body=await initial.json() as {instance:{mode:string;workspace:{id:string;name:string}}};
  expect(body.instance).toMatchObject({mode:"SELF_HOSTED",workspace:{name:"Local workspace"}});
  expect((await stack.web("/api/workspaces")).status()).toBe(404);

  const key=`standalone-project:${randomUUID()}`;
  const input={name:"潮汐档案",concept:"玩家调查一座每天重置记忆的海边档案馆。"};
  const first=await stack.web("/api/projects",{method:"POST",data:input,headers:{"idempotency-key":key}});
  expect(first.status()).toBe(201);
  const firstBody=await first.json() as {workspace:{id:string};project:{id:string}};
  expect(firstBody.workspace.id).toBe(body.instance.workspace.id);
  const replay=await stack.web("/api/projects",{method:"POST",data:input,headers:{"idempotency-key":key}});
  expect(replay.status()).toBe(200);
  expect((await replay.json() as typeof firstBody).project.id).toBe(firstBody.project.id);
});
