import { simpleGit, SimpleGit } from "simple-git";

const TARGET_REPO_MOUNT = "/target-repo";

export interface SourceControlConfig {
  enabled: boolean;
  repoUrl: string;
  defaultBranch: string;
}

export function getSourceControlConfig(): SourceControlConfig {
  const enabled = (process.env.SOURCE_CONTROL_ENABLED ?? "false").toLowerCase() === "true";
  return {
    enabled,
    repoUrl: process.env.GIT_REPO_URL ?? "",
    defaultBranch: process.env.GIT_DEFAULT_BRANCH ?? "main",
  };
}

/**
 * Injects credentials into a git URL for push operations.
 * Same approach as the orchestrator's authenticatedUrl.
 */
function authenticatedUrl(repoUrl: string): string {
  const token = process.env.GIT_TOKEN;
  if (!token) return repoUrl;

  try {
    const url = new URL(repoUrl);
    url.username = token;
    url.password = "";
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Computes the remote branch name for a PBI run.
 * Convention: pbi/<feature>/<pbi-number>
 * e.g. pbi/rate-limiting/PBI-001
 */
export function remoteBranchName(feature: string, pbiNumber: string): string {
  return `pbi/${feature}/${pbiNumber}`;
}

export interface PushResult {
  pushStatus: "pushed" | "failed";
  remoteBranch: string;
  detail?: string;
}

/**
 * After all gates pass, pushes the agent's commits to a remote branch.
 *
 * The agent works on whatever branch was checked out (the default branch,
 * as left by the orchestrator's ensureRepoReady). This function:
 *   1. Creates a new local branch named pbi/<feature>/<pbi-number>
 *   2. Pushes it to origin (force-push to handle re-runs of the same PBI)
 *
 * This runs inside the WORKER container, which has the target repo
 * mounted at /target-repo (read-write). The git operations happen
 * in-process via simple-git, not through docker.sock.
 */
export async function pushBranch(
  config: SourceControlConfig,
  feature: string,
  pbiNumber: string,
): Promise<PushResult> {
  const branch = remoteBranchName(feature, pbiNumber);

  if (!config.enabled) {
    return { pushStatus: "pushed", remoteBranch: branch, detail: "source control disabled, no-op" };
  }

  if (!config.repoUrl) {
    return { pushStatus: "failed", remoteBranch: branch, detail: "GIT_REPO_URL not set" };
  }

  const authUrl = authenticatedUrl(config.repoUrl);
  const git: SimpleGit = simpleGit(TARGET_REPO_MOUNT);

  try {
    // Ensure remote URL is current (token may have rotated since clone)
    try {
      await git.remote(["set-url", "origin", authUrl]);
    } catch {
      await git.addRemote("origin", authUrl);
    }

    // Create the branch from current HEAD (which includes the agent's commits)
    // Use -B to force-create even if the branch already exists from a prior run
    await git.checkout(["-B", branch]);

    // Force-push: a re-run of the same PBI should overwrite the previous
    // branch, not fail with "already exists"
    console.log(`Pushing branch ${branch} to origin`);
    await git.push("origin", branch, ["--force"]);

    // Return to the default branch so subsequent PBI runs start from the
    // correct baseline
    await git.checkout(config.defaultBranch);

    console.log(`Successfully pushed ${branch}`);
    return { pushStatus: "pushed", remoteBranch: branch };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to push branch ${branch}:`, message);
    return { pushStatus: "failed", remoteBranch: branch, detail: message };
  }
}
