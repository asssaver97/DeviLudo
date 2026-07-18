import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SteamEnrollmentView } from "./enrollment-contracts";
import type { ReleaseAuthorizationView } from "./release-authorization-contracts";
import { SteamAccessUiSessionSigner, SteamAccessUiSessionVerifier, type SteamAccessUiAction } from "./steam-access-ui-session";
import type {
  SteamReleaseWebAuthnOptions,
  SteamSecureUiBrowserSession,
  SteamSecureUiPrincipal,
} from "./steam-secure-ui-clients";
import { steamSecureUiBrowserSession } from "./steam-secure-ui-clients";

const ENROLLMENT_ID = /^[a-f0-9-]{36}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface SteamSecureUiIdentityPort {
  assert(session: SteamSecureUiBrowserSession, pathname: string, method: "GET" | "POST"): Promise<SteamSecureUiPrincipal>;
}

export interface SteamSecureUiAccessPort {
  submitCredentials(input: Readonly<{ enrollmentId: string; accountName: string; password: Uint8Array; uiSession: string }>): Promise<SteamEnrollmentView>;
  submitGuard(input: Readonly<{ enrollmentId: string; guardCode: Uint8Array; uiSession: string }>): Promise<SteamEnrollmentView>;
  completeApproval(input: Readonly<{ approvalId: string; assertion: unknown; uiSession: string }>): Promise<ReleaseAuthorizationView>;
}

export interface SteamSecureUiWebAuthnPort {
  begin(input: Readonly<{ approvalId: string; tenantId: string; userId: string }>): Promise<SteamReleaseWebAuthnOptions>;
}

