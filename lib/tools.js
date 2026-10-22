// Checking and updating the bundled xh / jq executables.
//
// Updates are installed under the application data directory (`tools/`), not
// into the application bundle. That keeps an installed application read-only,
// makes rollback a rename, and leaves the bundled copies as the fallback when
// the data directory is cleared.
//
// The archive formats are extracted with the platform's `tar` (Windows 10+,
// macOS and Linux all ship one). The runtime's zlib bindings can compress but
// do not round-trip their own output, so they are not used here.

import * as fs from "fs/promises";
import path from "path";
import process from "process";
import { ARCH, PLATFORM, WINDOWS, managedToolPath } from "./runtime.js";
import { downloadFileWithXh, resolveTool } from "./http.js";
import { msg } from "./i18n.js";

const REPOS = {
  xh: "ducaale/xh",
  jq: "jqlang/jq",
};

const RELEASE_PAGES = {
  xh: "https://github.com/ducaale/xh/releases",
  jq: "https://github.com/jqlang/jq/releases",
};

export function releasePage(tool) {
  return RELEASE_PAGES[tool] || "https://github.com/";
}

export function platformLabel() {
  return `${PLATFORM}/${ARCH}`;
}

export function normalizeVersion(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareVersions(left, right) {
  const a = String(left ?? "0.0.0").split(".").map((part) => Number(part) || 0);
  const b = String(right ?? "0.0.0").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(latest, current) {
  if (!latest) return false;
  if (!current) return true;
  return compareVersions(latest, current) > 0;
}

export function pickAssetFor(tool, platform, arch, assets) {
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform !== "windows" && platform !== "macos" && platform !== "linux") return null;
  const names = (assets || []).map((asset) => ({ asset, name: String(asset.name || "").toLowerCase() }));
  const find = (predicate) => names.find((entry) => predicate(entry.name))?.asset || null;

  if (tool === "xh") {
    if (platform === "windows") {
      if (arch === "arm64") {
        const native = find(
          (name) => name.includes("windows") && name.includes("aarch64") && name.endsWith(".zip"),
        );
        if (native) return native;
      }
      return find((name) => name.includes("windows") && name.includes("x86_64") && name.endsWith(".zip"));
    }
    if (platform === "macos") {
      const targetArch = arch === "arm64" ? "aarch64" : "x86_64";
      return find(
        (name) => name.includes("apple-darwin") && name.includes(targetArch) && name.endsWith(".tar.gz"),
      );
    }
    const targetArch = arch === "arm64" ? "aarch64" : "x86_64";
    return find(
      (name) => name.includes("unknown-linux-musl") && name.includes(targetArch) && name.endsWith(".tar.gz"),
    );
  }

  if (platform === "windows") {
    return find((name) => name === (arch === "arm64" ? "jq-windows-arm64.exe" : "jq-windows-amd64.exe"));
  }
  if (platform === "macos") {
    return find((name) => name === (arch === "arm64" ? "jq-macos-arm64" : "jq-macos-amd64"));
  }
  return find((name) => name === (arch === "arm64" ? "jq-linux-arm64" : "jq-linux-amd64"));
}

function pickAsset(tool, assets) {
  return pickAssetFor(tool, PLATFORM, ARCH, assets);
}

/** Queries the latest stable GitHub release and picks the asset for this platform. */
export async function fetchLatestTool(tool) {
  const repo = REPOS[tool];
  if (!repo) throw new Error(msg(`未知工具 ${tool}`, `Unknown tool ${tool}`));

  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Jqui/0.1.0",
    },
  });

  if (response.status === 403) {
    throw new Error(
      msg(
        "GitHub API 限流（未登录每小时 60 次），请稍后再试",
        "GitHub API rate limit reached (60 requests/hour without signing in); try again later",
      ),
    );
  }
  if (!response.ok) {
    throw new Error(msg(`GitHub API 返回 ${response.status}`, `GitHub API returned ${response.status}`));
  }
  const release = await response.json();
  if (!release || typeof release !== "object") {
    throw new Error(msg("GitHub 返回的不是 release JSON", "GitHub did not return release JSON"));
  }

  const version = normalizeVersion(release.tag_name);
  if (!version) {
    throw new Error(
      msg(
        `无法解析版本号 ${release.tag_name || "(空)"}`,
        `Could not parse version ${release.tag_name || "(empty)"}`,
      ),
    );
  }
  const asset = pickAsset(tool, release.assets);
  if (!asset) {
    throw new Error(
      msg(
        `发布 ${release.tag_name} 没有适用于 ${PLATFORM}/${ARCH} 的 ${tool} 文件`,
        `Release ${release.tag_name} has no ${tool} asset for ${PLATFORM}/${ARCH}`,
      ),
    );
  }

  return {
    tool,
    version,
    tag: release.tag_name,
    htmlUrl: release.html_url || RELEASE_PAGES[tool],
    publishedAt: release.published_at || null,
    asset: {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size || 0,
    },
  };
}

/** Runs a tool's `--version` and extracts the semantic version. */
export async function detectToolVersion(tool) {
  const command = await resolveTool(tool);
  const result = await process.run(command, ["--version"], { timeoutMs: 8000 });
  if (result.code !== 0) {
    throw new Error(String(result.stderr || msg(`${tool} 退出码 ${result.code}`, `${tool} exited with ${result.code}`)).trim());
  }
  const version = normalizeVersion(result.stdout);
  if (!version) {
    throw new Error(
      msg(
        `无法从版本输出中解析版本号：${String(result.stdout).trim()}`,
        `Could not parse a version from: ${String(result.stdout).trim()}`,
      ),
    );
  }
  return version;
}

