import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { pool } from "./db.js";

const TARGET_REPO_PATH = "/target-repo"; // read-only mount, see docker-compose.yml
const PBI_FILENAME_RE = /^PBI-\d+\.md$/;

/**
 * Looks for a line like "Depends on PBI-000" in the PBI's own markdown.
 * Intentionally simple string matching, not a structured field -- PBIs
 * are human-authored markdown, not YAML frontmatter, per the format
 * established for this project. If this proves too fragile in practice,
 * consider requiring a one-line `Depends-On: PBI-000` header instead.
 */
function parseDependsOn(pbiText: string): string | null {
  const match = pbiText.match(/[Dd]epends on (PBI-\d+)/);
  return match ? match[1] : null;
}

function findPbiFiles(tasksDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && PBI_FILENAME_RE.test(entry)) {
        results.push(fullPath);
      }
    }
  }

  walk(tasksDir);
  return results.sort();
}

export async function scanAndRegisterPbis(): Promise<void> {
  const tasksDir = join(TARGET_REPO_PATH, "tasks");
  const pbiFiles = findPbiFiles(tasksDir);

  for (const pbiFile of pbiFiles) {
    const feature = pbiFile.split("/").slice(-2, -1)[0]; // parent folder name
    const pbiNumber = pbiFile.split("/").pop()!.replace(/\.md$/, "");
    const filePath = relative(TARGET_REPO_PATH, pbiFile);
    const dependsOn = parseDependsOn(readFileSync(pbiFile, "utf-8"));

    await pool.query(
      `INSERT INTO pbi (feature, pbi_number, file_path, depends_on, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (feature, pbi_number) DO NOTHING`,
      [feature, pbiNumber, filePath, dependsOn]
    );
  }
}