# Creator Assistant 0.3.0 — source candidate

[中文](README.md)

By xiaoyu312 · [FateClear — free birthday charting and interpretation website](https://fateclear.com) · [X — the author's projects and updates](https://x.com/liu_xiaoyu27334)

An independent Manifest V3 extension that collects creator information from the user's current authorized platform page and keeps follow-up, contacts, bookmarks and invitation drafts in local browser storage. It supports Douyin, Weixin Channels, Xiaohongshu and Kuaishou. Douyin and Weixin also have explicitly started invitation workflows.

The initial state is empty. No real contacts, task history, browser sessions or backups are bundled. The enterprise creator-operations backend is not required.

## Build and test

Node.js 24; no npm dependencies.

```sh
node build.mjs
node --test tests/*.test.mjs
```

The build only joins two admitted source files into `capture-main.js`. Load this directory manually as an unpacked extension in a separate test browser profile. The manifest declares Chrome 120 as a minimum; this preparation did not verify Chrome, Edge or Windows compatibility.

## Behavior and permissions

Local storage holds creator records. Active-tab, scripting and restricted host permissions support authorized page reads and explicitly initiated operations. Alarms schedule local jobs. The cookies permission checks the selected Weixin shop's current session at runtime; no session value is bundled in source.

The extension does not send data to the observed competing products' services. Real invitation workflows do communicate with the relevant official platform. Therefore the full extension is not an offline application.

Local collection is not platform-side claiming. Manual completion is not verified delivery. Rejections or unknown results require review before retrying. The existing 50-recipient batch limit and 30-second minimum interval do not establish platform permission.

Backups, CSV exports, browser storage and diagnostics may contain user-entered records; keep them out of source repositories.

## Verification limits

Admitted Node tests use simulated DOM, Chrome APIs, fetch and storage. One private historical-ZIP compatibility test and browser-launching scripts are excluded. No real login, contact lookup, invitation delivery, extension-store publication or Windows validation was performed.

MIT covers user-owned implementation. Platform and third-party rights remain separate. See the root LICENSE-STATUS.md for license scope.

Explore [FateClear — free birthday charting and interpretation website](https://fateclear.com), or follow the author's projects and updates on [X](https://x.com/liu_xiaoyu27334).
