const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const installer = path.join(root, "scripts", "install.sh");
const version = "0.22.0";
const casesRoot = path.join(__dirname, "fixtures", "lua-cases");
const cases = fs.readdirSync(casesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const parseOutputFile = (file) => Object.fromEntries(
  fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

const run = ({ command, args = [], env = {}, cwd = root }) => new Promise((resolve) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let done = false;
  const finish = (result) => {
    if (!done) {
      done = true;
      resolve(result);
    }
  };

  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => finish({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (code) => finish({ code, stdout, stderr }));
});

const runInstall = async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-action-test-"));
  const outputFile = path.join(temp, "output");
  const pathFile = path.join(temp, "path");
  const result = await run({
    command: "bash",
    args: [installer],
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_PATH: pathFile,
      RUNNER_TEMP: temp,
      INPUT_VERSION: version,
    },
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const outputs = parseOutputFile(outputFile);
  assert.equal(outputs.version, version);
  assert.match(outputs.asset, /^emmylua_check-linux-(x64|aarch64|arm64).*\.tar\.gz$/);
  assert.ok(fs.existsSync(outputs.path));
  assert.match(fs.readFileSync(pathFile, "utf8"), new RegExp(`${path.dirname(outputs.path)}\\n`));
  return outputs.path;
};

let binaryPromise;
const resolveEmmyluaCheck = () => {
  binaryPromise ||= (async () => {
    const fromPath = await run({ command: "emmylua_check", args: ["--version"] });
    if (fromPath.code === 0 && `${fromPath.stdout}${fromPath.stderr}`.includes(version)) return "emmylua_check";
    if (process.platform !== "linux") throw new Error("emmylua_check is not on PATH and installer only supports Linux");
    return runInstall();
  })();

  return binaryPromise;
};

const diagnosticsFromJson = (jsonPath) => {
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  return reports.flatMap((report) => report.diagnostics || []);
};

test("has at least 10 Lua fixture cases", () => {
  assert.ok(cases.length >= 10);
});

for (const caseName of cases) {
  test(`emmylua_check accepts ${caseName}`, async () => {
    const binary = await resolveEmmyluaCheck();
    const source = path.join(casesRoot, caseName);
    const luaFiles = fs.readdirSync(source).filter((name) => name.endsWith(".lua"));
    assert.ok(luaFiles.length > 0);

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `emmylua-check-${caseName}-`));
    const jsonPath = path.join(workspace, "diagnostics.json");
    fs.cpSync(source, workspace, { recursive: true });

    const result = await run({
      command: binary,
      args: ["--output-format", "json", "--output", jsonPath, "."],
      cwd: workspace,
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(diagnosticsFromJson(jsonPath), []);
  });
}
