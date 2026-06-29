import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { env } from "./env.js";

export const sqsClient = new SQSClient({
  endpoint: env.sqsEndpointUrl,
  region: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
});

let cachedQueueUrl: string | null = null;

export async function getQueueUrl(): Promise<string> {
  if (cachedQueueUrl) return cachedQueueUrl;

  try {
    const result = await sqsClient.send(
      new CreateQueueCommand({ QueueName: env.queueName })
    );
    cachedQueueUrl = result.QueueUrl!;
  } catch (err: any) {
    if (err.name === "QueueNameExists" || err.name === "QueueAlreadyExists") {
      const result = await sqsClient.send(
        new GetQueueUrlCommand({ QueueName: env.queueName })
      );
      cachedQueueUrl = result.QueueUrl!;
    } else {
      throw err;
    }
  }
  return cachedQueueUrl!;
}

export async function receiveOneMessage(): Promise<Message | null> {
  const queueUrl = await getQueueUrl();
  const result = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
    })
  );
  return result.Messages?.[0] ?? null;
}

export async function deleteMessage(receiptHandle: string): Promise<void> {
  const queueUrl = await getQueueUrl();
  await sqsClient.send(
    new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })
  );
}