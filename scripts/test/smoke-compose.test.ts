import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const smoke = join(repo, "scripts/smoke-compose.sh");

type Fake = { id?: string; health?: string; port?: string; uids?: string; curl?: number };

function run(fake: Fake, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "salon-smoke-"));
  try {
    const bin = join(root, "bin");
    writeFileSync(join(root, "compose.image.yaml"), "services: {}\n");
    spawnSync("mkdir", [bin]);
    const tool = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    tool("docker", `case "$1" in
  compose) printf '%s\\n' "${fake.id ?? "abc123"}" ;;
  inspect) printf '%s\\n' "${fake.health ?? "healthy"}" ;;
  port) printf '%s\\n' "${fake.port ?? "127.0.0.1:3000"}" ;;
  exec) printf '%b' "${fake.uids ?? "Uid:\\t1000\\t1000\\t1000\\t1000\\n"}" ;;
esac`);
    tool("curl", `exit ${fake.curl ?? 0}`);
    const result = spawnSync("bash", [smoke, ...args], {
      cwd: root, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a healthy loopback non-root container passes every check", () => {
  const result = run({});
  assert.equal(result.status, 0);
  assert.deepEqual(result.out.trim().split("\n").map((line) => line.split(" ")[0]),
    ["PASS", "PASS", "PASS", "PASS", "PASS"]);
});

test("each failing check is named and exits 1", () => {
  const cases: [Fake, string][] = [
    [{ health: "starting" }, "container healthy"],
    [{ curl: 22 }, "healthz answers"],
    [{ port: "0.0.0.0:3000" }, "published port is loopback"],
    [{ port: "127.0.0.1:3000\n[::]:3000" }, "published port is loopback"],
    [{ uids: "Uid:\\t1000\\t1000\\t1000\\t1000\\nUid:\\t1000\\t0\\t0\\t0\\n" }, "process is non-root"],
    [{ uids: "" }, "process is non-root"],
  ];
  for (const [fake, name] of cases) {
    const result = run(fake);
    assert.equal(result.status, 1, name);
    assert.match(result.out, new RegExp(`^FAIL ${name}`, "m"));
  }
});

test("a missing container fails without probing", () => {
  const result = run({ id: "" });
  assert.equal(result.status, 1);
  assert.match(result.out, /^FAIL container running/m);
});

test("a missing compose file is a usage error", () => {
  const result = run({}, ["absent.yaml"]);
  assert.equal(result.status, 2);
  assert.match(result.err, /absent\.yaml/);
});

test("the pull-only compose differs from the build compose only in its image source", () => {
  const build = readFileSync(join(repo, "compose.yaml"), "utf8").split("\n");
  const pulled = readFileSync(join(repo, "compose.image.yaml"), "utf8").split("\n");
  const at = build.indexOf("    build: .");
  assert.ok(at > 0);
  assert.match(pulled[at], /^    image: \$\{SALON_IMAGE:\?.*\}$/);
  assert.deepEqual(pulled.filter((_, i) => i !== at), build.filter((_, i) => i !== at));
});
