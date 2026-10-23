[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# 达播管理中台 · Creator Operations

**把达人建联、合作进度与团队协作放进同一个电商工作台。**

作者：xiaoyu312 · [FateClear — 免费的生日排盘与解读网站](https://fateclear.com) · [X — 作者项目与更新](https://x.com/liu_xiaoyu27334)

面向电商 BD、达人运营与团队负责人的工作台，把达人建联、跟进、寄样、合作、排期、订单归属与团队协作放进一个流程。此源码包包含原 React 主工作台、原领域服务及 API、确定性的本地演示入口，以及可独立使用的 Manifest V3 达人助手。

**默认运行是本机合成演示，重启重置。** 不含真实工作簿、客户联系人、订单、账号、密钥或私有素材。真实平台适配源保留为可选集成；本包不是已经验证的企业生产部署。

## 先看一份合成示例

已有仓库副本和 Node.js 24 或更新版本后，可先在仓库根目录运行以下独立示例，无需安装应用依赖：

```sh
npm run demo:assistant
```

[示例源码](examples/assistant-demo.mjs)创建 2 位虚构达人，再生成 2 条未发送的邀约草稿。下面是根据源码和断言列出的预期输出，本轮文档整理没有执行该命令：

```json
{
  "mode": "synthetic-only",
  "creators": 2,
  "unsentDrafts": 2,
  "network": "none",
  "browser": "not opened",
  "persisted": false
}
```

此示例不启动浏览器、不请求网络、不持久化记录，也不发送邀约；它展示的是独立达人助手的草稿流程。主工作台另有[合成 API 示例](examples/demo.ts)与[固定种子生成器](examples/generate-demo.ts)，完整应用的安装及验证范围见下文。

## 运行主工作台

要求 Node.js 24 或更新版本。使用者安装依赖后：

```sh
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。前端代理本机 `127.0.0.1:4310` 的 API；在界面切换演示角色，可以查看角色权限、达人跟进、寄样、合作、排期、团队与商品。支持原有命令、CSV 导入预览与确认、导出及审计规则。初始数据为固定合成记录，订单为空；用户主动导入的资料只存在当前进程内存中。

不需要 `.env`。需要改本机 API 端口时，可参考根目录 `.env.example` 创建自己的 `.env`，修改 `DABO_DEMO_API_PORT`。`npm run dev` / `npm start` 显式加载它；不要提交真实环境配置。

构建后在本机预览：

```sh
npm run build:client
npm start
```

本机入口只绑定回环地址，并拒绝生产模式或启用平台运行模式。它使用本机会话 Cookie、CSRF 校验和有大小限制的请求处理。它不提供持久化，不应当作公网部署入口。

## 源码范围

| 目录 | 内容 |
|---|---|
| `client/` | 原 React 工作台、页面、交互模型、图表、UI 组件与样式 |
| `server/domain/`、`shared/` | 原业务命令、角色权限、状态机、导入、销售归属与合成种子 |
| `server/demo/`、`server/http/` | 本次补充的本机会话、内存存储和 HTTP 入口，接入原 API 服务 |
| `server/modules/`、`server/storage/`、`server/invitations/`、`server/platform/` | 原 API、可选 Nest／数据库／身份／成员邀请适配源 |
| `extensions/creator-assistant/` | 完整的独立达人助手源文件与模拟测试 |
| `tests/`、`server/tests/` | 领域、前端模型、API、角色边界与端到端接口契约的进程内测试 |
| `examples/` | 独立合成生成器和小型 API 示例 |
| `licenses/` | 上游和直接依赖许可通知，不含依赖实现 |

`shared/seed.ts` 原本就是人工编写的合成种子。`examples/generate-demo.ts` 以固定种子标识生成相同内容；没有把真实工作簿改名、抽样或去标识化后冒充演示。数据结构中保留联系人、订单与审计字段的定义，但没有真实业务记录。原私有图片和部署对象引用已换成自绘占位 SVG。

## 达人助手

[简体中文](extensions/creator-assistant/README.md) · [English](extensions/creator-assistant/README.en.md) · [日本語](extensions/creator-assistant/README.ja.md)

```sh
npm run build:assistant
npm run test:assistant
```

构建只拼接自己的 `adapters.js` 和 `page-hook.js`，生成 `capture-main.js`。在单独的 Chrome／Edge 测试配置中加载扩展目录即可；不依赖主工作台后端，初次状态为空。

它可从用户有权访问的抖音、视频号、小红书和快手页面在本地收录达人与跟进。抖音／视频号邀约功能会在用户主动开始后使用当前平台会话访问真实平台，因此完整扩展并非离线应用。权限、失败处理和数据保管说明见扩展文档。

## 可选平台接入

默认主工作台不加载真实平台资料，不开放生产成员邀请。原平台品牌、工作簿和成员页面保留为条件分支；`VITE_ENABLE_PLATFORM_INTEGRATIONS` 默认 `false`，文档地址与资料 SDK 地址默认空。浏览器可见的 `VITE_*` 变量不得填密钥。

真实接入需要部署者提供可信认证与 CSRF 中间件、组织／应用 ID、服务端角色映射、CSV 预览签名密钥、工作簿令牌与品牌 registry、数据库 schema／RPC 迁移和平台岗位 SDK。可选模块必须在自己的生产入口里组装并注入这些配置。**完整企业 AppModule、工作簿持久化服务和数据库迁移没有收入**；不能仅打开一个开关就声称完成生产接入，也不能用浏览器传来的身份替代服务端验证。具体接口范围见 [后端说明（中文）](server/README.md)。

`@lark-apaas/client-toolkit@1.2.74` 用于构建保留的平台页面，已确认该版本存在于官方公开 npm registry；默认本地页面不触发它的真实平台流程。可选服务端依赖使用 optional peer 声明。所有 SDK 按自身条款使用，没有被改许可或捆绑实现。

## 验证与已知缺口

```sh
npm test
npm run test:assistant
npm run typecheck
npm run demo
npm run demo:assistant
npm run generate:demo
```

源码准备阶段的历史记录：在禁止网络和监听端口的本地检查环境中，主应用 **154 项**测试、达人助手 **164 项**测试通过；前端实际 Vite 配置完成构建，前后端类型检查通过。当时的验证使用原项目已安装依赖的只读解析，没有安装依赖、启动浏览器或真实服务。本轮仅整理三语文档并做静态检查，没有重新执行这些测试、构建或类型检查。

- 未验证干净环境 `npm install`，未生成新锁文件；直接版本固定，间接依赖仍可能变化。
- 主前端构建有较大 chunk 提示，后续可继续拆包；尚无浏览器交互、视觉、性能或 Windows 实机验收。
- 真正的登录、平台资料查询、邀请送达、数据库迁移／RPC 和生产部署未验证。
- 部分测试包含明显人工构造的假令牌、电话号码与长整数，用于测试过滤、精度与拒绝逻辑；不是运行凭据。
- 运行后导入的数据、导出文件、浏览器存储和备份由使用者保管，不应提交到源码仓库。

## 详细说明与源码入口

- [运行命令与依赖声明](package.json)：Node.js 要求、开发、构建、测试与演示脚本。
- [后端范围说明（中文）](server/README.md)：本地演示边界和可选生产模块所需条件。
- [合成种子](shared/seed.ts)与[演示生成器](examples/generate-demo.ts)：初始记录的来源。
- [独立达人助手](extensions/creator-assistant/README.md)：安装、平台权限、真实邀约与本地资料保管。

## 许可

用户拥有的实现与新增文档采用 MIT，Copyright 2026 xiaoyu312。原 Lark 模板、shadcn/ui 与依赖通知保留；见 [许可范围](LICENSE-STATUS.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。第三方平台、商标、接口与数据访问权不包含在 MIT 授权中。

欢迎试试作者的 [FateClear — 免费的生日排盘与解读网站](https://fateclear.com)，或在 [X](https://x.com/liu_xiaoyu27334) 关注更多项目与更新。
