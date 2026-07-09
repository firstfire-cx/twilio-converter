// src/utils/hooLookup.ts
//
// Fetches Hours of Operation details from AWS Connect.

import { DescribeHoursOfOperationCommand } from "@aws-sdk/client-connect";
import type { ConnectClient } from "@aws-sdk/client-connect";

/** Extract the HOO UUID from an ARN or bare UUID. */
export function extractHooId(arnOrId: string): string {
  if (!arnOrId) return "";
  return arnOrId.split("/").pop() || arnOrId;
}

/**
 * Fetch a Connect Hours of Operation by ARN or UUID and return its name.
 * Returns `null` if the HOO is not found or the API call fails.
 */
export async function fetchHooName(
  client: ConnectClient,
  hooArnOrId: string,
  instanceId?: string,
): Promise<string | null> {
  if (!hooArnOrId) return null;

  const hooId = extractHooId(hooArnOrId);
  if (!hooId) return null;

  const response = await client.send(
    new DescribeHoursOfOperationCommand({
      HoursOfOperationId: hooId,
      ...(instanceId ? { InstanceId: instanceId } : {}),
    }),
  );

  return response.HoursOfOperation?.Name ?? null;
}