export function registerSteamSecureUiRoutes(server: FastifyInstance, options: Readonly<{
  publicOrigin: string;
  identity: SteamSecureUiIdentityPort;
  access: SteamSecureUiAccessPort;
  webauthn: SteamSecureUiWebAuthnPort;
  sessions: SteamAccessUiSessionSigner;
  sessionVerifier: SteamAccessUiSessionVerifier;
}>): void {
  const origin = rootHttpsOrigin(options.publicOrigin);
  if (!server.hasContentTypeParser("application/octet-stream")) {
    server.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 2 * 1024 }, (_request, body, done) => done(null, body));
  }

  server.get("/enrollments/:enrollmentId", async (request, reply) => {
    const enrollmentId = enrollmentIdFrom(request);
    if (!enrollmentId) return htmlError(reply, 404, "登记链接无效", "请返回 DeviLudo 重新发起 Steam Guard 登记。");
    const principal = await browserPrincipal(options.identity, request, identityPath("enrollments", enrollmentId), "GET");
    if (!principal) return htmlError(reply, 401, "请先登录 DeviLudo", "当前 Steam 登记链接需要原平台会话确认。");
    const credentialSession = issue(options.sessions, principal, "STEAM_ENROLLMENT", enrollmentId, "SUBMIT_CREDENTIALS");
    const guardSession = issue(options.sessions, principal, "STEAM_ENROLLMENT", enrollmentId, "SUBMIT_GUARD_CODE");
    return html(reply, enrollmentPage({ enrollmentId, displayName: principal.displayName, credentialSession, guardSession }), false);
  });

  server.post("/v1/steam-ui/enrollments/:enrollmentId/credentials", {
    bodyLimit: 1024,
    onRequest: binaryOnly,
  }, async (request, reply) => {
    secureApi(reply);
    const enrollmentId = enrollmentIdFrom(request);
    const password = rawBytes(request.body);
    try {
      if (!enrollmentId || !sameOrigin(request, origin)) return apiError(reply, 403, "STEAM_UI_REQUEST_REJECTED");
      const principal = await browserPrincipal(options.identity, request, identityPath("enrollments", enrollmentId), "POST");
      if (!principal) return apiError(reply, 401, "STEAM_UI_SESSION_REQUIRED");
      const uiSession = request.headers["x-deviludo-steam-ui-session"];
      if (typeof uiSession !== "string" || !matchesSession(options.sessionVerifier, request, principal,
        "STEAM_ENROLLMENT", enrollmentId, "SUBMIT_CREDENTIALS")) return apiError(reply, 401, "STEAM_UI_CAPABILITY_REQUIRED");
      const accountName = request.headers["x-steam-account-name"];
      if (typeof accountName !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(accountName)
        || !password || password.byteLength < 8 || password.byteLength > 1024) return apiError(reply, 400, "STEAM_CREDENTIALS_REJECTED");
      try {
        const result = await options.access.submitCredentials({ enrollmentId, accountName, password, uiSession });
        return reply.status(result.state === "READY" ? 200 : 202).send(result);
      } catch { return apiError(reply, 400, "STEAM_CREDENTIALS_REJECTED"); }
    } finally { password?.fill(0); }
  });

  server.post("/v1/steam-ui/enrollments/:enrollmentId/guard", {
    bodyLimit: 64,
    onRequest: binaryOnly,
  }, async (request, reply) => {
    secureApi(reply);
    const enrollmentId = enrollmentIdFrom(request);
    const guardCode = rawBytes(request.body);
    try {
      if (!enrollmentId || !sameOrigin(request, origin)) return apiError(reply, 403, "STEAM_UI_REQUEST_REJECTED");
      const principal = await browserPrincipal(options.identity, request, identityPath("enrollments", enrollmentId), "POST");
      if (!principal) return apiError(reply, 401, "STEAM_UI_SESSION_REQUIRED");
      const uiSession = request.headers["x-deviludo-steam-ui-session"];
      if (typeof uiSession !== "string" || !matchesSession(options.sessionVerifier, request, principal,
        "STEAM_ENROLLMENT", enrollmentId, "SUBMIT_GUARD_CODE")) return apiError(reply, 401, "STEAM_UI_CAPABILITY_REQUIRED");
      if (!guardCode || guardCode.byteLength < 4 || guardCode.byteLength > 32) return apiError(reply, 400, "STEAM_GUARD_REJECTED");
      try {
        const result = await options.access.submitGuard({ enrollmentId, guardCode, uiSession });
        return reply.status(result.state === "READY" ? 200 : 202).send(result);
      } catch { return apiError(reply, 400, "STEAM_GUARD_REJECTED"); }
    } finally { guardCode?.fill(0); }
  });

  server.get("/approvals/:approvalId", async (request, reply) => {
    const approvalId = approvalIdFrom(request);
    if (!approvalId) return htmlError(reply, 404, "发布授权链接无效", "请返回项目交付页重新发起发布授权。");
    const principal = await browserPrincipal(options.identity, request, identityPath("approvals", approvalId), "GET");
    if (!principal) return htmlError(reply, 401, "请先登录 DeviLudo", "当前发布授权需要原平台会话确认。");
    try {
      const challenge = await options.webauthn.begin({ approvalId, tenantId: principal.tenantId, userId: principal.userId });
      if (challenge.publicKey.rpId !== origin.hostname) throw new Error("WebAuthn RP binding mismatch");
      const uiSession = issue(options.sessions, principal, "STEAM_RELEASE_APPROVAL", approvalId, "COMPLETE_RELEASE_MFA");
      return html(reply, approvalPage({ approvalId, displayName: principal.displayName, uiSession, challenge }), true);
    } catch { return htmlError(reply, 503, "MFA 服务暂时不可用", "未生成或接受任何发布授权，请稍后重试。"); }
  });

  server.post("/v1/steam-ui/approvals/:approvalId/complete", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    secureApi(reply);
    const approvalId = approvalIdFrom(request);
    if (!approvalId || !sameOrigin(request, origin)) return apiError(reply, 403, "STEAM_UI_REQUEST_REJECTED");
    const principal = await browserPrincipal(options.identity, request, identityPath("approvals", approvalId), "POST");
    if (!principal) return apiError(reply, 401, "STEAM_UI_SESSION_REQUIRED");
    const uiSession = request.headers["x-deviludo-steam-ui-session"];
    if (typeof uiSession !== "string" || !matchesSession(options.sessionVerifier, request, principal,
      "STEAM_RELEASE_APPROVAL", approvalId, "COMPLETE_RELEASE_MFA")) return apiError(reply, 401, "STEAM_UI_CAPABILITY_REQUIRED");
    const body = exactObject(request.body, ["assertion"]);
    if (!body || !body.assertion || typeof body.assertion !== "object" || Array.isArray(body.assertion)) {
      return apiError(reply, 400, "STEAM_MFA_REJECTED");
    }
    try { return reply.send(await options.access.completeApproval({ approvalId, assertion: body.assertion, uiSession })); }
    catch { return apiError(reply, 400, "STEAM_MFA_REJECTED"); }
  });
}

