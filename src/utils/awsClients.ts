// src/utils/awsClients.ts
//
// Single source of truth for building AWS SDK clients from the app's
// credentials. Replaces the ~6 near-identical builders that had drifted across
// components (Connect + DynamoDB document clients).

import { ConnectClient, type ConnectClientConfig, DescribeHoursOfOperationCommand } from "@aws-sdk/client-connect";
import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AwsCredentials } from "../hooks/useAwsCredentials";

function baseConfig(creds: AwsCredentials) {
  return {
    region: creds.region || "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  };
}

/** Build a Connect client from the app credentials. */
export function connectClient(creds: AwsCredentials): ConnectClient {
  const cfg: ConnectClientConfig = baseConfig(creds);
  return new ConnectClient(cfg);
}

/** Build a DynamoDB document client (with marshalling) from the app credentials. */
export function ddbDocClient(creds: AwsCredentials): DynamoDBDocumentClient {
  const cfg: DynamoDBClientConfig = {
    ...baseConfig(creds),
    ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
  };
  return DynamoDBDocumentClient.from(new DynamoDBClient(cfg), {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
}

/**
 * Fetch the name of a Connect Hours of Operation by ARN or UUID.
 * Returns `null` if the HOO is not found or the API call fails.
 */
export async function fetchHooName(
  creds: AwsCredentials,
  hooArnOrId: string,
  instanceId?: string,
): Promise<string | null> {
  if (!hooArnOrId) return null;

  const client = connectClient(creds);

  // Extract the HOO ID from ARN or use as-is
  const hooId = hooArnOrId.includes("/") ? hooArnOrId.split("/").pop() || hooArnOrId : hooArnOrId;

  const response = await client.send(
    new DescribeHoursOfOperationCommand({
      HoursOfOperationId: hooId,
      ...(instanceId ? { InstanceId: instanceId } : {}),
    }),
  );

  return response.HoursOfOperation?.Name ?? null;
}
