import {randomUUID} from "node:crypto";
import {test,expect} from "../fixtures/stack";

test("standalone exposes one fixed local workspace and idempotent project creation",async({stack})=>{
  const initial=await stack.web("/api/session");
  const session=await initial.json() as {session:{authenticated:boolean;authMode:string;canLogout:boolean;selectedWorkspace:{id:string;name:string}}};
  expect(session.session).toMatchObject({authenticated:true,authMode:"STANDALONE",canLogout:false,selectedWorkspace:{name:"Local workspace"}});
  const workspaces=await (await stack.web("/api/workspaces")).json() as {workspaces:Array<{id:string}>};
  expect(workspaces.workspaces).toHaveLength(1);
  expect(workspaces.workspaces[0]?.id).toBe(session.session.selectedWorkspace.id);
  expect((await stack.web("/api/workspaces",{method:"POST",data:{name:"forbidden"}})).status()).toBe(404);

  const key=`standalone-project:${randomUUID()}`;
  const input={name:"潮汐档案",concept:"玩家调查一座每天重置记忆的海边档案馆。"};
  const first=await stack.web("/api/projects",{method:"POST",data:input,headers:{"idempotency-key":key}});
  expect(first.status()).toBe(201);
  const firstBody=await first.json() as {workspace:{id:string};project:{id:string}};
  expect(firstBody.workspace.id).toBe(session.session.selectedWorkspace.id);
  const replay=await stack.web("/api/projects",{method:"POST",data:input,headers:{"idempotency-key":key}});
  expect(replay.status()).toBe(200);
  expect((await replay.json() as typeof firstBody).project.id).toBe(firstBody.project.id);
});
