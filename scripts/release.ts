// Bumps the version in deno.json, commits, tags and pushes.
// The publish workflow takes it from there.
//
//   deno task release patch|minor|major|x.y.z

const arg = Deno.args[0];
if (!arg) {
  console.error("Usage: deno task release <patch|minor|major|x.y.z>");
  Deno.exit(1);
}

function run(...cmd: string[]): string {
  const result = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "inherit",
  }).outputSync();
  if (!result.success) Deno.exit(result.code);
  return new TextDecoder().decode(result.stdout).trim();
}

if (run("git", "status", "--porcelain") !== "") {
  console.error("Working tree is not clean; commit or stash first.");
  Deno.exit(1);
}

const config = JSON.parse(await Deno.readTextFile("deno.json"));
const [major, minor, patch] = String(config.version).split(".").map(Number);
const bumps: Record<string, string> = {
  patch: `${major}.${minor}.${patch + 1}`,
  minor: `${major}.${minor + 1}.0`,
  major: `${major + 1}.0.0`,
};
const version = bumps[arg] ?? arg;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  Deno.exit(1);
}

config.version = version;
await Deno.writeTextFile("deno.json", JSON.stringify(config, null, 2) + "\n");
run("deno", "fmt", "deno.json");
run("git", "commit", "-am", `v${version}`);
run("git", "tag", `v${version}`);
run("git", "push", "origin", "HEAD", `v${version}`);
console.log(`Pushed v${version}. The publish workflow will release it.`);
