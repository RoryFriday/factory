import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

const QUEUE_NAME = process.env.QUEUE_NAME ?? "pbi-jobs";

export const sqsClient = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT_URL,
  region: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
});

let cachedQueueUrl: string | null = null;

export async function getQueueUrl(): Promise<string> {
  if (cachedQueueUrl) return cachedQueueUrl;

  try {
    const result = await sqsClient.send(
      new CreateQueueCommand({ QueueName: QUEUE_NAME })
    );
    cachedQueueUrl = result.QueueUrl!;
  } catch (err: any) {
    // ElasticMQ/SQS both throw if the queue already exists with different
    // attributes; fall back to a plain lookup in that case.
    if (err.name === "QueueNameExists" || err.name === "QueueAlreadyExists") {
      const result = await sqsClient.send(
        new GetQueueUrlCommand({ QueueName: QUEUE_NAME })
      );
      cachedQueueUrl = result.QueueUrl!;
    } else {
      throw err;
    }
  }
  return cachedQueueUrl!;
}

export async function enqueuePbiJob(pbiId: number): Promise<void> {
  const queueUrl = await getQueueUrl();
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ pbiId }),
    })
  );
}