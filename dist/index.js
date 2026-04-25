const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");

const getInput = (name, fallback = "") => process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] || fallback;
const isTrue = (value) => ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
const splitLines = (value) => String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

const commandEscape = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const propertyEscape = (value) => commandEscape(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

const setOutput = (name, value) => {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) fs.appendFileSync(outputPath, `${name}=${value}\n`);
};

const fail = (message) => {
  console.error(`::error::${commandEscape(message)}`);
  process.exitCode = 1;
};

const runnerPlatform = () => {
  const platform = process.platform;
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  throw new Error(`Unsupported runner platform: ${platform}`);
};

const runnerArch = () => {
  const arch = process.arch;
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  if (arch === "ia32") return "ia32";
  if (arch === "riscv64") return "riscv64";
  throw new Error(`Unsupported runner architecture: ${arch}`);
};

const defaultAssetCandidates = () => {
  const platform = runnerPlatform();
  const arch = runnerArch();

  if (platform === "win32") return [`emmylua_check-win32-${arch}.zip`];
  if (platform === "darwin") return [`emmylua_check-darwin-${arch}.tar.gz`];
  if (platform === "linux" && arch === "x64") return ["emmylua_check-linux-x64-glibc.2.17.tar.gz", "emmylua_check-linux-x64.tar.gz"];
  if (platform === "linux" && arch === "arm64") return ["emmylua_check-linux-arm64-glibc.2.17.tar.gz"];
  if (platform === "linux" && arch === "riscv64") return ["emmylua_check-linux-riscv64.tar.gz"];

  throw new Error(`No default asset for ${platform}/${arch}`);
};

const requestJson = async ({ url, token }) => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "emmylua-check-action" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  return response.json();
};

const downloadFile = async ({ url, token, destination }) => {
  const headers = { "User-Agent": "emmylua-check-action" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
};

const run = (command, args, options = {}) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

const trimNulls = (value) => value.replace(/\0.*$/u, "").trim();

const tarString = (buffer, offset, length) => trimNulls(buffer.subarray(offset, offset + length).toString("utf8"));

const tarNumber = (buffer, offset, length) => {
  const value = tarString(buffer, offset, length);
  return value ? Number.parseInt(value, 8) : 0;
};

const safeExtractPath = ({ destination, entryName }) => {
  const normalized = entryName.split("/").filter(Boolean).join(path.sep);
  const target = path.resolve(destination, normalized);
  const root = path.resolve(destination);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe archive path: ${entryName}`);
  return target;
};

const isEmptyTarBlock = (buffer, offset) => {
  for (let index = offset; index < offset + 512; index += 1) {
    if (buffer[index] !== 0) return false;
  }
  return true;
};

const extractTarBuffer = ({ buffer, destination }) => {
  for (let offset = 0; offset + 512 <= buffer.length;) {
    if (isEmptyTarBlock(buffer, offset)) break;

    const name = tarString(buffer, offset, 100);
    const mode = tarNumber(buffer, offset + 100, 8) || 0o644;
    const size = tarNumber(buffer, offset + 124, 12);
    const type = tarString(buffer, offset + 156, 1) || "0";
    const prefix = tarString(buffer, offset + 345, 155);
    const entryName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (entryName && type === "5") {
      fs.mkdirSync(safeExtractPath({ destination, entryName }), { recursive: true });
    } else if (entryName && (type === "0" || type === "")) {
      const target = safeExtractPath({ destination, entryName });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer.subarray(dataStart, dataEnd));
      fs.chmodSync(target, mode);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
};

const extractArchive = async ({ archivePath, destination }) => {
  fs.mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    extractTarBuffer({ buffer: zlib.gunzipSync(fs.readFileSync(archivePath)), destination });
    return;
  }

  const args = ["-xf", archivePath, "-C", destination];
  const result = await run("tar", args);
  if (result.code !== 0) throw new Error(`Failed to extract ${archivePath}`);
};

const findBinary = (directory) => {
  const wanted = process.platform === "win32" ? "emmylua_check.exe" : "emmylua_check";
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findBinary(fullPath);
      if (found) return found;
    } else if (entry.name === wanted || (process.platform !== "win32" && entry.name === "emmylua_check")) {
      return fullPath;
    }
  }

  return null;
};

const verifyDigest = ({ filePath, digest }) => {
  if (!digest || !digest.startsWith("sha256:")) return;
  const expected = digest.slice("sha256:".length).toLowerCase();
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${path.basename(filePath)}`);
};

