import { simpleGit, SimpleGit } from "simple-git";

const TARGET_REPO_PATH = "/target-repo";

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
 * Injects credentials into a git URL for clone/fetch operations.
 * Supports HTTPS URLs with a token (e.g. GitHub PAT):
 *   https://github.com/org/repo.git → https://<token>@github.com/org/repo.git
 *
 * If GIT_TOKEN is not set, returns the URL unchanged (for SSH-based auth
 * or repos that don't require credentials).
 */
function authenticatedUrl(repoUrl: string): string {
  const token = process.env.GIT_TOKEN;
  if (!token) return repoUrl;

  try {
    const url = new URL(repoUrl);
    url.username = token;
    url.password = ""; // PAT-based auth uses the username slot only
    return url.toString();
  } catch {
    // Not a parseable URL (e.g. SSH format) -- return as-is
    return repoUrl;
  }
}

/**
 * Ensures the target repo at TARGET_REPO_PATH is up-to-date with the
 * remote's default branch. If the directory is not yet a git repo, clones
 * it. If it already is, fetches and resets to the latest remote HEAD.
 *
 * Called by the orchestrator's /enqueue endpoint BEFORE the PBI is placed
 * on the queue, so the worker always operates on a fresh checkout.
 */
export async function ensureRepoReady(config: SourceControlConfig): Promise<void> {
  if (!config.enabled) return;

  if (!config.repoUrl) {
    throw new Error(
      "SOURCE_CONTROL_ENABLED is true but GIT_REPO_URL is not set"
    );
  }

  const authUrl = authenticatedUrl(config.repoUrl);
  const git: SimpleGit = simpleGit(TARGET_REPO_PATH);

  const isRepo = await git.checkIsRepo().catch(() => false);

  if (!isRepo) {
    // Clone into the existing (empty or non-git) directory.
    // simple-git's clone needs to target a different path then move, OR
    // we can init + add remote + fetch + checkout. The latter is cleaner
    // when the mount point already exists (Docker creates it).
    console.log(`Cloning ${config.repoUrl} into ${TARGET_REPO_PATH}`);
    await git.init();
    await git.addRemote("origin", authUrl);
    await git.fetch("origin", config.defaultBranch);
    await git.checkout(["-B", config.defaultBranch, `origin/${config.defaultBranch}`]);
  } else {
    // Already a repo -- update remote URL (in case token rotated), fetch,
    // and hard-reset to ensure a clean state.
    console.log(`Pulling latest ${config.defaultBranch} in ${TARGET_REPO_PATH}`);
    try {
      await git.remote(["set-url", "origin", authUrl]);
    } catch {
      await git.addRemote("origin", authUrl);
    }
    await git.fetch("origin", config.defaultBranch);
    await git.reset(["--hard", `origin/${config.defaultBranch}`]);
    await git.clean("f", ["-d"]); // remove untracked files/dirs
  }

  console.log(`Target repo ready on ${config.defaultBranch}`);
}

/**
 * Computes the remote branch name for a PBI run.
 * Convention: pbi/<feature>/<pbi-number>
 * e.g. pbi/rate-limiting/PBI-001
 */
export function remoteBranchName(feature: string, pbiNumber: string): string {
  return `pbi/${feature}/${pbiNumber}`;
}