function issue(signer: SteamAccessUiSessionSigner, principal: SteamSecureUiPrincipal,
  resourceKind: "STEAM_ENROLLMENT" | "STEAM_RELEASE_APPROVAL", resourceId: string, action: SteamAccessUiAction): string {
  return signer.issue({ tenantId: principal.tenantId, userId: principal.userId, sessionBinding: principal.sessionBinding,
    resourceKind, resourceId, action });
}

function matchesSession(verifier: SteamAccessUiSessionVerifier, request: FastifyRequest, principal: SteamSecureUiPrincipal,
  resourceKind: "STEAM_ENROLLMENT" | "STEAM_RELEASE_APPROVAL", resourceId: string, action: SteamAccessUiAction): boolean {
  try {
    const session = verifier.verify(request, { resourceKind, resourceId, action });
    return session.tenantId === principal.tenantId && session.userId === principal.userId
      && session.sessionBinding === principal.sessionBinding;
  } catch { return false; }
}

async function browserPrincipal(identity: SteamSecureUiIdentityPort, request: FastifyRequest,
  pathname: string, method: "GET" | "POST"): Promise<SteamSecureUiPrincipal | null> {
  try { return await identity.assert(steamSecureUiBrowserSession(request.headers.cookie), pathname, method); }
  catch { return null; }
}

async function binaryOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers["content-type"] !== "application/octet-stream") {
    secureApi(reply);
    await reply.status(415).send({ error: { code: "BINARY_SECRET_BODY_REQUIRED", message: "Binary secret body required" } });
  }
}

function sameOrigin(request: FastifyRequest, origin: URL): boolean {
  return request.headers.origin === origin.origin
    && (request.headers["sec-fetch-site"] === undefined || request.headers["sec-fetch-site"] === "same-origin");
}
function enrollmentIdFrom(request: FastifyRequest): string | null { const value = (request.params as Record<string, unknown>).enrollmentId; return typeof value === "string" && ENROLLMENT_ID.test(value) ? value : null; }
function approvalIdFrom(request: FastifyRequest): string | null { const value = (request.params as Record<string, unknown>).approvalId; return typeof value === "string" && ID.test(value) ? value : null; }
function identityPath(kind: "enrollments" | "approvals", id: string): string { return `/api/steam-access-ui/${kind}/${id}`; }
function rawBytes(value: unknown): Uint8Array | null { return Buffer.isBuffer(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null; }
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>; return JSON.stringify(Object.keys(result).sort()) === JSON.stringify([...keys].sort()) ? result : null; }
function rootHttpsOrigin(value: string): URL { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password
  || url.pathname !== "/" || url.search || url.hash) throw new Error("Steam Secure UI public origin is invalid"); return url; }

function html(reply: FastifyReply, page: Readonly<{ markup: string; nonce: string }>, webauthn: boolean) {
  htmlSecurity(reply, page.nonce, webauthn);
  reply.header("content-type", "text/html; charset=utf-8");
  return reply.send(page.markup);
}
function htmlError(reply: FastifyReply, status: number, title: string, message: string) {
  const nonce = randomBytes(18).toString("base64url"); htmlSecurity(reply, nonce, false);
  return reply.status(status).type("text/html; charset=utf-8").send(document(nonce, title,
    `<main class="card"><span class="mark">DL</span><p class="eyebrow">安全访问</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`, ""));
}
function secureApi(reply: FastifyReply): void { reply.header("cache-control", "no-store"); reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  reply.header("referrer-policy", "no-referrer"); reply.header("x-content-type-options", "nosniff"); }
function apiError(reply: FastifyReply, status: number, code: string) { return reply.status(status).send({ error: { code, message: "Steam secure operation was rejected" } }); }