const releaseUrl = ({ repository, version }) => version === "latest"
  ? `https://api.github.com/repos/${repository}/releases/latest`
  : `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(version)}`;

const resolveReleaseAsset = async ({ repository, version, assetName, token }) => {
  const release = await requestJson({ url: releaseUrl({ repository, version }), token });
  const candidates = assetName ? [assetName] : defaultAssetCandidates();
  const asset = candidates.map((candidate) => release.assets.find((item) => item.name === candidate)).find(Boolean);

  if (!asset) {
    const available = release.assets.map((item) => item.name).filter((name) => name.startsWith("emmylua_check")).join(", ");
    throw new Error(`No matching emmylua_check release asset. Tried: ${candidates.join(", ")}. Available: ${available}`);
  }

  return { release, asset };
};

const severityName = (severity) => {
  if (severity === 1 || severity === "error") return "error";
  if (severity === 2 || severity === "warning") return "warning";
  return "notice";
};

const relativeFile = (file) => {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const relative = path.relative(workspace, file);
  const output = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  return output.split(path.sep).join("/");
};

const annotateDiagnostic = ({ file, diagnostic }) => {
  const range = diagnostic.range || {};
  const start = range.start || {};
  const end = range.end || {};
  const line = Number.isInteger(start.line) ? start.line + 1 : 1;
  const col = Number.isInteger(start.character) ? start.character + 1 : 1;
  const endLine = Number.isInteger(end.line) ? end.line + 1 : line;
  const endColumn = Number.isInteger(end.character) ? end.character + 1 : col;
  const title = diagnostic.code || diagnostic.source || "EmmyLua";
  const message = diagnostic.message || "EmmyLua diagnostic";
  const level = severityName(diagnostic.severity);
  const properties = [
    `file=${propertyEscape(relativeFile(file))}`,
    `line=${line}`,
    `col=${col}`,
    `endLine=${endLine}`,
    `endColumn=${endColumn}`,
    `title=${propertyEscape(title)}`,
  ].join(",");

  console.log(`::${level} ${properties}::${commandEscape(message)}`);
};

const collectDiagnostics = (jsonPath) => {
  if (!fs.existsSync(jsonPath) || fs.statSync(jsonPath).size === 0) return [];
  return collectDiagnosticsFromJson(fs.readFileSync(jsonPath, "utf8"));
};

const collectDiagnosticsFromJson = (text) => {
  if (!text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return [];
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  return reports.flatMap((report) => (report.diagnostics || []).map((diagnostic) => ({ file: report.file, diagnostic })));
};

const optionValue = ({ args, names }) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of names) {
      if (arg === name) return args[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
};

const hasAnyArg = ({ args, names }) => args.some((arg) => names.includes(arg));

const parseShellArgs = (value) => {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/u.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in args input");
  if (current) args.push(current);
  return args;
};

const parseArgsInput = (value) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) throw new Error("args JSON must be an array of strings");
    return parsed;
  }
  return parseShellArgs(trimmed);
};

const buildManagedCheckArgs = ({ jsonPath }) => {
  const workspace = splitLines(getInput("workspace", "."));
  const config = splitLines(getInput("config"));
  const ignore = getInput("ignore").trim();
  const args = [];

  for (const configPath of config) args.push("--config", configPath);
  if (ignore) args.push("--ignore", ignore);
  args.push("--output-format", "json", "--output", jsonPath);
  if (isTrue(getInput("warnings-as-errors"))) args.push("--warnings-as-errors");
  if (isTrue(getInput("verbose"))) args.push("--verbose");
  args.push(...(workspace.length ? workspace : ["."]));

  return args;
};

