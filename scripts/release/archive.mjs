import { inflateRawSync } from "node:zlib";

import { MAX_ARTIFACT_BYTES, exactObjectKeys, sha256Bytes } from "./lib.mjs";

const TAR_BLOCK_BYTES = 512;
const MAX_UNCOMPRESSED_TAR_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const NPM_PORTABLE_MTIME = 499162500;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const WINDOWS_RESERVED_NAME = /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

export function inspectNpmArchive(archiveBytes) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0 || archiveBytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error("npm archive is empty or exceeds the release size limit");
  }
  if (archiveBytes.length < 18 ||
      archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b || archiveBytes[2] !== 8) {
    throw new Error("Release artifact is not a gzip-compressed tar archive");
  }
  if (archiveBytes[3] !== 0 || archiveBytes.readUInt32LE(4) !== 0 ||
      archiveBytes[8] !== 2 || archiveBytes[9] !== 255) {
    throw new Error("Release artifact has non-deterministic gzip header metadata");
  }

  let tar;
  let compressedBytes;
  try {
    const inflated = inflateRawSync(archiveBytes.subarray(10), {
      info: true,
      maxOutputLength: MAX_UNCOMPRESSED_TAR_BYTES,
    });
    tar = inflated.buffer;
    compressedBytes = inflated.engine.bytesWritten;
  } catch (error) {
    throw new Error("Release artifact could not be decompressed within the size limit", { cause: error });
  }
  const trailerOffset = 10 + compressedBytes;
  if (trailerOffset + 8 !== archiveBytes.length ||
      archiveBytes.readUInt32LE(trailerOffset) !== crc32(tar) ||
      archiveBytes.readUInt32LE(trailerOffset + 4) !== (tar.length >>> 0)) {
    throw new Error("Release artifact has invalid or concatenated gzip framing");
  }
  if (tar.length < TAR_BLOCK_BYTES * 2 || tar.length % TAR_BLOCK_BYTES !== 0) {
    throw new Error("Release tar archive is truncated or misaligned");
  }

  const entries = [];
  const paths = new Set();
  const portablePaths = new Set();
  let packageJsonBytes;
  let offset = 0;
  let terminated = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (offset + TAR_BLOCK_BYTES >= tar.length ||
          !isZeroBlock(tar.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_BLOCK_BYTES * 2))) {
        throw new Error("Release tar archive does not end with two zero blocks");
      }
      for (let index = offset; index < tar.length; index += 1) {
        if (tar[index] !== 0) throw new Error("Release tar archive contains data after its terminator");
      }
      terminated = true;
      break;
    }

    validateChecksum(header);
    const type = tarString(header, 156, 1, "entry type");
    if (type !== "" && type !== "0") throw new Error(`Release archive contains a non-regular entry type: ${type}`);
    const linkName = tarString(header, 157, 100, "link name");
    if (linkName !== "") throw new Error("Release archive contains a link target");
    const magic = tarString(header, 257, 6, "ustar magic");
    if (magic !== "ustar") throw new Error("Release archive is not in the expected ustar format");
    if (tarString(header, 263, 2, "ustar version") !== "00" ||
        tarString(header, 265, 32, "owner name") !== "" ||
        tarString(header, 297, 32, "group name") !== "" ||
        octalNumber(header, 329, 8, "device major") !== 0 ||
        octalNumber(header, 337, 8, "device minor") !== 0) {
      throw new Error("Release archive contains non-portable ustar identity metadata");
    }

    const name = tarString(header, 0, 100, "entry name");
    const prefix = tarString(header, 345, 155, "entry prefix");
    const archivePath = prefix === "" ? name : `${prefix}/${name}`;
    const portablePath = validateArchivePath(archivePath);
    if (paths.has(archivePath)) throw new Error(`Release archive contains a duplicate path: ${archivePath}`);
    if (portablePaths.has(portablePath)) {
      throw new Error(`Release archive contains paths that collide on a portable filesystem: ${archivePath}`);
    }
    paths.add(archivePath);
    portablePaths.add(portablePath);
    if (paths.size > MAX_ARCHIVE_ENTRIES) throw new Error("Release archive contains too many entries");

    const mode = octalNumber(header, 100, 8, "mode");
    const uid = octalNumber(header, 108, 8, "uid");
    const gid = octalNumber(header, 116, 8, "gid");
    const size = octalNumber(header, 124, 12, "size");
    const mtime = octalNumber(header, 136, 12, "mtime");
    if (mode !== 0o644 && mode !== 0o755) throw new Error(`Release archive has a non-portable mode: ${archivePath}`);
    if (uid !== 0 || gid !== 0) throw new Error(`Release archive records a non-portable owner: ${archivePath}`);
    if (mtime !== NPM_PORTABLE_MTIME) throw new Error(`Release archive has a non-deterministic timestamp: ${archivePath}`);
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`Release archive entry exceeds the size limit: ${archivePath}`);

    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`Release archive entry is truncated: ${archivePath}`);
    const nextHeader = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!isZeroBlock(tar.subarray(dataEnd, nextHeader))) {
      throw new Error(`Release archive contains non-zero entry padding: ${archivePath}`);
    }
    if (archivePath === "package/package.json") {
      if (size === 0 || size > MAX_PACKAGE_JSON_BYTES) throw new Error("Packed package.json is empty or too large");
      packageJsonBytes = tar.subarray(dataStart, dataEnd);
    }
    entries.push({
      path: archivePath,
      bytes: size,
      mode,
      sha256: sha256Bytes(tar.subarray(dataStart, dataEnd)),
    });
    offset = nextHeader;
  }
  if (!terminated || entries.length === 0) throw new Error("Release archive has no complete regular-file payload");
  if (packageJsonBytes === undefined) throw new Error("Release archive is missing package/package.json");

  return {
    entries,
    package: packageIdentity(packageJsonBytes),
  };
}

