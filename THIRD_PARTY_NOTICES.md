# Third-party notices / 第三方声明

| Component | Use | Notice |
|---|---|---|
| Lark coding template | Original frontend helpers and platform integration lineage | `licenses/LICENSE.template`, copyright 2024 Lark Technologies Pte. Ltd. and/or affiliates; exact original wording retained |
| shadcn/ui | UI component/helper lineage | Official MIT notice in `licenses/shadcn-ui-MIT.txt`; [upstream source](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) |
| React, Radix UI, TanStack Query, Vite, Tailwind and other direct packages | Installed by users for the workbench/build/tests | Versioned inventory and each available original notice under `licenses/` |
| `@lark-apaas/client-toolkit` | Retained optional platform page build imports | Package permission text retained; registry license field is empty; SDK implementation is not bundled |
| Nest, Lark server SDK, Drizzle and Express | Optional production adapters; not loaded by default demo | Optional peer declarations and dependency-specific notices; integrator supplies runtime and configuration |
| Node.js | Required runtime, not redistributed | Node.js distribution licenses apply |
| Chrome/Edge and platform APIs | Runtime browser interfaces, not redistributed | Browser and platform terms apply |

Drizzle ORM 0.44.6 uses Apache-2.0. Its exact upstream version notice is preserved at `licenses/dependencies/drizzle-orm-LICENSE` from the [official 0.44.6 source](https://github.com/drizzle-team/drizzle-orm/blob/0.44.6/LICENSE). No Drizzle implementation is bundled.

See `licenses/dependency-inventory.json` for all directly declared versions. Transitive packages and implementations are not redistributed; retain their notices when installing or distributing a built application. No fresh install or lockfile resolution was performed for this source preparation.

The Creator Assistant implementation was independently written according to source-project provenance notes. Observed products included 热度云 and 蝉圈圈; their bundles, images, assets and private evidence are not included. No affiliation, endorsement or license to their products is claimed.

Public platform hostnames and endpoint paths in the extension are integration constants, not private deployment addresses. They remain so the integration source is meaningful; they do not establish platform approval or guaranteed compatibility. Runtime cookies and account data are supplied only by the user session, never by this source package.

The local placeholder SVG is newly authored for this package. Private artwork, external CDN artwork, screenshots, workbooks, course material, installed dependencies and generated binary distributions are excluded. The only author promotional links are the explicitly requested documentation links to FateClear and X; no product UI advertising or tracking was added.

以上通知保留上游来源与授权边界；不授予平台商标、用户数据或第三方服务的使用权。可选平台代码需要部署者自行提供有效授权、服务端配置与独立验证。
