# License scope / 许可范围

User-owned implementation and new preparation files use **MIT**, copyright 2026 xiaoyu312, based on the owner's explicit ownership and license confirmation. This covers the admitted workbench/domain/extension implementation and the added local demo adapter, configuration and documentation. Upstream code retains its original notices.

- **Lark template lineage:** `licenses/LICENSE.template` is preserved verbatim. It calls itself “MIT License” and contains its own short permission wording. That actual text is retained rather than replaced by the root MIT text.
- **shadcn/ui-derived UI helpers:** the official upstream MIT notice is preserved at `licenses/shadcn-ui-MIT.txt`. Source: [shadcn-ui/ui LICENSE.md](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), Git blob `fad4d887a681dd49233e5ed01ee2c7a1513089a0`.
- **Direct packages:** exact versions and notices appear in `licenses/dependency-inventory.json` and `licenses/dependencies/`. Dependency implementations, `node_modules`, generated distributions and third-party assets are not bundled. These notices do not replace each package's actual terms.
- **Lark client toolkit:** official registry metadata confirms version 1.2.74 exists but its `license` field is empty. The installed package's actual Lark permission text is preserved at `licenses/dependencies/lark-apaas__client-toolkit-LICENSE`. We do not infer a standard SPDX license from public availability or relicense that SDK as our own MIT work.
- **Creator Assistant:** admitted sources use browser/Node interfaces without bundled libraries. Source-project provenance describes independent implementation informed by observing other tools. Vendor bundles, screenshots, private research evidence and assets are excluded.
- **Excluded rights:** platform trademarks, SDK services, API permissions, user data, excluded commercial material and future runtime imports remain outside the root MIT grant.

This experimental source edition includes the default demo and preserved upstream notices. Actual platform integration, data processing and production operation require their own checks and access rights. Public-source permission does not establish service compatibility or permission to use a user's data.

用户拥有的实现以 MIT 提供；上游模板、UI 辅助代码及依赖按各自原文保留许可，不统一改写为用户版权。包中不包含安装依赖、平台凭据、真实经营资料或私有素材。本文对已收入文件说明授权范围，不替代第三方服务条款，也不保证实际平台接口持续可用。
