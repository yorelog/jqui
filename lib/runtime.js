// Where this application's bundled tools live.
//
// `import.meta.url` is the only path the runtime hands a module, and it is a
// file: URL. From it we derive the application root, then look for xh/jq next
// to `main.js` before falling back to the host PATH.

import process from "process";

const MODULE_DIR = import.meta.url
  .replace(/^file:\/\//, "")
  .replace(/^\/[A-Za-z]:/, (match) => match.slice(1))
  .replace(/\/[^/]*$/, "");

export const APP_DIR = MODULE_DIR.replace(/\/lib$/, "");

export const WINDOWS =
  process.platform === "win32" ||
  process.platform === "windows" ||
  /^[A-Za-z]:/.test(APP_DIR) ||
  APP_DIR.includes("\\");

const PLATFORM_NAME = String(process.platform || "").toLowerCase();
export const PLATFORM = WINDOWS
  ? "windows"
  : PLATFORM_NAME === "darwin" || PLATFORM_NAME === "macos"
    ? "macos"
    : PLATFORM_NAME === "linux"
      ? "linux"
      : "other";

const ARCH_NAME = String(process.arch || "").toLowerCase();
export const ARCH =
  ARCH_NAME.includes("arm64") || ARCH_NAME.includes("aarch64")
    ? "arm64"
    : ARCH_NAME.includes("arm")
      ? "arm"
      : ARCH_NAME.includes("x86_64") || ARCH_NAME.includes("x64") || ARCH_NAME.includes("amd64")
        ? "x64"
        : ARCH_NAME.includes("ia32") || ARCH_NAME.includes("i386") || ARCH_NAME.includes("x86")
          ? "x86"
          : "unknown";

export function bundledToolPath(name) {
  const executable = WINDOWS ? `${name}.exe` : name;
  return `${APP_DIR}/${executable}`;
}

/** A tool installed by Jqui's own update panel, under the application data directory. */
export function managedToolPath(name) {
  if (!process.dataDir) return null;
  const executable = WINDOWS ? `${name}.exe` : name;
  return `${process.dataDir}/tools/${executable}`;
}

export function fallbackCommand(name) {
  return name;
}
