import { isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import type { AuthConfig, AuthMethod, BrowserType, Logger } from './types.js';

export interface LoadAuthConfigOptions {
  /** Absolute default path for the cookie cache when no env var is set. */
  defaultTokenCacheFile: string;
  /** Env var names checked (in order) for an explicit cookie cache path. */
  tokenCacheEnvVars?: string[];
  sharedSsoTokenFastPath?: boolean;
  logger?: Logger;
  /** Override any resolved field (e.g. inject sapLoginUrl). */
  overrides?: Partial<AuthConfig>;
}

/**
 * Build an AuthConfig from the SAP MCP env vars. Reads both MAX_JWT_AGE_H and
 * MAX_COOKIE_AGE_H for backwards compatibility across the three servers.
 */
export function loadAuthConfigFromEnv(options: LoadAuthConfigOptions): AuthConfig {
  const env = process.env;
  const tokenCacheFile =
    firstEnv(options.tokenCacheEnvVars ?? ['TOKEN_CACHE_FILE']) ?? options.defaultTokenCacheFile;

  const config: AuthConfig = {
    authMethod: normalizeAuthMethod(env.AUTH_METHOD, options.logger),
    sapUsername: env.SAP_USERNAME || undefined,
    sapPassword: env.SAP_PASSWORD || undefined,
    sapAccountPrefix: env.SAP_ACCOUNT_PREFIX || undefined,
    pfxPath: resolveOptionalPath(env.PFX_PATH),
    pfxPassphrase: env.PFX_PASSPHRASE || undefined,
    sapLoginUrl: env.SAP_LOGIN_URL || 'https://me.sap.com/home',
    mfaTimeout: Number.parseInt(env.MFA_TIMEOUT || '180000', 10),
    maxSessionAgeH: Number.parseInt(env.MAX_JWT_AGE_H || env.MAX_COOKIE_AGE_H || '12', 10),
    headful: env.HEADFUL === 'true',
    tokenCacheFile: resolveOptionalPath(tokenCacheFile) ?? tokenCacheFile,
    ssoStorageStateFile: resolveOptionalPath(
      env.SAP_SSO_STORAGE_STATE || join(env.HOME || homedir(), '.sap-mcp', 'sso-storage-state.json')
    ),
    browserType: normalizeBrowserType(env.PLAYWRIGHT_BROWSER_TYPE),
    sharedSsoTokenFastPath: options.sharedSsoTokenFastPath,
    logger: options.logger
  };

  return { ...config, ...options.overrides };
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

function normalizeAuthMethod(value: string | undefined, logger?: Logger): AuthMethod {
  if (value === 'password' || value === 'certificate' || value === 'interactive' || value === 'auto') {
    return value;
  }
  if (value) {
    logger?.warn(`Unsupported AUTH_METHOD="${value}", falling back to auto`);
  }
  return 'auto';
}

function normalizeBrowserType(value: string | undefined): BrowserType | undefined {
  if (value === 'chromium' || value === 'firefox' || value === 'webkit') return value;
  return undefined;
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let resolvedPath = value;
  if (resolvedPath.startsWith('~')) {
    const home = process.env.HOME || homedir();
    resolvedPath = join(home, resolvedPath.slice(1));
  }
  if (!isAbsolute(resolvedPath)) {
    resolvedPath = join(process.cwd(), resolvedPath);
  }
  return resolve(resolvedPath);
}
