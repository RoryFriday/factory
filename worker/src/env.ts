function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  databaseUrl: requireEnv("DATABASE_URL"),
  sqsEndpointUrl: requireEnv("SQS_ENDPOINT_URL"),
  queueName: process.env.QUEUE_NAME ?? "pbi-jobs",
  piSandboxImage: process.env.PI_SANDBOX_IMAGE ?? "pi-sandbox",
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  // The HOST path to the target repo -- NOT this worker container's own
  // mount point. Must be set explicitly because `docker run -v` commands
  // issued via the mounted docker.sock are interpreted by the HOST docker
  // daemon, which has no idea what /target-repo means inside this
  // container's own filesystem namespace.
  hostTargetRepoPath: requireEnv("HOST_TARGET_REPO_PATH"),
  logDir: process.env.LOG_DIR ?? "/var/factory/logs",
  pollIntervalMs: 5000,
};

export interface PbiRow {
  id: number;
  feature: string;
  pbi_number: string;
  file_path: string;
  depends_on: string | null;
  status: string;
}

export interface AgentRunResult {
  status: "completed" | "failed";
  summary: string;
  logPath: string;
}

export interface GateResult {
  gateType: string;
  status: "passed" | "failed";
  detail: string;
}