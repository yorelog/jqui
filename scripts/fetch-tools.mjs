#!/usr/bin/env node
// Fetch the native xh and jq executables for one platform/architecture.
//
// Local development:
//   node scripts/fetch-tools.mjs
//
// Packaging in CI:
//   node scripts/fetch-tools.mjs --platform macos --arch universal --out staging/macos
//
// The versions are pinned so a release is reproducible. Bump them and their
// SHA-256 values together.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const XH_VERSION = "0.26.3";
const JQ_VERSION = "1.8.2";

const DIGESTS = {
  "xh:windows:x64": "23d92fd78ff6a93c4e1c4de3a6b614bb8a31999acb441793630bcc37f9cd6c45",
  "xh:macos:arm64": "50d61bd755942752b054297a1612ec191654f137f8939673cda83c686cb5b0f2",
  "xh:macos:x64": "b1c07e42238485bdcbed0982766f58b4daa631f0a33870100054ef5fbb4a3c4b",
  "xh:linux:arm64": "a45d8cb6c234c6850f9fc2395fc3544ab7691fb511237f00179aedba1bcd525e",
  "xh:linux:x64": "cbbf53bd76007d57d95e4bed8ba7fb3b7fcec22af4bdfc1ff119cd5de351e74f",
  "jq:windows:x64": "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
  "jq:windows:arm64": "083b5377392bc57cf27052b6d20a2d927770683bca844632901ff38b4b7b0ac7",
  "jq:macos:arm64": "2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e",
  "jq:macos:x64": "e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0",
  "jq:linux:arm64": "8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309",
  "jq:linux:x64": "b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f",
};

function usage() {
  console.log(`Usage: node scripts/fetch-tools.mjs [options]

Options:
  --platform <windows|macos|linux>   Default: this platform
  --arch <x64|arm64|universal>       Default: this architecture; universal is macOS only
  --out <directory>                  Default: the current directory
  --help                             Show this help

Versions are pinned: xh ${XH_VERSION}, jq ${JQ_VERSION}.`);
}

function parseArgs(argv) {
  const options = {
    platform:
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    arch: process.arch === "arm64" || process.arch === "aarch64" ? "arm64" : "x64",
    out: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--platform" || arg === "--arch" || arg === "--out") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} needs a value`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  if (!["windows", "macos", "linux"].includes(options.platform)) {
    throw new Error(`unsupported platform ${options.platform}`);
  }
  if (!["x64", "arm64", "universal"].includes(options.arch)) {
    throw new Error(`unsupported architecture ${options.arch}`);
  }
  if (options.arch === "universal" && options.platform !== "macos") {
    throw new Error("universal binaries are only supported for macOS");
  }
  options.out = path.resolve(options.out);
  return options;
}

function xhAsset(platform, arch) {
  if (platform === "windows") return `xh-v${XH_VERSION}-x86_64-pc-windows-msvc.zip`;
  const suffix = arch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "macos") return `xh-v${XH_VERSION}-${suffix}-apple-darwin.tar.gz`;
  return `xh-v${XH_VERSION}-${suffix}-unknown-linux-musl.tar.gz`;
}

function jqAsset(platform, arch) {
  if (platform === "windows") return arch === "arm64" ? "jq-windows-arm64.exe" : "jq-windows-amd64.exe";
  if (platform === "macos") return arch === "arm64" ? "jq-macos-arm64" : "jq-macos-amd64";
  return arch === "arm64" ? "jq-linux-arm64" : "jq-linux-amd64";
}

function xhDigest(platform, arch) {
  // xh has no native Windows arm64 build; the x64 asset runs under emulation.
  const assetArch = platform === "windows" ? "x64" : arch;
  return DIGESTS[`xh:${platform}:${assetArch}`];
}

function jqDigest(platform, arch) {
  return DIGESTS[`jq:${platform}:${arch}`];
}

async function download(url, digest, label) {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (digest) {
    const actual = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actual !== digest) {
      throw new Error(`${label}: SHA-256 mismatch\n  expected ${digest}\n  actual   ${actual}`);
    }
  }
  console.log(`downloaded ${label} (${(buffer.length / 1024 / 1024).toFixed(1)} MiB)`);
  return buffer;
}

