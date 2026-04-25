const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const action = path.join(root, "dist", "index.js");
const version = "0.22.0";

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runAction = ({ workspace, inputs = {} }) => new Promise((resolve) => {
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-action-runner-")),
    PATH: path.dirname(process.execPath),
    INPUT_VERSION: version,
    INPUT_WORKING_DIRECTORY: ".",
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUT_${key.toUpperCase().replace(/-/g, "_")}`, value])),
  };

  const child = spawn(process.execPath, [action], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("passes on a clean workspace without host tar", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-clean-"));
  writeFile(path.join(workspace, "main.lua"), "local x = 1\nprint(x)\n");

  const result = await runAction({ workspace, inputs: { workspace: "." } });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /emmylua_check reported 0 diagnostics/);
});

test("emits annotations from config severities", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-diagnostics-"));
  writeFile(path.join(workspace, ".emmyrc.json"), JSON.stringify({ diagnostics: { severity: { "undefined-global": "error", "assign-type-mismatch": "warning" } } }));
  writeFile(path.join(workspace, "main.lua"), "---@type string\nlocal x = 1\nprint(y)\n");

  const result = await runAction({ workspace, inputs: { workspace: "." } });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /::error file=main\.lua,line=3,col=7,endLine=3,endColumn=8,title=undefined-global::undefined global variable: y/);
  assert.match(result.stdout, /::warning file=main\.lua,line=2,col=7,endLine=2,endColumn=8,title=assign-type-mismatch::Cannot assign `integer` to `string`\./);
});

test("accepts raw emmylua_check args", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emmylua-check-args-"));
  writeFile(path.join(workspace, "src", "main.lua"), "local x = 1\nprint(x)\n");

  const result = await runAction({ workspace, inputs: { args: JSON.stringify(["src"]) } });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Running emmylua_check "--output-format" "json" "--output"/);
  assert.match(result.stdout, /"src"/);
  assert.match(result.stdout, /emmylua_check reported 0 diagnostics/);
});
