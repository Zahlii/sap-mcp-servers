import { join } from 'node:path';
import { homedir } from 'node:os';
import { SapWebAuthenticator, defaultLogger, loadAuthConfigFromEnv } from '@marianfoo/sap-mcp-auth';
import { DISCOVERY_CENTER_URL, PROTECTED_API_URL, SapDiscoveryCenterClient } from './discovery-center-api.js';

/**
 * Build a SapWebAuthenticator for SAP Discovery Center. Its "Sign In" opens
 * /protected/index.html, which runs the accounts.sap.com OIDC flow and sets
 * the session cookies the /platformx API accepts.
 */
export function createDiscoveryCenterAuthenticator(client: SapDiscoveryCenterClient): SapWebAuthenticator {
  const config = loadAuthConfigFromEnv({
    defaultTokenCacheFile: join(homedir(), '.sap-mcp', 'discovery-center-token-cache.json'),
    tokenCacheEnvVars: ['DISCOVERY_CENTER_TOKEN_CACHE_FILE', 'TOKEN_CACHE_FILE'],
    logger: defaultLogger
  });

  return new SapWebAuthenticator(config, {
    serviceName: 'SAP Discovery Center',
    appUrl: `${DISCOVERY_CENTER_URL}/protected/index.html`,
    // The API path, so cookies scoped to /protected are included
    cookieScope: { type: 'url', url: `${PROTECTED_API_URL}/` },
    expectedHost: 'discovery-center.cloud.sap',
    validateSession: cookieHeader => client.validateSession(cookieHeader)
  });
}
