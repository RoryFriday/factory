import { mkdirSync } from "fs";
import { env, PbiRow } from "./env.js";
import { pool } from "./db.js";
import { receiveOneMessage, deleteMessage, getQueueUrl } from "./queue.js";
import { runPiAgent } from "./agentRunner.js";
import { runGate } from "./gateRunner.js";
import { getSourceControlConfig, pushBranch, remoteBranchName } from "./sourceControl.js";

const scConfig = getSourceControlConfig();

async function processJob(pbiId: number): Promise<void> {
  const { rows } = await pool.query<PbiRow>("SELECT * FROM pbi WHERE id = $1", [pbiId]);
  const pbi = rows[0];
  if (!pbi) {
    console.error(`PBI id ${pbiId} not found in DB, dropping job`);
    return;
  }

  await pool.query("UPDATE pbi SET status = 'running', updated_at = now() WHERE id = $1", [pbiId]);
  const runResult = await pool.query<{ id: number }>(
    "INSERT INTO run (pbi_id, status) VALUES ($1, 'running') RETURNING id",
    [pbiId]
  );
  const runId = runResult.rows[0].id;

  const agentResult = await runPiAgent(pbi, runId);

  await pool.query(
    `UPDATE run SET status = $1, finished_at = now(), agent_summary = $2, raw_log_path = $3
     WHERE id = $4`,
    [agentResult.status, agentResult.summary, agentResult.logPath, runId]
  );

  if (agentResult.status !== "completed") {
    await pool.query("UPDATE pbi SET status = 'failed', updated_at = now() WHERE id = $1", [pbiId]);
    console.warn(`PBI ${pbi.pbi_number} agent run failed, skipping gates`);
    return;
  }

  await pool.query("UPDATE pbi SET status = 'gates_running', updated_at = now() WHERE id = $1", [pbiId]);

  const gates: Array<{ type: string; args: string[] }> = [
    { type: "compose_app_build", args: ["--profile", "app", "build"] },
    { type: "compose_test", args: ["--profile", "test", "up", "--abort-on-container-exit"] },
  ];

  let allPassed = true;
  for (const gate of gates) {
    const result = await runGate(gate.type, gate.args);
    await pool.query(
      "INSERT INTO gate_result (run_id, gate_type, status, detail) VALUES ($1, $2, $3, $4)",
      [runId, result.gateType, result.status, result.detail]
    );
    if (result.status !== "passed") {
      allPassed = false;
      console.warn(`Gate ${gate.type} failed for PBI ${pbi.pbi_number}`);
    }
  }

  // If all gates passed and source control is enabled, push the agent's
  // commits to a remote branch.
  let pushStatus = "none";
  let remoteBranch: string | null = null;

  if (allPassed && scConfig.enabled) {
    remoteBranch = remoteBranchName(pbi.feature, pbi.pbi_number);
    const pushResult = await pushBranch(scConfig, pbi.feature, pbi.pbi_number);
    pushStatus = pushResult.pushStatus;
    remoteBranch = pushResult.remoteBranch;

    await pool.query(
      "UPDATE run SET push_status = $1, remote_branch = $2 WHERE id = $3",
      [pushStatus, remoteBranch, runId]
    );

    if (pushStatus === "failed") {
      console.warn(`Push failed for PBI ${pbi.pbi_number}: ${pushResult.detail}`);
      // Gates passed but push failed -- mark the PBI as failed so the
      // operator knows there's a problem, even though the code itself is fine.
      allPassed = false;
    }
  }

  const finalStatus = allPassed ? "passed" : "failed";
  await pool.query("UPDATE pbi SET status = $1, updated_at = now() WHERE id = $2", [finalStatus, pbiId]);
  console.log(`PBI ${pbi.pbi_number} finished with status ${finalStatus}`);
}

async function main() {
  mkdirSync(env.logDir, { recursive: true });
  const queueUrl = await getQueueUrl();
  console.log(`Worker started, polling queue ${queueUrl}`);

  while (true) {
    const message = await receiveOneMessage();
    if (!message) {
      await new Promise((r) => setTimeout(r, env.pollIntervalMs));
      continue;
    }

    const job = JSON.parse(message.Body ?? "{}") as { pbiId: number };
    console.log(`Processing job:`, job);

    try {
      await processJob(job.pbiId);
    } catch (err) {
      console.error(`Unhandled error processing job`, job, err);
    } finally {
      if (message.ReceiptHandle) {
        await deleteMessage(message.ReceiptHandle);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});