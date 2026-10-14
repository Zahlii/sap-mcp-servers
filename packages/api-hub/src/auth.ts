import { SapWebAuthenticator, type AuthConfig, type ServiceProfile } from '@marianfoo/sap-mcp-auth';
import type { ServerConfig } from './types.js';
import { logger } from './logger.js';
import { SapApiHubClient } from './api-hub-client.js';

/**
 * Build a SapWebAuthenticator configured for the SAP Business Accelerator Hub.
 * API Hub mints app cookies on api.sap.com and scopes the session header to that
 * domain (falling back to all cookies when none match).
 */
export function createApiHubAuthenticator(config: ServerConfig): SapWebAuthenticator {
  const authConfig: AuthConfig = {
    authMethod: config.authMethod,
    sapUsername: config.sapUsername,
    sapPassword: config.sapPassword,
    sapAccountPrefix: config.sapAccountPrefix,
    pfxPath: config.pfxPath,
    pfxPassphrase: config.pfxPassphrase,
    // API Hub's OAuth flow can reject stale shared SSO/browser state with
    // state_not_verified. Go directly to API Hub in a clean context and cache
    // only the resulting api.sap.com cookies.
    sapLoginUrl: undefined,
    mfaTimeout: config.mfaTimeout,
    maxSessionAgeH: config.maxCookieAgeH,
    headful: config.headful,
    tokenCacheFile: config.tokenCacheFile,
    ssoStorageStateFile: undefined,
    logger
  };

  const profile: ServiceProfile = {
    serviceName: 'SAP API Hub',
    // A protected page: the public overview pages never trigger the login.
    appUrl: `${config.apiHubBaseUrl}/myworkspace`,
    cookieScope: { type: 'domain', includes: 'api.sap.com', fallbackToAll: true },
    expectedHost: 'api.sap.com',
    validateSession: cookieHeader => new SapApiHubClient(config).validateSession(cookieHeader)
  };

  return new SapWebAuthenticator(authConfig, profile);
}
