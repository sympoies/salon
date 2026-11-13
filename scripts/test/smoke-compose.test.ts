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

const smokeSource = readFileSync(smoke, "utf8");

function run(fake: Fake, args: string[] = [], source = smokeSource) {
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
  compose)
    [[ "$#" == 6 && "$2" == -f && "$3" == "$COMPOSE_FILE" && "$4" == ps && "$5" == --quiet && "$6" == workspace ]] || exit 2
    printf '%s\\n' "${fake.id ?? "abc123"}" ;;
  inspect)
    [[ "$#" == 4 && "$2" == --format && "$3" == '{{.State.Health.Status}}' && "$4" == abc123 ]] || exit 2
    printf '%s\\n' "${fake.health ?? "healthy"}" ;;
  port)
    [[ "$#" == 3 && "$2" == abc123 && "$3" == 3000/tcp ]] || exit 2
    printf '%s\\n' "${fake.port ?? "127.0.0.1:3000"}" ;;
  exec)
    [[ "$#" == 5 && "$2" == abc123 && "$3" == sh && "$4" == -c && "$5" == 'grep -h "^Uid:" /proc/[0-9]*/status' ]] || exit 2
    printf '%b' "${fake.uids ?? "Uid:\\t1000\\t1000\\t1000\\t1000\\n"}" ;;
  *) exit 2 ;;
esac`);
    tool("curl", `exit ${fake.curl ?? 0}`);
    const entrypoint = join(root, "smoke.sh");
    writeFileSync(entrypoint, source);
    const result = spawnSync("bash", [entrypoint, ...args], {
      cwd: root, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, COMPOSE_FILE: args[0] ?? "compose.image.yaml" },
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

test("an explicit compose file reaches the Docker query", () => {
  assert.equal(run({}, ["./compose.image.yaml"]).status, 0);
});

for (const [name, original, wrong] of [
  ["compose file", 'docker compose -f "$compose_file"', 'docker compose -f absent.yaml'],
  ["compose subcommand", 'ps --quiet workspace', 'logs --quiet workspace'],
  ["compose flags", 'ps --quiet workspace', 'ps workspace'],
  ["health query", "{{.State.Health.Status}}", "{{.State.Status}}"],
  ["container ID", 'docker port "$container"', 'docker port other-container'],
  ["port query", '3000/tcp', '4000/tcp'],
  ["UID query", '/proc/[0-9]*/status', '/proc/1/status'],
]) {
  test(`the Docker fake rejects an incorrect ${name}`, () => {
    assert.ok(smokeSource.includes(original));
    const result = run({}, [], smokeSource.replace(original, wrong));
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /^FAIL /m);
  });
}
