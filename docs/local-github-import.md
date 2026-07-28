# 本地导入真实 GitHub 项目

默认 `npm run local:dev` 是无外部凭据的 fixture 模式。只有显式运行 `npm run local:github` 时，启动器才会增加一个仅监听 `127.0.0.1:4315` 的 GitHub sidecar，并访问 `github.com` 与 `api.github.com`。

## 1. 创建 GitHub App

在 GitHub 的 **Settings → Developer settings → GitHub Apps → New GitHub App** 创建私有 App。以默认 Web 端口 `3000` 为例：

- Homepage URL：`http://127.0.0.1:3000`
- Callback URL：`http://127.0.0.1:3000/api/connections/github/callback`
- Setup URL：`http://127.0.0.1:3000/api/connections/github/setup`
- Redirect on update：开启
- Request user authorization during installation：关闭；DeviLudo 会在受校验的 Setup 回调后以 PKCE 单独发起用户授权
- Webhook：关闭
- Repository permissions：`Contents: Read and write`、`Pull requests: Read and write`；`Metadata: Read-only` 由 GitHub 自动提供
- Where can this GitHub App be installed：`Only on this account`

不要增加 Administration 等写权限。DeviLudo 会拒绝带有未批准高权限的 installation。

创建后记录 App 页面中的 **App ID**、**Client ID** 和 URL 中的 App slug，生成一个 Client secret，并下载一把 private key。不要把 Client secret 或 private key 提交到仓库。

## 2. 保存本机配置

创建被 Git 忽略的私有目录：

```bash
mkdir -p .deviludo/github
chmod 700 .deviludo .deviludo/github
```

把下载的 private key 移到 `.deviludo/github/app-private-key.pem`，将 Client secret 单独粘贴到 `.deviludo/github/client-secret`。两个文件都必须是普通文件且权限为 `0600`：

```bash
chmod 600 .deviludo/github/app-private-key.pem .deviludo/github/client-secret
```

在 `.deviludo/github-app.json` 写入不含密钥的配置：

```json
{
  "schema": "deviludo.local-github-config.v1",
  "appId": "123456",
  "appSlug": "deviludo-local-yourname",
  "clientId": "Iv1.abcdefghijklmnop",
  "githubUserId": 12345678,
  "clientSecretFile": "/absolute/path/to/DeviLudo/.deviludo/github/client-secret",
  "privateKeyFile": "/absolute/path/to/DeviLudo/.deviludo/github/app-private-key.pem"
}
```

`githubUserId` 必须是当前 GitHub 用户的数字 ID，不是用户名。可从 `https://api.github.com/users/<用户名>` 响应中的 `id` 取得。两个文件路径必须是绝对路径。

## 3. 启动并导入

```bash
npm run local:github
```

然后打开 <http://127.0.0.1:3000/settings/connections>：

1. 点击“连接 GitHub”。
2. 在 GitHub 选择允许该 App 访问的仓库并安装。
3. 完成 PKCE 用户授权后自动返回 DeviLudo。
4. 打开 `/projects/new`，从实时仓库目录中选择项目并创建。

导入时浏览器只提交 installation ID 与 repository ID。sidecar 会重新签发 metadata-only 的短期 installation token，从 GitHub 实时读取 owner、仓库名、默认分支和 node ID，立即撤销 token，再把权威绑定写入本地 D1。归档或禁用仓库不会出现在目录中。

本机只持久化经验证的 installation 元数据和项目绑定。OAuth code、用户 token、installation token、Client secret、private key 和 PKCE verifier 不进入 D1、状态文件、响应或日志。Client secret 和 private key 只进入 GitHub sidecar；Web 进程只持有每次启动生成的 sidecar HMAC 会话 Key。

如需使用不同 Web 端口，GitHub App 的 Callback/Setup URL 必须同步修改，并用 `npm run local:github -- --port <端口>` 启动。GitHub App URL 与启动端口不一致时授权会失败关闭。