const buildCheck = ({ jsonPath, workingDirectory, annotate }) => {
  const customArgs = parseArgsInput(getInput("args"));
  if (!customArgs) return { args: buildManagedCheckArgs({ jsonPath }), diagnosticsSource: { kind: "file", path: jsonPath } };

  if (!annotate || hasAnyArg({ args: customArgs, names: ["--help", "-h", "--version", "-V"] })) {
    return { args: customArgs, diagnosticsSource: null };
  }

  const outputFormat = optionValue({ args: customArgs, names: ["--output-format", "-f"] });
  const output = optionValue({ args: customArgs, names: ["--output"] });
  if (!outputFormat) return { args: ["--output-format", "json", "--output", jsonPath, ...customArgs], diagnosticsSource: { kind: "file", path: jsonPath } };
  if (outputFormat !== "json") return { args: customArgs, diagnosticsSource: null };
  if (!output || output === "stdout") return { args: customArgs, diagnosticsSource: { kind: "stdout" } };

  return { args: customArgs, diagnosticsSource: { kind: "file", path: path.resolve(workingDirectory, output) } };
};

const collectDiagnosticsFromSource = ({ source, stdout }) => {
  if (!source) return [];
  if (source.kind === "stdout") return collectDiagnosticsFromJson(stdout);
  return collectDiagnostics(source.path);
};

const main = async () => {
  const repository = getInput("repository", "EmmyLuaLs/emmylua-analyzer-rust");
  const version = getInput("version", "latest").trim();
  const assetName = getInput("asset").trim();
  const token = getInput("token").trim();
  const workRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const workingDirectory = path.resolve(workRoot, getInput("working-directory", "."));
  const tempRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "emmylua-check-action-"));

  const { release, asset } = await resolveReleaseAsset({ repository, version, assetName, token });
  const archivePath = path.join(tempRoot, asset.name);
  const extractPath = path.join(tempRoot, "bin");
  const jsonPath = path.join(tempRoot, "diagnostics.json");

  console.log(`Downloading ${repository}@${release.tag_name} (${asset.name})`);
  await downloadFile({ url: asset.browser_download_url, token, destination: archivePath });
  verifyDigest({ filePath: archivePath, digest: asset.digest });
  await extractArchive({ archivePath, destination: extractPath });

  const binary = findBinary(extractPath);
  if (!binary) throw new Error("emmylua_check binary was not found in the release asset");
  if (process.platform !== "win32") fs.chmodSync(binary, 0o755);

  const annotate = isTrue(getInput("annotate", "true"));
  const { args, diagnosticsSource } = buildCheck({ jsonPath, workingDirectory, annotate });
  console.log(`Running emmylua_check ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  const result = await run(binary, args, { cwd: workingDirectory });
  const diagnostics = collectDiagnosticsFromSource({ source: diagnosticsSource, stdout: result.stdout });

  if (annotate) {
    if (!diagnosticsSource) console.warn("Annotations are enabled, but diagnostics were not collected because custom args did not request JSON output.");
    for (const item of diagnostics) annotateDiagnostic(item);
  }

  const errors = diagnostics.filter(({ diagnostic }) => severityName(diagnostic.severity) === "error").length;
  const warnings = diagnostics.filter(({ diagnostic }) => severityName(diagnostic.severity) === "warning").length;

  setOutput("version", release.tag_name);
  setOutput("asset", asset.name);
  setOutput("diagnostics", diagnostics.length);
  setOutput("errors", errors);
  setOutput("warnings", warnings);

  console.log(`emmylua_check reported ${diagnostics.length} diagnostics (${errors} errors, ${warnings} warnings)`);
  if (result.code !== 0) fail(`emmylua_check failed with exit code ${result.code}`);
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
