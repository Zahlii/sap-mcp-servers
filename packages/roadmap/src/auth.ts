import { SapWebAuthenticator, type AuthConfig, type ServiceProfile } from '@marianfoo/sap-mcp-auth';
import type { ServerConfig } from './types.js';
import { logger } from './logger.js';

/**
 * Build a SapWebAuthenticator configured for SAP Road Map Explorer.
 * Road Map mints app-specific cookies on roadmaps.sap.com, scopes the session
 * cookie header to that origin, and validates sessions against the Road Map API.
 */
export function createRoadmapAuthenticator(config: ServerConfig): SapWebAuthenticator {
  const authConfig: AuthConfig = {
    authMethod: config.authMethod,
    sapUsername: config.sapUsername,
    sapPassword: config.sapPassword,
    sapAccountPrefix: process.env.SAP_ACCOUNT_PREFIX || undefined,
    pfxPath: config.pfxPath,
    pfxPassphrase: config.pfxPassphrase,
    sapLoginUrl: config.sapLoginUrl ?? 'https://me.sap.com/home',
    mfaTimeout: config.mfaTimeout,
    maxSessionAgeH: config.maxJwtAgeH,
    headful: config.headful,
    tokenCacheFile: config.tokenCacheFile,
    ssoStorageStateFile: config.ssoStorageStateFile,
    logger
  };

  const profile: ServiceProfile = {
    serviceName: 'SAP Road Map',
    appUrl: `${config.roadmapBaseUrl}/board`,
    cookieScope: { type: 'url', url: config.roadmapBaseUrl },
    expectedHost: 'roadmaps.sap.com',
    validateSession: cookieHeader => isSessionAcceptedByRoadmapApi(cookieHeader, config)
  };

  return new SapWebAuthenticator(authConfig, profile);
}

async function isSessionAcceptedByRoadmapApi(cookie: string, config: ServerConfig): Promise<boolean> {
  try {
    const url = new URL('/services/deliverable-search/periods', config.roadmapBaseUrl);
    url.searchParams.set('range', config.defaultRange);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        cookie,
        referer: `${config.roadmapBaseUrl}/board`,
        'user-agent': 'sap-roadmap-mcp/0.1.0'
      }
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || contentType.includes('text/html')) {
      return false;
    }

    const text = await response.text();
    if (text.trimStart().startsWith('<html')) {
      return false;
    }

    JSON.parse(text);
    return true;
  } catch (error) {
    logger.warn('Road Map session validation failed', error);
    return false;
  }
}