function enrollmentPage(input: Readonly<{ enrollmentId: string; displayName: string; credentialSession: string; guardSession: string }>): Readonly<{ markup: string; nonce: string }> {
  const nonce = randomBytes(18).toString("base64url");
  const config = scriptJson({ enrollmentId: input.enrollmentId, credentialSession: input.credentialSession, guardSession: input.guardSession });
  const body = `<main class="card wide"><span class="mark">DL</span><p class="eyebrow">Steam Build Account</p><h1>建立加密发布会话</h1>
    <p>已验证为 <strong>${escapeHtml(input.displayName)}</strong>。密码与 Steam Guard Code 只进入此隔离进程，不经过 DeviLudo Web 控制面，也不会写入数据库或日志。</p>
    <div id="notice" class="notice" role="status">请输入专用、最小权限的 Steam build account。</div>
    <form id="credentials"><label>Steam 账号<input id="account" autocomplete="username" maxlength="64" required></label>
      <label>Steam 密码<input id="password" type="password" autocomplete="current-password" maxlength="1024" required></label><button>继续</button></form>
    <form id="guard" hidden><label>Steam Guard Code<input id="guard-code" autocomplete="one-time-code" maxlength="32" required></label><button>验证并保存加密会话</button></form>
    <p class="fine">仅保存 Vault 中加密的 <code>config.vdf</code> SecretRef；主密码和 Guard Code 会在请求完成后清零。</p></main>`;
  const script = `const c=${config};const n=document.querySelector('#notice');const cf=document.querySelector('#credentials');const gf=document.querySelector('#guard');
const send=async(path,value,token,headers={})=>{const bytes=new TextEncoder().encode(value);try{return await fetch(path,{method:'POST',headers:{'content-type':'application/octet-stream','x-deviludo-steam-ui-session':token,...headers},body:bytes});}finally{bytes.fill(0)}};
cf.addEventListener('submit',async e=>{e.preventDefault();const a=document.querySelector('#account');const p=document.querySelector('#password');const value=p.value;p.value='';n.textContent='正在建立 Steam 会话…';try{const r=await send('/v1/steam-ui/enrollments/'+encodeURIComponent(c.enrollmentId)+'/credentials',value,c.credentialSession,{'x-steam-account-name':a.value});const j=await r.json();if(!r.ok)throw new Error();if(j.state==='READY'){location.assign('/settings/connections?steam=connected');return}cf.hidden=true;gf.hidden=false;n.textContent='Steam Guard 已发送，请输入一次性验证码。';}catch{n.textContent='凭据验证失败。未保存密码，请检查后重试。'}});
gf.addEventListener('submit',async e=>{e.preventDefault();const g=document.querySelector('#guard-code');const value=g.value;g.value='';n.textContent='正在验证 Steam Guard…';try{const r=await send('/v1/steam-ui/enrollments/'+encodeURIComponent(c.enrollmentId)+'/guard',value,c.guardSession);if(!r.ok)throw new Error();const j=await r.json();if(j.state!=='READY')throw new Error();location.assign('/settings/connections?steam=connected');}catch{n.textContent='Steam Guard 验证失败。验证码未保存，请刷新后重试。'}});`;
  return securedDocument(nonce, "Steam Guard 登记", body, script);
}

