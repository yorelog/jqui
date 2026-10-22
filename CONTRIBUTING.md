# Contributing

Thanks for helping with Jqui.

## Development setup

Requirements:

- [gpui-shell 0.8.0](https://gpui-kit.com/)
- Node.js 18+
- `tar`
- Linux builds: install gpui-kit's Linux dependencies, including `libwebkit2gtk-4.1-dev`, `libwayland-dev`, `libxkbcommon-x11-dev`, `libx11-xcb-dev`, `libssl-dev`, `libzstd-dev`, `libasound2-dev`, and `libfontconfig-dev`
- Optional: a native `xh` / `jq`; the download script provides them

```bash
git clone https://github.com/yorelog/jqui.git
cd jqui
node scripts/fetch-tools.mjs
gpui-shell check -d .
gpui-shell dev -d .
```

`node scripts/fetch-tools.mjs` places the platform binaries in the application root. They are ignored by Git and must not be committed.

## Before opening a pull request

1. Run `gpui-shell check -d .`.
2. Run the app with `gpui-shell dev -d .` and exercise the affected request/response flow.
3. Keep the Chinese and English strings in `lib/i18n.js` in sync. UI code reads `t(key)`; helper modules use `msg(zh, en)`.
4. If you change the pinned xh/jq versions in `scripts/fetch-tools.mjs`, update both the version and the SHA-256 values, and verify a bundle for at least one target platform.
5. Do not commit `xh`, `jq`, downloaded tools, `dist/`, or `staging/`.

## Release changes

The workflow in `.github/workflows/release.yml` builds Windows, macOS universal, and Linux packages. A release tag must match `version` in `gpui-shell.json`. See the README for the tag command and assets.

For UI changes, include a screenshot of the affected state in the pull request when possible.
