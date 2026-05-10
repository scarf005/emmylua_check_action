const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const installer = path.join(root, "scripts", "install.sh");
const version = "0.22.0";

const copyFixture = (name, workspace) => {
  fs.cpSync(path.join(__dirname, "fixtures", name), workspace, { recursive: true });
};

const parseOutputFile = (file) => Object.fromEntries(
  fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

const run = ({ command, args, env = {}, cwd = root }) => new Promise((resolve) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("close", (code) => resolve({ code, stdout, stderr }));
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

  return { ...result, outputs: parseOutputFile(outputFile), pathFile };
};

test("installs emmylua_check for Ubuntu runners", async (t) => {
  if (process.platform !== "linux") {
    t.skip("installer only supports Linux");
    return;
  }

  const result = await runInstall();

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.outputs.version, version);
  assert.match(result.outputs.asset, /^emmylua_check-linux-(x64|aarch64|arm64).*\.tar\.gz$/);
  assert.ok(fs.existsSync(result.outputs.path));
  assert.match(fs.readFileSync(result.pathFile, "utf8"), new RegExp(`${path.dirname(result.outputs.path)}\\n`));

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-clean-"));
  const jsonPath = path.join(workspace, "diagnostics.json");
  copyFixture("clean", workspace);

  const check = await run({
    command: result.outputs.path,
    args: ["--output-format", "json", "--output", jsonPath, "."],
    cwd: workspace,
  });

  assert.equal(check.code, 0, `${check.stdout}\n${check.stderr}`);
  assert.ok(fs.existsSync(jsonPath));
});