function approvalPage(input: Readonly<{ approvalId: string; displayName: string; uiSession: string; challenge: SteamReleaseWebAuthnOptions }>): Readonly<{ markup: string; nonce: string }> {
  const nonce = randomBytes(18).toString("base64url");
  const config = scriptJson({ approvalId: input.approvalId, uiSession: input.uiSession, challenge: input.challenge });
  const body = `<main class="card wide"><span class="mark">DL</span><p class="eyebrow">Steam 发布外部门禁</p><h1>确认上传密码保护 Beta</h1>
    <p>已验证为 <strong>${escapeHtml(input.displayName)}</strong>。本次确认仅授权当前 release、main SHA 与证据摘要，有效期十分钟。</p>
    <div id="notice" class="notice" role="status">使用已登记的通行密钥完成 AAL2 验证。</div><button id="approve">使用通行密钥确认并发布</button>
    <p class="fine">验证通过后仅签发一次 Ed25519 发布授权；Steam 上传与干净客户端回装测试将由工作流继续。</p></main>`;
  const script = `const c=${config};const n=document.querySelector('#notice');const b=document.querySelector('#approve');const d=s=>{const p='='.repeat((4-s.length%4)%4);return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+p),x=>x.charCodeAt(0))};const e=x=>{const v=new Uint8Array(x);let s='';for(const b of v)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
b.addEventListener('click',async()=>{b.disabled=true;n.textContent='等待通行密钥验证…';try{const o=c.challenge.publicKey;const publicKey={challenge:d(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:'required',allowCredentials:o.allowCredentials.map(x=>({id:d(x.id),type:'public-key',transports:x.transports}))};const cred=await navigator.credentials.get({publicKey});if(!cred)throw new Error();const assertion={challengeId:c.challenge.challengeId,id:cred.id,rawId:e(cred.rawId),type:cred.type,response:{clientDataJSON:e(cred.response.clientDataJSON),authenticatorData:e(cred.response.authenticatorData),signature:e(cred.response.signature),userHandle:cred.response.userHandle?e(cred.response.userHandle):null}};const r=await fetch('/v1/steam-ui/approvals/'+encodeURIComponent(c.approvalId)+'/complete',{method:'POST',headers:{'content-type':'application/json','x-deviludo-steam-ui-session':c.uiSession},body:JSON.stringify({assertion})});if(!r.ok)throw new Error();location.assign('/');}catch{n.textContent='MFA 验证未完成，未签发发布授权。';b.disabled=false}});`;
  return securedDocument(nonce, "Steam 发布授权", body, script);
}

function securedDocument(nonce: string, title: string, body: string, script: string): Readonly<{ markup: string; nonce: string }> {
  return Object.freeze({ markup: document(nonce, title, body, `<script nonce="${nonce}">${script}</script>`), nonce });
}
function document(nonce: string, title: string, body: string, script: string): string { return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · DeviLudo</title><style nonce="${nonce}">${styles}</style></head><body>${body}${script}</body></html>`; }
function htmlSecurity(reply: FastifyReply, nonce: string, webauthn: boolean): void { reply.header("cache-control", "no-store"); reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff"); reply.header("cross-origin-opener-policy", "same-origin"); reply.header("cross-origin-resource-policy", "same-origin");
  reply.header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
  if (webauthn) reply.header("permissions-policy", "publickey-credentials-get=(self)"); }
function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

const styles = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#07100d;color:#eefbf5}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 20% 10%,#173c2d 0,transparent 42%),linear-gradient(145deg,#07100d,#0b1813)}.card{width:min(520px,100%);padding:34px;border:1px solid #29483b;border-radius:24px;background:rgba(10,27,20,.94);box-shadow:0 24px 80px #0008}.wide{width:min(640px,100%)}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:#68efad;color:#062015;font-weight:900}.eyebrow{margin:26px 0 8px;color:#68efad;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(28px,5vw,42px);line-height:1.05;margin:0 0 18px}p{color:#b8cec4;line-height:1.65}.notice{margin:24px 0;padding:14px 16px;border-radius:14px;background:#102a20;color:#dff8eb}form{display:grid;gap:16px}label{display:grid;gap:8px;color:#d8eee3;font-weight:700}input{width:100%;padding:14px;border:1px solid #345548;border-radius:12px;background:#08140f;color:#fff;font:inherit}button{margin-top:4px;padding:14px 18px;border:0;border-radius:12px;background:#68efad;color:#062015;font:inherit;font-weight:900;cursor:pointer}button:disabled{opacity:.55}.fine{font-size:13px;color:#88a99a}code{color:#9df4c6}`;
