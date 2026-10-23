[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Creator Assistant 0.3.0

**Collect creators from authorized platform pages and organize follow-up and invitation drafts in your browser.**

Source candidate; browser and real-platform workflows have not completed acceptance testing.

By xiaoyu312 · [FateClear — free birthday charting and interpretation website](https://fateclear.com) · [X — the author's projects and updates](https://x.com/liu_xiaoyu27334)

An independent Manifest V3 extension that collects creator information from the user's current authorized platform page and keeps follow-up, contacts, bookmarks and invitation drafts in local browser storage. It supports Douyin Selected Alliance, Weixin Channels, Xiaohongshu Pugongying and Kuaishou. Douyin and Weixin also have explicitly started invitation workflows.

The original extension features are retained. The initial state is empty. No real contacts, task history, browser sessions or backups are bundled. The enterprise creator-operations backend is not required.

## Preview unsent synthetic drafts

With a complete repository copy and Node.js 24, run the following from this extension directory:

```sh
node ../../examples/assistant-demo.mjs
```

The [example source](../../examples/assistant-demo.mjs) uses this extension's core module, takes 2 fictional creators and generates 2 unsent drafts. This expected output follows from the source and assertions; the command was not executed during this documentation pass:

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

This standalone example opens no browser, makes no network requests, saves no records and sends no invitations. See below for the complete extension's live invitation behavior and permissions.

## Build and install

Node.js 24; no npm dependencies.

```sh
node build.mjs
node --test tests/*.test.mjs
```

The build only joins two owned source files into `capture-main.js`; it does not download, upload a package or install the extension.

In a separate Chrome/Edge test profile, open the extension management page, enable developer mode, choose “Load unpacked” and select this directory. The manifest declares Chrome 120 as a minimum. Browser and Windows testing was not performed; the declared minimum is not a verified compatibility range.

## Behavior and permissions

`storage` holds local creator records. `activeTab`, `scripting` and restricted host permissions support authorized page reads and explicitly initiated operations. `alarms` schedules invitation jobs. The `cookies` permission checks the selected Weixin shop's current session at runtime; session values are used only for the corresponding platform requests. No cookies, tokens or preset accounts are bundled in source.

The extension does not upload records to third-party competing services. Real invitation workflows do communicate with the relevant official platform. Therefore the full extension is not an offline application.

Local collection is not platform-side claiming. Manual completion is not verified delivery. Failures, rejections or unknown results must stop the workflow for manual review; do not retry unconditionally. The existing 50-recipient batch limit and 30-second minimum interval do not establish platform permission or guarantee delivery.

Backups, CSV exports, browser storage and diagnostics may contain user-entered records; keep them out of source repositories.

## Verification limits

The historical source-preparation record reports 164 passing extension tests. This pass only edited documentation and performed static checks; tests and builds were not rerun.

Admitted Node tests use simulated DOM, Chrome APIs, fetch and storage. One private historical-ZIP compatibility test and browser-launching scripts are excluded. No real login, contact lookup, invitation delivery, extension-store publication or Windows validation was performed.

## Documentation and source entry points

- [Creator Operations workbench](../../README.en.md): the independently runnable main application, included sources and optional integrations.
- [Extension manifest](manifest.json): version, declared browser minimum and permissions.
- [Build script](build.mjs) and [core module](lib/core.mjs): local build, records, filtering and draft logic.
- [Mocked tests](tests/): the specific behaviors and boundaries covered by tests.

## License

MIT covers user-owned implementation. Platform identifiers, protocols and third-party products remain subject to their respective rights. See the root [license scope](../../LICENSE-STATUS.md) and [third-party notices](../../THIRD_PARTY_NOTICES.md).

Explore [FateClear — free birthday charting and interpretation website](https://fateclear.com), or follow the author's projects and updates on [X](https://x.com/liu_xiaoyu27334).
