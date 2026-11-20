export type ApiHubKind = 'api' | 'event' | 'cdsview' | 'artifact' | 'package';
export type SpecFormat = 'json' | 'yaml' | 'edmx' | 'raw';
export type AuthMethod = 'auto' | 'password' | 'certificate';

export interface ServerConfig {
  pfxPath?: string;
  pfxPassphrase?: string;
  sapUsername?: string;
  sapPassword?: string;
  sapAccountPrefix?: string;
  authMethod: AuthMethod;
  mfaTimeout: number;
  maxCookieAgeH: number;
  headful: boolean;
  logLevel: string;
  apiHubBaseUrl: string;
  tokenCacheFile: string;
  /** Directory the `spec` tool writes specification bodies to. */
  specDir: string;
  ssoStorageStateFile?: string;
  sapLoginUrl?: string;
}

export interface ApiHubCategory {
  categoryKey: string;
  title: string;
  description?: string;
  packageCount?: number;
  artifactCount?: number;
  subtypeCounts?: Record<string, number>;
}

export interface SearchInput {
  q: string;
  categoryKey?: string;
  artifactType?: string;
  top: number;
  skip: number;
}

export interface ApiHubSearchResult {
  id: string;
  title: string;
  categoryKey?: string;
  artifactType?: string;
  subType?: string;
  package?: {
    id?: string;
    title?: string;
  };
  state?: string;
  status?: string;
  version?: string;
  description?: string;
  url?: string;
}

export interface ApiHubSearchResponse {
  total?: number;
  top: number;
  skip: number;
  results: ApiHubSearchResult[];
}

export interface FetchInput {
  id: string;
  kind: ApiHubKind;
  artifactType?: string;
  version?: string;
}

export interface ResourcesInput {
  id: string;
  kind: Exclude<ApiHubKind, 'package'> | 'artifact';
  artifactType?: string;
  version?: string;
}

export interface SpecInput {
  id: string;
  kind: Exclude<ApiHubKind, 'package'> | 'artifact';
  format: SpecFormat;
  artifactType?: string;
  version?: string;
}

export interface PackageInput {
  id: string;
  includeArtifacts: boolean;
  top: number;
}

export interface RawResponse {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

export interface GenericValue {
  contentType: string;
  text: string;
  json?: unknown;
}
