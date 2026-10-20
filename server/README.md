# 主工作台 API / Workbench API

默认入口使用已审过的纯合成 `shared/seed.ts`，保留原 `DaboApiService`、CSV 预览签名、领域命令、权限、审计与导出规则。内存存储沿用原存储的串行事务与复制隔离合同；没有文件/数据库持久化，重启会重置。服务返回 `dataMode: demo`，不声明真实登录、品牌工作簿或业务工作区。

在仓库依赖已由使用者安装、Node.js 24 可用时：

```sh
node --experimental-transform-types server/demo/main.ts
```

默认只监听 `127.0.0.1:4310`；前端开发服务器应将 `/api` 代理到此地址。入口导入本身不会监听端口。可设置 `DABO_DEMO_API_PORT`（1024–65535）；`DABO_MODE` 默认为 `demo`。设置 `NODE_ENV=production`、其他运行模式或 `DABO_ENABLE_PLATFORM=1` 会被演示入口拒绝。`.env.example` 是配置说明，入口不会自动加载任何 `.env` 文件。

| 方法 | 路径 | 原有能力 |
|---|---|---|
| GET | `/api/session` | 合成会话、允许切换的演示身份、CSRF |
| POST | `/api/demo/session` | 切换已存在的演示身份 |
| GET | `/api/workspace` | 主领域工作台与筛选 |
| POST | `/api/commands` | 领域业务命令 |
| POST | `/api/imports/preview`、`/api/imports/commit` | CSV 预览、签名确认提交 |
| GET | `/api/imports/template/:kind` | 空 CSV 模板 |
| POST | `/api/exports/:kind` | 权限控制、审计记录、CSV 公式保护 |

POST 请求必须是 JSON 对象，正文上限 6 MiB；CSV 文本另有原服务的 2 MB/5,000 行限制。会话使用 HttpOnly/SameSite=Strict Cookie，写入要求 `X-Dabo-CSRF`。这是本机演示，不应对公网开放。运行后主动导入的用户数据只存在内存中；导出的文件由使用者保管，不应提交回源码仓库。

`modules/dabo/dabo.module.ts`、`dabo.controller.ts` 和 `error.filter.ts` 保留原 Nest 平台集成方式。`storage/postgres-domain-store.ts` 保留真实事务、组织范围、权限上下文、不可改写审计的数据库适配源。`invitations/` 与 `modules/member-invitations/` 保留签名 RPC、平台岗位核验与邀请生命周期服务；`modules/workbook/identity.ts`、`config.ts` 保留可信身份与品牌范围规则。这些模块不在默认入口中注册。

可选平台代码需要部署者提供真实认证/CSRF 中间件、数据库连接、经过审查的 schema/RPC 迁移、品牌 registry 和平台角色 SDK，再注入配置。环境变量只能由部署者填写，不能从 HTTP 请求取得。没有交付可直接部署的完整平台 AppModule、完整工作簿服务或数据库迁移；成员邀请在本地 API 中明确不可用，不会模拟真实授权成功。平台角色范围审核参数默认关闭。不得仅删除 `NeedLogin` 或以客户端传来的 `userContext` 代替可信登录。

默认 API 运行依赖仅为 Node.js 和根目录现有的 Zod。可选源涉及 `@nestjs/common`、`@lark-apaas/fullstack-nestjs-core`、`drizzle-orm`，以及 Express 类型；它们未被复制入源码包，也不会由演示入口加载。原项目的参考版本分别为 10.4.x、1.1.66、0.44.6 和 4.22.2，尚未在干净环境验证这一可选组合。应用自写改动沿用根 MIT 许可；平台模板通知与第三方条款仍适用。

本轮仅做无网络、无端口的进程内 API/模拟平台测试和静态检查。浏览器、真实平台、数据库 schema/RPC、生产部署均未验证。此处记录后端范围，最终整包成熟度以根 README 为准。

## English

The default API uses only the reviewed deterministic synthetic seed. It preserves the original domain service, authorization, CSV preview signatures, audit and export rules. The in-memory adapter keeps the original serialized transaction/clone semantics; restarting resets all changes. Session responses explicitly report `dataMode: demo`, without a workbook or production business workspace.

After the user has installed dependencies, run `node --experimental-transform-types server/demo/main.ts` with Node.js 24. It binds only to `127.0.0.1:4310`; proxy `/api` from the frontend development server. Importing the entry point does not open a socket. The optional port variable is `DABO_DEMO_API_PORT`. Production mode/platform opt-in is rejected by this demo entry point. Environment files are never loaded automatically.

The table above lists the retained API routes. Writes require an existing local session, JSON object body, and `X-Dabo-CSRF`. Request bodies are bounded at 6 MiB; original CSV limits remain. Data deliberately imported during a session is ephemeral. User-created exports must stay out of the source repository.

Optional Nest, PostgreSQL, signed invitation RPC, platform role verification and workbook identity/configuration sources are retained but never registered by default. They require an integrator's verified authentication/CSRF context, registry, database migrations/RPCs and SDK. The complete production bootstrap, workbook service and migrations are not included. The local API does not fake production invitation grants. Platform integration and deployment remain unverified.
