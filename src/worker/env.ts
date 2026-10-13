import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  ARTIFACTS?: Artifacts;
  EXECUTION_URL?: string;
  EXECUTION_SECRET?: string;
  ARTIFACT_ACCOUNT_ID?: string;
  ARTIFACT_NAMESPACE?: string;
  OAUTH_KV: KVNamespace;
  ASSETS?: Fetcher;
  OAUTH_PROVIDER?: OAuthHelpers;
  EMAIL?: SendEmail;
  EMAIL_ENABLED?: string;
  AUTH_EMAIL_ENABLED?: string;
  EMAIL_FROM?: string;
  EMAIL_GATEWAY_URL?: string;
  EMAIL_GATEWAY_SECRET?: string;
  FILES: R2Bucket;
  FILE_LINK_SECRET?: string;
  MCP_EVENT_KEY?: string;
  MCP_EVENT_PREVIOUS_KEY?: string;
  MCP_WEBHOOK_GATEWAY_URL?: string;
  MCP_WEBHOOK_GATEWAY_TOKEN?: string;
  MCP_WEBHOOK_GATEWAY?: Fetcher;
  WORKSPACES: DurableObjectNamespace;
  APP_ORIGIN: string;
  WORKSPACE_CREATION: string;
  BOOTSTRAP_EMAILS?: string;
  BOOTSTRAP_DOMAINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GIPHY_API_KEY?: string;
  DEV_AUTH?: string;
}