function validateArchivePath(value) {
  if (!value.startsWith("package/") || value.length > 240 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Unsafe release archive path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe release archive path: ${value}`);
  }
  for (const segment of segments) {
    if (segment.normalize("NFC") !== segment ||
        /[^\u0020-\u007e]/u.test(segment) ||
        /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error(`Release archive path is not portable: ${value}`);
    }
  }
  return segments.map((segment) => segment.toLowerCase()).join("/");
}

function validateChecksum(header) {
  const recorded = octalNumber(header, 148, 8, "checksum");
  let calculated = 0;
  for (let index = 0; index < header.length; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (recorded !== calculated) throw new Error("Release archive contains an invalid tar header checksum");
}

function octalNumber(buffer, offset, length, label) {
  const bytes = buffer.subarray(offset, offset + length);
  if ((bytes[0] & 0x80) !== 0) throw new Error(`Release archive uses unsupported base-256 ${label}`);
  const value = byteString(buffer, offset, length).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error(`Release archive contains an invalid octal ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Release archive ${label} is out of range`);
  return parsed;
}

function byteString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator < 0 ? field : field.subarray(0, terminator);
  return utf8.decode(bytes);
}

function tarString(buffer, offset, length, label) {
  const field = buffer.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  if (terminator >= 0 && !isZeroBlock(field.subarray(terminator))) {
    throw new Error(`Release archive contains hidden data in its ${label} field`);
  }
  const bytes = terminator < 0 ? field : field.subarray(0, terminator);
  return utf8.decode(bytes);
}

function isZeroBlock(block) {
  return block.every((value) => value === 0);
}

function packageIdentity(bytes) {
  let document;
  try {
    document = JSON.parse(utf8.decode(bytes));
  } catch (error) {
    throw new Error("Packed package.json is not valid UTF-8 JSON", { cause: error });
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Packed package.json must be an object");
  }
  exactObjectKeys(document.bin, ["cope", "copilot-agent"], "Packed package bin");
  if (typeof document.name !== "string" || typeof document.version !== "string" ||
      document.bin.cope !== "dist/src/cli/main.js" ||
      document.bin["copilot-agent"] !== "dist/src/cli/main.js") {
    throw new Error("Packed package.json has an unexpected name, version, or executable mapping");
  }
  const dependencies = document.dependencies ?? {};
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies) ||
      Object.keys(dependencies).length > 1000 ||
      Object.entries(dependencies).some(([name, version]) =>
        name.length > 214 || !NPM_PACKAGE_NAME.test(name) ||
        typeof version !== "string" || version.length === 0 || version.length > 256)) {
    throw new Error("Packed package.json has invalid runtime dependency metadata");
  }
  return {
    name: document.name,
    version: document.version,
    bin: {
      cope: document.bin.cope,
      "copilot-agent": document.bin["copilot-agent"],
    },
    dependencies,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