function runTar(archivePath) {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  execFileSync("tar", [isZip ? "-xf" : "-xzf", archivePath, "-C", path.dirname(archivePath)], {
    stdio: "inherit",
  });
}

async function findFile(directory, names) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(target, names);
      if (found) return found;
    } else if (names.includes(entry.name.toLowerCase())) {
      return target;
    }
  }
  return null;
}

async function extractXh(archiveName, buffer, tempRoot) {
  const directory = await fs.mkdtemp(path.join(tempRoot, "xh-"));
  const archivePath = path.join(directory, archiveName);
  await fs.writeFile(archivePath, buffer);
  runTar(archivePath);
  const found = await findFile(directory, ["xh.exe", "xh"]);
  if (!found) throw new Error(`${archiveName}: no xh executable in the archive`);
  return found;
}

async function writeExecutable(target, buffer) {
  await fs.writeFile(target, buffer);
  if (process.platform !== "win32") await fs.chmod(target, 0o755);
  console.log(`wrote ${target}`);
}

async function installXh(options, tempRoot, outputName) {
  const target = path.join(options.out, outputName);
  if (options.arch === "universal") {
    if (process.platform !== "darwin") throw new Error("universal xh requires macOS lipo");
    const arm64 = await extractXh(
      xhAsset("macos", "arm64"),
      await download(
        `https://github.com/ducaale/xh/releases/download/v${XH_VERSION}/${xhAsset("macos", "arm64")}`,
        xhDigest("macos", "arm64"),
        xhAsset("macos", "arm64"),
      ),
      tempRoot,
    );
    const x64 = await extractXh(
      xhAsset("macos", "x64"),
      await download(
        `https://github.com/ducaale/xh/releases/download/v${XH_VERSION}/${xhAsset("macos", "x64")}`,
        xhDigest("macos", "x64"),
        xhAsset("macos", "x64"),
      ),
      tempRoot,
    );
    execFileSync("lipo", ["-create", "-output", target, arm64, x64], { stdio: "inherit" });
    await fs.chmod(target, 0o755);
    console.log(`wrote universal ${target}`);
    return;
  }

  const asset = xhAsset(options.platform, options.arch);
  const buffer = await download(
    `https://github.com/ducaale/xh/releases/download/v${XH_VERSION}/${asset}`,
    xhDigest(options.platform, options.arch),
    asset,
  );
  const extracted = await extractXh(asset, buffer, tempRoot);
  await writeExecutable(target, await fs.readFile(extracted));
}

async function installJq(options, tempRoot, outputName) {
  const target = path.join(options.out, outputName);
  if (options.arch === "universal") {
    if (process.platform !== "darwin") throw new Error("universal jq requires macOS lipo");
    const arm64Asset = jqAsset("macos", "arm64");
    const x64Asset = jqAsset("macos", "x64");
    const arm64 = await download(
      `https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/${arm64Asset}`,
      jqDigest("macos", "arm64"),
      arm64Asset,
    );
    const x64 = await download(
      `https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/${x64Asset}`,
      jqDigest("macos", "x64"),
      x64Asset,
    );
    const arm64Path = path.join(tempRoot, "jq-arm64");
    const x64Path = path.join(tempRoot, "jq-x64");
    await fs.writeFile(arm64Path, arm64);
    await fs.writeFile(x64Path, x64);
    execFileSync("lipo", ["-create", "-output", target, arm64Path, x64Path], { stdio: "inherit" });
    await fs.chmod(target, 0o755);
    console.log(`wrote universal ${target}`);
    return;
  }

  const asset = jqAsset(options.platform, options.arch);
  const buffer = await download(
    `https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/${asset}`,
    jqDigest(options.platform, options.arch),
    asset,
  );
  await writeExecutable(target, buffer);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.out, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jqui-tools-"));
  try {
    const suffix = options.platform === "windows" ? ".exe" : "";
    await installXh(options, tempRoot, `xh${suffix}`);
    await installJq(options, tempRoot, `jq${suffix}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  console.log(`tools for ${options.platform}/${options.arch} are in ${options.out}`);
}

main().catch((error) => {
  console.error(`fetch-tools: ${error.message}`);
  process.exit(1);
});
