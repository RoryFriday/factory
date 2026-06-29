import { spawn } from "child_process";
import { createWriteStream, writeFileSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { env, AgentRunResult, PbiRow } from "./env.js";

/**
 * Launches a pi-sandbox container as a SIBLING of this worker container,
 * via the host docker.sock mounted into the worker. Runs `pi --mode rpc
 * --no-session` against the given PBI and captures the structured JSON
 * event stream.
 *
 * IMPORTANT: env.hostTargetRepoPath is a HOST filesystem path, not a path
 * inside this worker container. The mounted docker.sock talks to the HOST
 * daemon, which resolves -v mount sources against the host filesystem --
 * it has no visibility into this container's own mount namespace. Passing
 * this worker's own /target-repo path here would silently fail or mount
 * the wrong thing on the host.
 *
 * RPC schema confirmed against the official docs (https://pi.dev/docs/latest/rpc):
 *   - launch: `pi --mode rpc --no-session`
 *   - request (stdin, one JSON object per line):
 *       {"type": "prompt", "message": "<prompt text>"}
 *   - the prompt command's own `response` (type: "response", command:
 *     "prompt") only confirms ACCEPTANCE, not completion -- success:false
 *     here means the prompt was rejected outright (e.g. malformed), and
 *     we treat that as an immediate failure rather than waiting for
 *     agent_end, which will never arrive in that case.
 *   - events stream as the agent runs; the ones we act on:
 *       message_update -> assistantMessageEvent.type === "text_delta"
 *         (incremental text, useful for live logging, NOT relied on for
 *         the final summary -- see agent_end below)
 *       message_update -> assistantMessageEvent.type === "error"
 *         (signals a problem mid-stream; reason is "aborted" or "error")
 *       agent_end -> { messages: [...] } -- the authoritative final
 *         state. We pull the summary from the LAST assistant message's
 *         text content here, rather than concatenating every text_delta,
 *         since deltas can interleave across multiple turns/tool calls in
 *         ways that make naive concatenation misleading.
 *       extension_error -> logged, but no extensions are configured in
 *         this project's AGENTS.md setup, so this is not expected to fire.
 *   - agent_end does NOT carry a success/failure field of its own -- the
 *     process exit code remains the primary success/failure signal, with
 *     the prompt-rejection and message_update error cases above as
 *     additional, earlier failure signals we now also catch.
 *   - Framing: strict JSONL, LF only. We deliberately do NOT use Node's
 *     `readline` here (per the docs' explicit warning that it incorrectly
 *     splits on U+2028/U+2029, which are valid inside JSON strings).
 *     Instead we use the same StringDecoder + manual buffer-split approach
 *     as pi's own documented Node.js client example, which also correctly
 *     handles multi-byte UTF-8 characters split across chunk boundaries.
 */
export async function runPiAgent(pbi: PbiRow, runId: number): Promise<AgentRunResult> {
  const logPath = `${env.logDir}/run-${runId}.jsonl`;
  const containerName = `pi-run-${runId}-${randomUUID().slice(0, 8)}`;
  const agentHomeVolume = `pi-agent-home-${runId}`;

  const prompt =
    `Read AGENTS.md (and any nested AGENTS.md under src/ relevant to this PBI), ` +
    `then ${pbi.file_path}. Implement ${pbi.pbi_number}.`;

  // Pass the API key via an env-file rather than `-e KEY=value` on the
  // command line. `-e` values are visible in `docker run`'s own process
  // listing (e.g. `docker inspect`, `ps`, and anything that logs the exact
  // command, like our own console.log below) -- an env-file's contents
  // are not. The file is written with 0600 perms and deleted once we know
  // the container has started (see the close/error handlers below) or
  // failed to start at all.
  const envFilePath = join(tmpdir(), `pi-run-${runId}-${randomUUID().slice(0, 8)}.env`);
  writeFileSync(envFilePath, `ANTHROPIC_API_KEY=${env.anthropicApiKey}\n`, { mode: 0o600 });

  const args = [
    "run", "--rm",
    "--name", containerName,
    "-i",
    "-a", "stdin", "-a", "stdout", "-a", "stderr",
    "--env-file", envFilePath,
    "-v", `${env.hostTargetRepoPath}:/workspace`,
    "-v", `${agentHomeVolume}:/root/.pi/agent`,
    env.piSandboxImage,
    "pi", "--mode", "rpc", "--no-session",
  ];

  // Safe to log -- no secret values appear in args anymore.
  console.log(`Launching pi-sandbox: docker ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    console.log(`[run ${runId}] spawning docker at t=0ms`);

    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const logStream = createWriteStream(logPath, { flags: "w" });

    let finalSummary = "";
    let sawAgentEnd = false;
    let promptRejected: string | null = null;
    let midStreamError: string | null = null;
    let processClosed = false;

    const cleanupEnvFile = () => {
      try {
        unlinkSync(envFilePath);
      } catch {
        // best-effort; a leftover temp file is a minor cleanup issue, not
        // a correctness issue, and shouldn't fail the run
      }
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30 * 60 * 1000); // 30 min hard cap per PBI run, tune once you've seen real durations

    // JSONL reader matching pi's own documented Node.js client exactly:
    // StringDecoder + manual \n splitting (NOT readline, per the docs'
    // explicit warning about U+2028/U+2029).
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    function handleLine(line: string) {
      if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF input
      if (!line.trim()) return;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return; // non-JSON noise on stdout; still captured in the log file
      }

      switch (event.type) {
        case "response":
          if (event.command === "prompt" && event.success === false) {
            promptRejected = event.error ?? "Prompt rejected with no error message";
          }
          break;

        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta" && typeof delta.delta === "string") {
            // Live/incremental text -- useful for tailing logs, not relied
            // on for the final summary (see agent_end below).
          } else if (delta?.type === "error") {
            midStreamError = `assistant message error (reason: ${delta.reason ?? "unknown"})`;
          }
          break;
        }

        case "agent_end": {
          sawAgentEnd = true;
          const messages = event.messages ?? [];
          const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
          if (lastAssistant) {
            const textBlocks = (lastAssistant.content ?? []).filter(
              (c: any) => c.type === "text"
            );
            finalSummary = textBlocks.map((c: any) => c.text).join("\n");
          }
          // `pi --mode rpc --no-session` does NOT exit on its own after
          // completing a turn -- RPC mode is a persistent session
          // protocol that waits for further prompts. Since we only ever
          // send one prompt per run, agent_end is our signal that we're
          // done and should close stdin ourselves to let `pi` (and the
          // container) exit. If closing stdin doesn't cause exit within a
          // few seconds (e.g. `pi` is blocked on something else), fall
          // back to SIGTERM so we don't rely solely on the 30-minute
          // hard-timeout for an already-completed run.
          console.log(`[run ${runId}] agent_end received at t=${Date.now() - startTime}ms, closing stdin`);
          child.stdin.end();
          setTimeout(() => {
            if (!processClosed) {
              console.warn(`[run ${runId}] container still running 5s after agent_end + stdin.end(), sending SIGTERM`);
              child.kill("SIGTERM");
            }
          }, 5000);
          break;
        }

        case "extension_error":
          console.warn(
            `pi extension_error during run ${runId}: ${event.error} (${event.extensionPath})`
          );
          break;

        default:
          break; // other event types are logged to the .jsonl file but not acted on
      }
    }

    let firstStdoutLogged = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (!firstStdoutLogged) {
        console.log(`[run ${runId}] first stdout chunk received at t=${Date.now() - startTime}ms (${chunk.length} bytes)`);
        firstStdoutLogged = true;
      }
      logStream.write(chunk);
      buffer += decoder.write(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });

    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer.length > 0) handleLine(buffer);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      logStream.end();
      cleanupEnvFile();
      reject(err);
    });

    child.on("close", (code) => {
      processClosed = true;
      console.log(`[run ${runId}] process closed at t=${Date.now() - startTime}ms with code ${code}`);
      clearTimeout(timeoutHandle);
      logStream.end();
      cleanupEnvFile();

      if (promptRejected) {
        console.error(`PBI run ${runId}: prompt rejected -- ${promptRejected}`);
      }
      if (midStreamError) {
        console.error(`PBI run ${runId}: ${midStreamError}`);
      }
      if (!sawAgentEnd && !promptRejected) {
        console.warn(
          `pi-sandbox container for run ${runId} closed (exit code ${code}) ` +
          `without an agent_end event -- check ${logPath} for what actually happened.`
        );
      }

      const failed = code !== 0 || promptRejected !== null || midStreamError !== null;
      resolve({
        status: failed ? "failed" : "completed",
        summary: finalSummary,
        logPath,
      });
    });

    const requestEnvelope = JSON.stringify({ type: "prompt", message: prompt }) + "\n";
    child.stdin.write(requestEnvelope, (err) => {
      if (err) {
        console.error(`[run ${runId}] stdin write error:`, err);
      }
    });
    // Deliberately NOT calling child.stdin.end() here. Closing stdin
    // immediately after write() risks the pipe being torn down before
    // `pi` has started and attached its own stdin reader -- across the
    // docker run -> containerd -> container process boundary, that startup
    // window is longer than for a plain in-process child process. Since
    // this is a single-prompt, run-to-completion invocation (no steering
    // or follow-up commands), we don't need to signal EOF explicitly --
    // the pipe closes naturally when the container exits (--rm).
  });
}