async function chmodExecutable(file) {
  if (WINDOWS) return;
  for (const candidate of ["/bin/chmod", "/usr/bin/chmod"]) {
    try {
      const result = await process.run(candidate, ["+x", file], { timeoutMs: 10000 });
      if (result.code === 0) return;
    } catch (error) {
      // Try the other path.
    }
  }
  throw new Error(msg("找不到 chmod，无法为更新的可执行文件设置权限", "chmod was not found; cannot make the updated tool executable"));
}

async function removeIfPresent(file) {
  try {
    if (await fs.exists(file)) await fs.unlink(file);
  } catch (error) {
    // Best effort.
  }
}

async function removeTree(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await removeTree(target);
      else await fs.unlink(target);
    }
    await fs.rmdir(directory);
  } catch (error) {
    // Best effort.
  }
}

async function installManagedBinaryFromPath(tool, stagedPath) {
  const target = managedToolPath(tool);
  if (!target) {
    throw new Error(msg("应用没有数据目录，无法安装更新", "The application has no data directory; cannot install updates"));
  }

  const temporary = `${target}.new`;
  if (stagedPath !== temporary) {
    await removeIfPresent(temporary);
    await fs.rename(stagedPath, temporary);
  }
  await chmodExecutable(temporary);

  const backup = `${target}.bak`;
  await removeIfPresent(backup);
  const hadPrevious = await fs.exists(target);
  if (hadPrevious) {
    await fs.rename(target, backup);
  }

  try {
    await fs.rename(temporary, target);
    const version = await detectToolVersion(tool);
    return version;
  } catch (error) {
    await removeIfPresent(target);
    if (hadPrevious) {
      try {
        await fs.rename(backup, target);
      } catch (restoreError) {
        // Leave the backup in place for manual recovery.
      }
    }
    throw new Error(
      msg(
        `新版本无法运行，已回滚：${error && error.message ? error.message : String(error)}`,
        `The new version failed to run and was rolled back: ${error && error.message ? error.message : String(error)}`,
      ),
    );
  }
}

async function extractArchive(archivePath, destination, archiveName, dataDir) {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = WINDOWS ? [`${systemRoot}\\System32\\tar.exe`] : ["/usr/bin/tar", "/bin/tar"];
  const lower = archiveName.toLowerCase();
  const args = lower.endsWith(".zip")
    ? ["-xf", archivePath, "-C", destination]
    : ["-xzf", archivePath, "-C", destination];

  let lastError = "";
  for (const tar of candidates) {
    try {
      const result = await process.run(tar, args, { timeoutMs: 60000, cwd: dataDir });
      if (result.code === 0) return;
      lastError = String(result.stderr || msg(`tar 退出码 ${result.code}`, `tar exited with ${result.code}`)).trim();
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
  }
  throw new Error(
    msg(`解压失败：${lastError || "找不到 tar"}`, `Extraction failed: ${lastError || "tar not found"}`),
  );
}

async function findBinary(directory, wanted) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return null;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findBinary(target, wanted);
      if (found) return found;
    } else if (wanted.includes(entry.name.toLowerCase())) {
      return target;
    }
  }
  return null;
}

/**
 * Downloads, extracts and installs one tool release into the application data
 * directory. Returns the version the new executable reports.
 */
export async function downloadAndInstall(tool, info) {
  const dataDir = process.dataDir;
  if (!dataDir) {
    throw new Error(msg("应用没有数据目录，无法安装更新", "The application has no data directory; cannot install updates"));
  }
  if (!info || !info.asset || !info.asset.url) {
    throw new Error(msg("没有可下载的发布包", "No downloadable release asset"));
  }

  const target = managedToolPath(tool);
  if (!target) {
    throw new Error(msg("应用没有数据目录，无法安装更新", "The application has no data directory; cannot install updates"));
  }
  const toolsDir = path.dirname(target);
  await fs.mkdir(toolsDir, { recursive: true });
  const staged = `${target}.new`;
  await removeIfPresent(staged);

  const assetName = String(info.asset.name || "");
  const lower = assetName.toLowerCase();
  const archive = lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");

  if (!archive) {
    try {
      const size = await downloadFileWithXh(info.asset.url, staged, 300);
      if (info.asset.size && size !== info.asset.size) {
        throw new Error(
          msg(
            `下载大小不符：期望 ${info.asset.size} 字节，实际 ${size} 字节`,
            `Downloaded size mismatch: expected ${info.asset.size} bytes, got ${size}`,
          ),
        );
      }
      return await installManagedBinaryFromPath(tool, staged);
    } finally {
      await removeIfPresent(staged);
    }
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suffix = lower.endsWith(".zip") ? ".zip" : ".tar.gz";
  const archivePath = path.join(dataDir, `jqui-update-${stamp}${suffix}`);
  const destination = path.join(dataDir, `jqui-update-${stamp}-dir`);

  try {
    const size = await downloadFileWithXh(info.asset.url, archivePath, 300);
    if (info.asset.size && size !== info.asset.size) {
      throw new Error(`下载大小不符：期望 ${info.asset.size} 字节，实际 ${size} 字节`);
    }
    await fs.mkdir(destination, { recursive: true });
    await extractArchive(archivePath, destination, assetName, dataDir);
    const wanted = tool === "xh" ? ["xh.exe", "xh"] : ["jq.exe", "jq"];
    const binaryPath = await findBinary(destination, wanted);
    if (!binaryPath) throw new Error(msg("更新包里没有找到可执行文件", "The update archive does not contain an executable"));
    await fs.rename(binaryPath, staged);
    return await installManagedBinaryFromPath(tool, staged);
  } finally {
    await removeIfPresent(archivePath);
    await removeTree(destination);
    await removeIfPresent(staged);
  }
}
