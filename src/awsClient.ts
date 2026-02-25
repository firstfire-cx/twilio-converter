// src/awsClient.ts
// src/awsClient.ts
import { ConnectClient } from "@aws-sdk/client-connect";

interface AwsCredentials {
  access_key: string;
  secret_key: string;
  region: string;
}

export function buildClient(credentials: AwsCredentials) {
  return new ConnectClient({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.access_key,
      secretAccessKey: credentials.secret_key,
    },
  });
}