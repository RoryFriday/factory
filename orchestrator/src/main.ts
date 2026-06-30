import express from "express";
import { pool, PbiRow } from "./db.js";
import { enqueuePbiJob } from "./queue.js";
import { scanAndRegisterPbis } from "./scanner.js";
import { getSourceControlConfig, ensureRepoReady } from "./sourceControl.js";

const scConfig = getSourceControlConfig();

const app = express();
app.use(express.json());

app.post("/sync", async (_req, res) => {
  await scanAndRegisterPbis();
  const { rows } = await pool.query<PbiRow>(
    "SELECT id, feature, pbi_number, status FROM pbi ORDER BY feature, pbi_number"
  );
  res.json({ pbis: rows });
});

app.get("/pbis", async (_req, res) => {
  const { rows } = await pool.query<PbiRow>(
    "SELECT * FROM pbi ORDER BY feature, pbi_number"
  );
  res.json(rows);
});

app.get("/pbis/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query<PbiRow>("SELECT * FROM pbi WHERE id = $1", [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "PBI not found" });
    return;
  }
  const { rows: runs } = await pool.query(
    "SELECT * FROM run WHERE pbi_id = $1 ORDER BY started_at DESC",
    [id]
  );
  res.json({ ...rows[0], runs });
});

app.post("/pbis/:id/enqueue", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query<PbiRow>("SELECT * FROM pbi WHERE id = $1", [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "PBI not found" });
    return;
  }
  const pbi = rows[0];

  if (pbi.depends_on) {
    const { rows: depRows } = await pool.query<PbiRow>(
      "SELECT status FROM pbi WHERE feature = $1 AND pbi_number = $2",
      [pbi.feature, pbi.depends_on]
    );
    const depStatus = depRows[0]?.status;
    if (depStatus !== "passed") {
      await pool.query(
        "UPDATE pbi SET status = 'blocked', updated_at = now() WHERE id = $1",
        [id]
      );
      res.json({ pbiId: id, pbiNumber: pbi.pbi_number, status: "blocked" });
      return;
    }
  }

  // When source control is enabled, ensure the target repo is up-to-date
  // with the remote's default branch before enqueuing.
  try {
    await ensureRepoReady(scConfig);
  } catch (err) {
    console.error(`Source control sync failed for PBI ${pbi.pbi_number}:`, err);
    res.status(500).json({
      pbiId: id,
      pbiNumber: pbi.pbi_number,
      status: "error",
      error: `Source control sync failed: ${(err as Error).message}`,
    });
    return;
  }

  await enqueuePbiJob(id);
  await pool.query("UPDATE pbi SET status = 'queued', updated_at = now() WHERE id = $1", [id]);
  res.json({ pbiId: id, pbiNumber: pbi.pbi_number, status: "queued" });
});

app.get("/runs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM run WHERE id = $1", [id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const { rows: gateResults } = await pool.query(
    "SELECT * FROM gate_result WHERE run_id = $1 ORDER BY created_at",
    [id]
  );
  res.json({ ...rows[0], gateResults });
});

const PORT = process.env.PORT ?? 8000;
app.listen(PORT, () => {
  console.log(`Orchestrator listening on port ${PORT}`);
});