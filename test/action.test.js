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
const cases = [
  {
    name: "emmylua_check catches invalid local assignment type",
    fixture: "invalid-local-assignment",
    code: "assign-type-mismatch",
    message: "Cannot assign `integer` to `string`",
  },
  {
    name: "emmylua_check catches invalid function argument type",
    fixture: "invalid-function-argument",
    code: "param-type-mismatch",
    message: "expected `string` but found `42`",
  },
  {
    name: "emmylua_check catches invalid return value type",
    fixture: "invalid-return-value",
    code: "return-type-mismatch",
    message: "return value 1 has a type of `string`",
  },
  {
    name: "emmylua_check catches undefined globals",
    fixture: "undefined-global",
    code: "undefined-global",
    message: "undefined global variable: missing_value",
  },
  {
    name: "emmylua_check catches undefined class fields",
    fixture: "undefined-class-field",
    code: "undefined-field",
    message: "Undefined field `age`",
  },
  {
    name: "emmylua_check catches missing return values",
    fixture: "missing-return-value",
    code: "missing-return",
    message: "return value is required",
  },
  {
    name: "emmylua_check catches missing function arguments",
    fixture: "missing-function-argument",
    code: "missing-parameter",
    message: "missing parameter: right",
  },
  {
    name: "emmylua_check catches redundant function arguments",
    fixture: "redundant-function-argument",
    code: "redundant-parameter",
    message: "expected 1 parameters but found 2",
  },
  {
    name: "emmylua_check catches type errors from multiple files",
    fixture: "multi-file-type-error",
    code: "assign-type-mismatch",
    message: "Cannot assign `string` to `integer`",
  },
  {
    name: "emmylua_check catches unknown documented types",
    fixture: "unknown-doc-type",
    code: "type-not-found",
    message: "Type 'MissingType' not found",
  },
];

const config = {
  diagnostics: {
    severity: Object.fromEntries(cases.map(({ code }) => [code, "error"])),
  },
};

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

const copyFixture = ({ fixture, workspace }) => {
  fs.cpSync(path.join(casesRoot, fixture), workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, ".emmyrc.json"), `${JSON.stringify(config)}\n`);
};

test("has 10 diagnostic Lua fixture cases", () => {
  assert.equal(cases.length, 10);
  for (const { fixture } of cases) {
    const files = fs.readdirSync(path.join(casesRoot, fixture)).filter((name) => name.endsWith(".lua"));
    assert.ok(files.length > 0, `${fixture} should contain Lua files`);
  }
});

for (const item of cases) {
  test(item.name, async () => {
    const binary = await resolveEmmyluaCheck();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `emmylua-check-${item.fixture}-`));
    const jsonPath = path.join(workspace, "diagnostics.json");
    copyFixture({ fixture: item.fixture, workspace });

    const result = await run({
      command: binary,
      args: ["--output-format", "json", "--output", jsonPath, "."],
      cwd: workspace,
    });
    const diagnostics = diagnosticsFromJson(jsonPath);
    const diagnostic = diagnostics.find(({ code }) => code === item.code);

    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(diagnostic, `Expected ${item.code}; got ${diagnostics.map(({ code }) => code).join(", ")}`);
    assert.equal(diagnostic.severity, 1);
    assert.match(diagnostic.message, new RegExp(item.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}
