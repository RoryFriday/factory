import { spawn } from "child_process";
import { GateResult } from "./env.js";

/**
 * Runs a single gate using the TARGET REPO's OWN docker-compose.yml.
 *
 * IMPORTANT: unlike agentRunner.ts, this subprocess call does NOT go
 * through docker.sock as a sibling container -- it runs `docker compose`
 * directly inside the WORKER's own process. That means `cwd` must be a
 * path that exists inside the worker container's OWN filesystem, i.e. the
 * container-internal mount point (/target-repo/src, per docker-compose.yml's
 * `${TARGET_REPO_PATH}:/target-repo` volume) -- NOT env.hostTargetRepoPath,
 * which is a host filesystem path the worker container has no visibility
 * into. (This is the same host-vs-container distinction documented in
 * agentRunner.ts, applied the other way: that file launches a SIBLING
 * container via the socket and therefore needs a HOST path; this file
 * runs in-process and therefore needs a CONTAINER-internal path.)
 *
 * The `docker compose` CLI invoked here still talks to the HOST daemon
 * (via the same mounted docker.sock), but build contexts/relative paths
 * inside the target repo's compose file are resolved by the CLI relative
 * to where it's invoked from -- which is this worker container's mount of
 * the repo, not the host's copy of it. Since the target repo's own
 * docker-compose.yml only uses relative paths (context: ./backend, etc.,
 * per its AGENTS.md), this resolves correctly without further changes.
 */
const TARGET_REPO_MOUNT = "/target-repo"; // worker's own mount, see docker-compose.yml

export async function runGate(gateType: string, composeArgs: string[]): Promise<GateResult> {
  const cwd = `${TARGET_REPO_MOUNT}/src`;

  console.log(`Running gate '${gateType}': docker compose ${composeArgs.join(" ")} (cwd=${cwd})`);

  return new Promise((resolve) => {
    const child = spawn("docker", ["compose", ...composeArgs], { cwd });

    let output = "";
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15 * 60 * 1000); // 15 min cap per gate, tune once you've seen real durations

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      resolve({
        gateType,
        status: "failed",
        detail: `Failed to spawn docker compose: ${err.message}\n${output}`.slice(-10000),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      resolve({
        gateType,
        status: code === 0 ? "passed" : "failed",
        // truncate; full output belongs in the agent run log, not here
        detail: output.slice(-10000),
      });
    });
  });
}