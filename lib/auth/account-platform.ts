const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ROLES=new Set(["TenantAdmin","ProjectOwner","Auditor"]);
const SECURE_COOKIE="__Host-deviludo-session";
const LOCAL_COOKIE="deviludo-session";

export interface AccountPlatformSession {
  readonly tenantId:string;
  readonly tenantSlug:string;
  readonly tenantName:string;
  readonly userId:string;
  readonly membershipId:string;
  readonly role:"TenantAdmin"|"ProjectOwner"|"Auditor";
  readonly displayName:string;
  readonly avatarUrl:string;
  readonly sessionBinding:string;
  readonly githubUserId:number;
  readonly githubLinked:boolean;
}

export class AccountPlatformClient{
  readonly #origin:URL;readonly #token:string;readonly #fetch:typeof fetch;
  constructor(options:{endpoint:string;serviceToken:string;allowInsecureLocal?:boolean;fetch?:typeof fetch}){const endpoint=new URL(options.endpoint);const local=options.allowInsecureLocal===true&&endpoint.protocol==="http:"&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash;if((endpoint.protocol!=="https:"&&!local)||endpoint.pathname!=="/"||!options.serviceToken||options.serviceToken.length>512)throw new Error("Account Platform configuration is invalid");this.#origin=endpoint;this.#token=options.serviceToken;this.#fetch=options.fetch??fetch;}
  async assert(sessionToken:string):Promise<AccountPlatformSession>{if(!/^[A-Za-z0-9_.-]{32,160}$/.test(sessionToken))throw new Error("Account Platform session is invalid");let response:Response;try{response=await this.#fetch(new URL("/internal/v1/sessions/assert",this.#origin),{method:"POST",redirect:"error",headers:{accept:"application/json","content-type":"application/json",authorization:`Bearer ${this.#token}`},body:JSON.stringify({sessionToken}),signal:AbortSignal.timeout(15_000)});}catch{throw new Error("Account Platform is unavailable");}if(!response.ok)throw new Error("Account Platform rejected the session");const value=await response.json() as {data?:{principal?:Record<string,unknown>;githubUserId?:unknown}};const principal=value.data?.principal;if(!principal)throw new Error("Account Platform response is invalid");const tenantId=uuid(principal.workspaceId);const userId=uuid(principal.accountId);const membershipId=uuid(principal.membershipId);const sessionBinding=uuid(principal.sessionId);const role=principal.platformRole;if(typeof role!=="string"||!ROLES.has(role))throw new Error("Account Platform response is invalid");const linked=Number.isSafeInteger(value.data?.githubUserId)&&Number(value.data?.githubUserId)>0;const synthetic=Number.parseInt(userId.replaceAll("-","").slice(0,12),16)||1;const githubUserId=linked?Number(value.data?.githubUserId):synthetic;const avatar=typeof principal.avatarUrl==="string"&&principal.avatarUrl.startsWith("https://")?principal.avatarUrl:`https://avatars.githubusercontent.com/u/${githubUserId}`;return Object.freeze({tenantId,tenantSlug:text(principal.workspaceSlug,100),tenantName:text(principal.workspaceName,160),userId,membershipId,role:role as AccountPlatformSession["role"],displayName:text(principal.displayName,160),avatarUrl:avatar,sessionBinding,githubUserId,githubLinked:linked});}
}

export function accountPlatformClientFromEnvironment(env:Readonly<Record<string,string|undefined>>=process.env):AccountPlatformClient|null{const endpoint=env.DEVILUDO_ACCOUNT_API_URL?.trim();if(!endpoint)return null;const serviceToken=env.DEVILUDO_INTERNAL_SERVICE_TOKEN?.trim();if(!serviceToken)throw new Error("DEVILUDO_INTERNAL_SERVICE_TOKEN is required");return new AccountPlatformClient({endpoint,serviceToken,allowInsecureLocal:env.DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL==="1"});}
export function accountSessionToken(request:Request):string{const values=new Map<string,string>();for(const part of (request.headers.get("cookie")??"").split(";")){const index=part.indexOf("=");if(index<1)continue;const name=part.slice(0,index).trim();if(values.has(name))throw new Error("Duplicate account session cookie");values.set(name,part.slice(index+1).trim());}const token=values.get(SECURE_COOKIE)??values.get(LOCAL_COOKIE);if(!token)throw new Error("Account session cookie is missing");return token;}
export async function accountPlatformSessionFromRequest(request:Request):Promise<AccountPlatformSession|null>{const client=accountPlatformClientFromEnvironment();return client?client.assert(accountSessionToken(request)):null;}
function uuid(value:unknown):string{if(typeof value!=="string"||!UUID.test(value))throw new Error("Account Platform response is invalid");return value;}
function text(value:unknown,max:number):string{if(typeof value!=="string"||!value||value.length>max||/[\0-\x1f\x7f]/.test(value))throw new Error("Account Platform response is invalid");return value;}

