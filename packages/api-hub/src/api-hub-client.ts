import type {
  ApiHubCategory,
  ApiHubSearchResponse,
  FetchInput,
  GenericValue,
  JsonObject,
  PackageInput,
  RawResponse,
  ResourcesInput,
  SearchInput,
  ServerConfig,
  SpecFormat,
  SpecInput
} from './types.js';
import { logger } from './logger.js';
import { PACKAGE_VERSION } from './version.js';

type AnyRecord = Record<string, unknown>;

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const CATEGORY_ROUTE_PREFIX: Record<string, string> = {
  API: 'api',
  Events: 'event',
  CDSViews: 'cdsviews'
};

export class SapApiHubClient {
  constructor(private config: ServerConfig) {}

  async validateSession(cookie: string): Promise<boolean> {
    try {
      // ContentTypes and the search service answer without a session, so they cannot prove a login.
      // Catalog metadata is protected and returns the login page instead of JSON when the session is missing.
      await this.getJson("/odata/1.0/catalog.svc/APIContent.APIs('API_PRODUCT_SRV')?$select=Name&$format=json", cookie);
      return true;
    } catch (error) {
      logger.warn('API Hub session validation failed', error);
      return false;
    }
  }

  async categories(cookie: string): Promise<{ categories: ApiHubCategory[]; raw: unknown }> {
    const raw = await this.getJson('/api/1.0/containergroup/ContentTypes?$expand=containers($expand=logo)', cookie);
    const containers = collectContainers(raw);
    const categories = containers.map(normalizeCategory).filter((category): category is ApiHubCategory => Boolean(category));

    return { categories, raw };
  }

  async search(input: SearchInput, cookie: string): Promise<ApiHubSearchResponse> {
    const query = new URLSearchParams();
    query.set('searchterm', input.q);
    query.set('$top', String(input.top));
    query.set('$skip', String(input.skip));

    if (input.categoryKey) {
      query.set('$filter', `(Containers:[{"Name":"${escapeJsonString(input.categoryKey)}","Type":"contentType"}])`);
    }

    if (input.artifactType) {
      query.set('$type', JSON.stringify([input.artifactType]));
    }

    const raw = await this.getJson(`/api/1.0/searchservice?${query.toString()}`, cookie);
    const results = normalizeSearchResults(raw, this.config.apiHubBaseUrl, input);
    const total = extractSearchTotal(raw);

    return {
      total,
      top: input.top,
      skip: input.skip,
      results,
      raw
    };
  }

  async fetch(input: FetchInput, cookie: string): Promise<unknown> {
    switch (input.kind) {
      case 'api':
        return this.fetchApi(input.id, cookie);
      case 'event':
        return this.fetchEvent(input.id, cookie, input.version);
      case 'cdsview':
        return this.fetchCdsView(input.id, cookie);
      case 'artifact':
        return this.fetchGenericArtifact(input.id, requireArtifactType(input.artifactType), cookie);
      case 'package':
        return this.fetchPackage({ id: input.id, includeArtifacts: true, top: 50 }, cookie);
      default:
        assertNever(input.kind);
    }
  }

  async resources(input: ResourcesInput, cookie: string): Promise<unknown> {
    switch (input.kind) {
      case 'api': {
        const spec = await this.getApiSpecJson(input.id, cookie);
        return {
          id: input.id,
          kind: input.kind,
          url: canonicalUrl(this.config.apiHubBaseUrl, 'api', input.id),
          ...extractOpenApiResources(spec)
        };
      }
      case 'event': {
        const version = await this.resolveEventVersion(input.id, cookie, input.version);
        const spec = await this.getEventSpecJson(input.id, cookie, version);
        return {
          id: input.id,
          kind: input.kind,
          version,
          url: canonicalUrl(this.config.apiHubBaseUrl, 'event', input.id),
          ...extractAsyncApiResources(spec)
        };
      }
      case 'cdsview': {
        const detail = await this.fetchCdsView(input.id, cookie);
        return {
          id: input.id,
          kind: input.kind,
          url: canonicalUrl(this.config.apiHubBaseUrl, 'cdsview', input.id),
          fields: (detail as AnyRecord).fields,
          capabilities: (detail as AnyRecord).capabilities,
          businessContexts: (detail as AnyRecord).businessContexts,
          category: (detail as AnyRecord).category,
          sapObjectNodeType: (detail as AnyRecord).sapObjectNodeType,
          releaseState: (detail as AnyRecord).releaseState,
          extensibility: (detail as AnyRecord).extensibility
        };
      }
      case 'artifact': {
        const value = await this.fetchGenericArtifactValue(input.id, requireArtifactType(input.artifactType), cookie);
        return {
          id: input.id,
          kind: input.kind,
          artifactType: input.artifactType,
          ...summarizeGenericValue(value, true)
        };
      }
      default:
        assertNever(input.kind);
    }
  }

  async spec(input: SpecInput, cookie: string): Promise<RawResponse> {
    validateSpecFormat(input.kind, input.format);

    switch (input.kind) {
      case 'api':
        return this.getApiSpecRaw(input.id, input.format, cookie);
      case 'event': {
        const version = await this.resolveEventVersion(input.id, cookie, input.version);
        return this.getEventSpecRaw(input.id, input.format, cookie, version);
      }
      case 'cdsview': {
        const value = await this.fetchCdsValue(input.id, cookie);
        if (value.json !== undefined) {
          return {
            url: `${this.config.apiHubBaseUrl}/odata/1.0/catalog.svc/CdsViewsContent.CdsViews('${odataKey(input.id)}')/$value`,
            status: 200,
            contentType: 'application/json',
            text: JSON.stringify(value.json, null, 2)
          };
        }
        return {
          url: `${this.config.apiHubBaseUrl}/odata/1.0/catalog.svc/CdsViewsContent.CdsViews('${odataKey(input.id)}')/$value`,
          status: 200,
          contentType: value.contentType,
          text: value.text
        };
      }
      case 'artifact': {
        const artifactType = requireArtifactType(input.artifactType);
        const value = await this.fetchGenericArtifactValue(input.id, artifactType, cookie);
        return {
          url: `${this.config.apiHubBaseUrl}/odata/1.0/catalog.svc/Artifacts(Name='${odataKey(input.id)}',Type='${odataKey(artifactType)}')/$value`,
          status: 200,
          contentType: value.contentType,
          text: value.text
        };
      }
      default:
        assertNever(input.kind);
    }
  }

  async fetchPackage(input: PackageInput, cookie: string): Promise<unknown> {
    const key = odataKey(input.id);
    const metadata = await this.getJson(
      `/odata/1.0/catalog.svc/ContentPackages('${key}')?$format=json&$expand=Files,Urls`,
      cookie
    ).catch(error => {
      logger.warn(`Package expanded metadata failed for ${input.id}; retrying without expand`, error);
      return this.getJson(`/odata/1.0/catalog.svc/ContentPackages('${key}')?$format=json`, cookie);
    });
    const packageMetadata = unwrapOData(metadata) as AnyRecord;

    let artifacts: AnyRecord[] = [];
    if (input.includeArtifacts) {
      const rawArtifacts = await this.getJson(
        `/odata/1.0/catalog.svc/ContentPackages('${key}')/Artifacts?$format=json&$top=${input.top}`,
        cookie
      );
      artifacts = unwrapODataCollection(rawArtifacts).filter(isRecord);
    }

    return {
      id: input.id,
      kind: 'package',
      title: pickString(packageMetadata, 'DisplayName', 'Title', 'Name') || input.id,
      description: cleanText(pickString(packageMetadata, 'Description', 'ShortDescription', 'Summary')),
      vendor: pickString(packageMetadata, 'Vendor', 'Publisher'),
      version: pickString(packageMetadata, 'Version'),
      state: pickString(packageMetadata, 'State', 'Status'),
      modifiedAt: parseMaybeDate(pickString(packageMetadata, 'ModifiedAt', 'ChangedAt')),
      docs: extractUrls(packageMetadata),
      artifacts: groupPackageArtifacts(artifacts, this.config.apiHubBaseUrl),
      artifactCount: artifacts.length,
      metadata: packageMetadata
    };
  }

  private async fetchApi(id: string, cookie: string): Promise<unknown> {
    const metadata = await this.getJson(
      `/odata/1.0/catalog.svc/APIContent.APIs('${odataKey(id)}')?$select=*&$format=json`,
      cookie
    );
    const entity = unwrapOData(metadata) as AnyRecord;
    const spec = await this.getApiSpecJson(id, cookie).catch(error => {
      logger.warn(`Could not fetch OpenAPI JSON for API ${id}`, error);
      return undefined;
    });

    return {
      id,
      kind: 'api',
      title: pickString(entity, 'DisplayName', 'Title', 'Name') || titleFromSpec(spec) || id,
      description: cleanText(pickString(entity, 'Description', 'ShortDescription', 'Summary')),
      introduction: cleanText(pickString(entity, 'Introduction', 'LongDescription', 'Description')),
      status: pickString(entity, 'APIState', 'State', 'Status'),
      type: pickString(entity, 'Type', 'SubType', 'Protocol') || inferApiType(spec),
      version: pickString(entity, 'Version'),
      direction: pickString(entity, 'Direction'),
      package: {
        id: pickString(entity, 'PackageId', 'PackageName', 'ParentTechnicalName'),
        title: pickString(entity, 'PackageDisplayName', 'ParentDisplayName')
      },
      serviceUrl: pickString(entity, 'ServiceUrl', 'ServiceURL', 'ProductionUrl'),
      authMethods: deriveApiAuthMethods(spec, entity),
      configuration: deriveApiConfiguration(spec, entity),
      apiReference: spec ? extractOpenApiResources(spec) : undefined,
      schemaView: spec ? extractSchemaSummary(spec) : undefined,
      url: canonicalUrl(this.config.apiHubBaseUrl, 'api', id),
      metadata: entity
    };
  }

  private async fetchEvent(id: string, cookie: string, requestedVersion?: string): Promise<unknown> {
    const metadata = await this.getJson(
      `/odata/1.0/catalog.svc/EventContent.Events('${odataKey(id)}')?$select=*&$format=json`,
      cookie
    );
    const entity = unwrapOData(metadata) as AnyRecord;
    const versions = await this.fetchEventVersions(id, cookie).catch(error => {
      logger.warn(`Could not fetch event versions for ${id}`, error);
      return [];
    });
    const version = requestedVersion || pickString(entity, 'Version') || pickString(versions[0], 'Version', 'Name') || pickString(entity, 'Release');
    const spec = version ? await this.getEventSpecJson(id, cookie, version).catch(error => {
      logger.warn(`Could not fetch AsyncAPI JSON for event ${id} version ${version}`, error);
      return undefined;
    }) : undefined;

    return {
      id,
      kind: 'event',
      title: pickString(entity, 'DisplayName', 'Title', 'Name') || titleFromSpec(spec) || id,
      description: cleanText(pickString(entity, 'Description', 'ShortDescription', 'Summary')),
      introduction: cleanText(pickString(entity, 'Introduction', 'LongDescription', 'Description')),
      status: pickString(entity, 'State', 'Status', 'APIState'),
      type: pickString(entity, 'Type') || 'EVENT',
      release: pickString(entity, 'Release', 'ReleaseVersion'),
      version,
      versions: versions.map(versionItem => normalizeLooseRecord(versionItem)),
      eventReference: spec ? extractAsyncApiResources(spec) : undefined,
      url: canonicalUrl(this.config.apiHubBaseUrl, 'event', id),
      metadata: entity
    };
  }

  private async fetchCdsView(id: string, cookie: string): Promise<unknown> {
    const entityResponse = await this.getJson(
      `/odata/1.0/catalog.svc/CdsViewsContent.CdsViews('${odataKey(id)}')?$format=json`,
      cookie
    );
    const entity = unwrapOData(entityResponse) as AnyRecord;
    const value = await this.fetchCdsValue(id, cookie).catch(error => {
      logger.warn(`Could not fetch CDS $value for ${id}`, error);
      return undefined;
    });
    const valueJson = isRecord(value?.json) ? value.json : undefined;
    const artifact = await this.getJson(
      `/odata/1.0/catalog.svc/Artifacts(Name='${odataKey(id)}',Type='CDSVIEW')?$format=json&$expand=ContentPackages/Files,ContentPackages/Urls`,
      cookie
    ).then(unwrapOData).catch(error => {
      logger.warn(`Could not fetch generic CDS artifact metadata for ${id}`, error);
      return undefined;
    });
    const artifactRecord = isRecord(artifact) ? artifact : {};
    const fields = extractCdsFields(valueJson || entity);

    return {
      id,
      kind: 'cdsview',
      title: pickString(entity, 'DisplayName', 'Title', 'Name') || pickString(valueJson, 'title', 'Title') || id,
      description: cleanText(pickString(entity, 'Description', 'ShortDescription', 'Summary') || pickString(valueJson, 'description', 'Description')),
      introduction: cleanText(pickString(valueJson, 'Introduction', 'introduction') || pickString(entity, 'Introduction', 'Description')),
      package: {
        id: pickString(entity, 'PackageId', 'PackageName', 'ParentTechnicalName') || pickString(artifactRecord, 'PackageName'),
        title: pickString(entity, 'PackageDisplayName', 'ParentDisplayName') || pickString(artifactRecord, 'PackageDisplayName')
      },
      category: pickString(entity, 'Category') || pickString(valueJson, 'category', 'Category'),
      sapObjectNodeType: pickString(entity, 'SAPObjectNodeType', 'SapObjectNodeType', 'ObjectNodeType') || pickString(valueJson, 'sapObjectNodeType', 'SAPObjectNodeType'),
      releaseState: extractReleaseState(entity, valueJson),
      capabilities: extractCapabilities(entity, valueJson),
      extensibility: extractExtensibility(entity, valueJson),
      businessContexts: extractBusinessContexts(entity, valueJson),
      fields,
      fieldCount: fields.length,
      docs: [...extractUrls(valueJson), ...extractUrls(artifactRecord)],
      url: canonicalUrl(this.config.apiHubBaseUrl, 'cdsview', id),
      metadata: entity,
      valueSummary: value ? summarizeGenericValue(value, false) : undefined
    };
  }

  private async fetchGenericArtifact(id: string, artifactType: string, cookie: string): Promise<unknown> {
    const metadata = await this.getJson(
      `/odata/1.0/catalog.svc/Artifacts(Name='${odataKey(id)}',Type='${odataKey(artifactType)}')?$format=json`,
      cookie
    );
    const entity = unwrapOData(metadata) as AnyRecord;
    const value = await this.fetchGenericArtifactValue(id, artifactType, cookie).catch(error => {
      logger.warn(`Could not fetch generic artifact $value for ${artifactType}/${id}`, error);
      return undefined;
    });

    return {
      id,
      kind: 'artifact',
      artifactType,
      title: pickString(entity, 'DisplayName', 'Title', 'Name') || id,
      description: cleanText(pickString(entity, 'Description', 'ShortDescription', 'Summary')),
      subType: pickString(entity, 'SubType'),
      state: pickString(entity, 'State', 'Status', 'APIState'),
      version: pickString(entity, 'Version', 'Release'),
      package: {
        id: pickString(entity, 'PackageId', 'PackageName', 'ParentTechnicalName'),
        title: pickString(entity, 'PackageDisplayName', 'ParentDisplayName')
      },
      docs: extractUrls(entity),
      value: value ? summarizeGenericValue(value, true) : undefined,
      metadata: entity
    };
  }

  private async fetchCdsValue(id: string, cookie: string): Promise<GenericValue> {
    const raw = await this.getRaw(
      `/odata/1.0/catalog.svc/CdsViewsContent.CdsViews('${odataKey(id)}')/$value`,
      cookie,
      'application/json, text/plain, */*'
    );
    return {
      contentType: raw.contentType,
      text: raw.text,
      json: parseJsonSafe(raw.text)
    };
  }

  private async fetchGenericArtifactValue(id: string, artifactType: string, cookie: string): Promise<GenericValue> {
    const raw = await this.getRaw(
      `/odata/1.0/catalog.svc/Artifacts(Name='${odataKey(id)}',Type='${odataKey(artifactType)}')/$value`,
      cookie,
      'application/json, application/xml, text/plain, */*'
    );
    return {
      contentType: raw.contentType,
      text: raw.text,
      json: parseJsonSafe(raw.text)
    };
  }

  private async fetchEventVersions(id: string, cookie: string): Promise<AnyRecord[]> {
    const raw = await this.getJson(
      `/odata/1.0/catalog.svc/EventContent.Events('${odataKey(id)}')/Versions?$format=json`,
      cookie
    );
    return unwrapODataCollection(raw).filter(isRecord);
  }

  private async resolveEventVersion(id: string, cookie: string, requestedVersion?: string): Promise<string | undefined> {
    if (requestedVersion) return requestedVersion;
    const versions = await this.fetchEventVersions(id, cookie).catch(() => []);
    return pickString(versions[0], 'Version', 'Name', 'Release');
  }

  private async getApiSpecJson(id: string, cookie: string): Promise<unknown> {
    const raw = await this.getApiSpecRaw(id, 'json', cookie);
    return parseJsonRequired(raw.text, `OpenAPI JSON for ${id}`);
  }

  private async getEventSpecJson(id: string, cookie: string, version?: string): Promise<unknown> {
    const raw = await this.getEventSpecRaw(id, 'json', cookie, version);
    return parseJsonRequired(raw.text, `AsyncAPI JSON for ${id}`);
  }

  private async getApiSpecRaw(id: string, format: SpecFormat, cookie: string): Promise<RawResponse> {
    return this.getRaw(
      `/odata/1.0/catalog.svc/APIContent.APIs('${odataKey(id)}')/$value?type=${encodeURIComponent(format)}`,
      cookie,
      acceptForFormat(format)
    );
  }

  private async getEventSpecRaw(id: string, format: SpecFormat, cookie: string, version?: string): Promise<RawResponse> {
    const params = new URLSearchParams();
    params.set('type', format);
    if (version) params.set('Version', version);
    return this.getRaw(
      `/odata/1.0/catalog.svc/EventContent.Events('${odataKey(id)}')/$value?${params.toString()}`,
      cookie,
      acceptForFormat(format)
    );
  }

  private async getJson(path: string, cookie: string): Promise<unknown> {
    const raw = await this.getRaw(path, cookie, 'application/json');
    try {
      return normalizeSapDates(JSON.parse(raw.text));
    } catch (error) {
      throw new Error(`Failed to parse SAP API Hub JSON from ${raw.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getRaw(path: string, cookie: string, accept: string): Promise<RawResponse> {
    const url = new URL(path, this.config.apiHubBaseUrl);
    logger.info(`GET ${url.toString()}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept,
        'accept-language': 'en-US,en;q=0.9',
        cookie,
        referer: `${this.config.apiHubBaseUrl}/`,
        'user-agent': `sap-api-hub-mcp/${PACKAGE_VERSION}`
      }
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`SAP API Hub endpoint ${url.toString()} returned ${response.status}: ${snippet(text, 500)}`);
    }

    if (isLoginHtml(contentType, text)) {
      throw new Error(`SESSION_EXPIRED: SAP API Hub endpoint ${url.toString()} returned login HTML instead of ${accept}`);
    }

    return {
      url: url.toString(),
      status: response.status,
      contentType,
      text
    };
  }
}

function normalizeCategory(container: AnyRecord): ApiHubCategory | undefined {
  const categoryKey = pickString(container, 'Name', 'name', 'TechnicalName', 'technicalName', 'Key', 'key');
  if (!categoryKey) return undefined;

  const aggregation = parseAggregation(pickString(container, 'aggregation', 'Aggregation'));
  return {
    categoryKey,
    title: pickString(container, 'DisplayName', 'displayName', 'Title', 'title', 'Name', 'name') || categoryKey,
    description: cleanText(pickString(container, 'Description', 'description')),
    packageCount: asNumber(pickValue(aggregation, 'TotalPackages', 'PackageCount', 'Packages') ?? pickValue(container, 'packageCount', 'PackageCount')),
    artifactCount: asNumber(pickValue(aggregation, 'TotalArtifacts', 'ArtifactCount', 'Artifacts') ?? pickValue(container, 'artifactCount', 'ArtifactCount')),
    subtypeCounts: extractSubtypeCounts(aggregation),
    raw: toJsonObject(container)
  };
}

function normalizeSearchResults(raw: unknown, baseUrl: string, input: SearchInput) {
  const hitRecords = extractHits(raw);
  return hitRecords.map(hit => {
    const source = isRecord(hit._source) ? hit._source : hit;
    const id = pickString(source, 'Name', 'TechnicalName', 'Id', 'ID', 'name') || '';
    const artifactType = pickString(source, 'Type', 'ArtifactType') || input.artifactType;
    const categoryKey = input.categoryKey || pickString(source, 'ContainerName', 'ContentType', 'CategoryKey');
    return {
      id,
      title: pickString(source, 'DisplayName', 'Title', 'Name') || id,
      categoryKey,
      artifactType,
      subType: pickString(source, 'SubType'),
      package: {
        id: pickString(source, 'ParentTechnicalName', 'PackageId', 'PackageName'),
        title: pickString(source, 'ParentDisplayName', 'PackageDisplayName')
      },
      state: pickString(source, 'APIState', 'State', 'Status'),
      status: pickString(source, 'Status'),
      version: pickString(source, 'Version', 'Release'),
      description: cleanText(pickString(source, 'Description', 'ShortDescription', 'Summary')),
      url: canonicalUrl(baseUrl, inferKindFromSearch(categoryKey, artifactType), id),
      raw: toJsonObject(source)
    };
  }).filter(result => result.id);
}

function extractHits(raw: unknown): AnyRecord[] {
  if (!isRecord(raw)) return [];
  const hits = raw.hits;
  if (isRecord(hits) && Array.isArray(hits.hits)) return hits.hits.filter(isRecord);
  if (Array.isArray(raw.results)) return raw.results.filter(isRecord);
  if (Array.isArray(raw.value)) return raw.value.filter(isRecord);
  return unwrapODataCollection(raw).filter(isRecord);
}

function extractSearchTotal(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const hits = raw.hits;
  if (!isRecord(hits)) return undefined;
  if (typeof hits.total === 'number') return hits.total;
  if (isRecord(hits.total) && typeof hits.total.value === 'number') return hits.total.value;
  return undefined;
}

function inferKindFromSearch(categoryKey?: string, artifactType?: string): 'api' | 'event' | 'cdsview' | 'artifact' {
  if (categoryKey && CATEGORY_ROUTE_PREFIX[categoryKey] === 'api') return 'api';
  if (categoryKey && CATEGORY_ROUTE_PREFIX[categoryKey] === 'event') return 'event';
  if (categoryKey && CATEGORY_ROUTE_PREFIX[categoryKey] === 'cdsviews') return 'cdsview';

  const type = (artifactType || '').toUpperCase();
  if (type === 'API') return 'api';
  if (type === 'EVENT') return 'event';
  if (type === 'CDSVIEW' || type === 'CDS_VIEW') return 'cdsview';
  return 'artifact';
}

function collectContainers(raw: unknown): AnyRecord[] {
  const containers: AnyRecord[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === 'containers') {
        if (Array.isArray(child)) containers.push(...child.filter(isRecord));
        else if (isRecord(child) && Array.isArray(child.results)) containers.push(...child.results.filter(isRecord));
        continue;
      }
      if (key !== '__metadata') visit(child);
    }
  };

  visit(raw);
  if (containers.length === 0 && Array.isArray(raw)) return raw.filter(isRecord);
  return containers;
}

function unwrapOData(value: unknown): unknown {
  const normalized = normalizeSapDates(value);
  if (isRecord(normalized) && normalized.d !== undefined) return normalized.d;
  return normalized;
}

function unwrapODataCollection(value: unknown): unknown[] {
  const unwrapped = unwrapOData(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (isRecord(unwrapped) && Array.isArray(unwrapped.results)) return unwrapped.results;
  if (isRecord(unwrapped) && Array.isArray(unwrapped.value)) return unwrapped.value;
  return [];
}

function normalizeLooseRecord(record: AnyRecord): AnyRecord {
  return normalizeSapDates(record) as AnyRecord;
}

function deriveApiAuthMethods(spec: unknown, metadata: AnyRecord): AnyRecord[] {
  const methods: AnyRecord[] = [];
  const root = isRecord(spec) ? spec : {};
  const components = isRecord(root.components) ? root.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};

  for (const [name, value] of Object.entries(schemes)) {
    const scheme = isRecord(value) ? value : {};
    methods.push({
      name,
      label: authLabel(name, scheme),
      type: pickString(scheme, 'type'),
      scheme: pickString(scheme, 'scheme'),
      in: pickString(scheme, 'in'),
      bearerFormat: pickString(scheme, 'bearerFormat'),
      description: cleanText(pickString(scheme, 'description'))
    });
  }

  const metadataAuth = pickString(metadata, 'Authentication', 'AuthType', 'AuthenticationType');
  if (methods.length === 0 && metadataAuth) {
    methods.push({ name: metadataAuth, label: metadataAuth });
  }

  const securityRequirements = Array.isArray(root.security) ? root.security.filter(isRecord) : [];
  return methods.map(method => ({
    ...method,
    requiredInRootSecurity: securityRequirements.some(requirement => Object.prototype.hasOwnProperty.call(requirement, String(method.name)))
  }));
}

function authLabel(name: string, scheme: AnyRecord): string {
  const type = pickString(scheme, 'type')?.toLowerCase();
  const schemeValue = pickString(scheme, 'scheme')?.toLowerCase();
  const normalized = name.toLowerCase();
  if (schemeValue === 'basic' || normalized.includes('basic')) return 'Basic Authentication';
  if (type === 'oauth2' || normalized.includes('oauth')) return 'OAuth 2.0';
  if (type === 'apiKey') return 'API Key';
  if (schemeValue === 'bearer') return 'Bearer Token';
  return name;
}

function deriveApiConfiguration(spec: unknown, metadata: AnyRecord): AnyRecord {
  const root = isRecord(spec) ? spec : {};
  const servers = Array.isArray(root.servers)
    ? root.servers.filter(isRecord).map(server => ({
        url: pickString(server, 'url'),
        description: cleanText(pickString(server, 'description'))
      }))
    : [];

  return {
    serviceUrl: pickString(metadata, 'ServiceUrl', 'ServiceURL', 'ProductionUrl'),
    sandboxUrl: servers.find(server => String(server.description || '').toLowerCase().includes('sandbox'))?.url,
    productionUrl: servers.find(server => String(server.description || '').toLowerCase().includes('production'))?.url,
    servers
  };
}

function extractOpenApiResources(spec: unknown): AnyRecord {
  const root = isRecord(spec) ? spec : {};
  const paths = isRecord(root.paths) ? root.paths : {};
  const operations: AnyRecord[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isRecord(operation)) continue;
      operations.push({
        tag: Array.isArray(operation.tags) ? String(operation.tags[0] || 'default') : 'default',
        method: method.toUpperCase(),
        path,
        summary: cleanText(pickString(operation, 'summary')),
        description: cleanText(pickString(operation, 'description')),
        operationId: pickString(operation, 'operationId'),
        parameters: summarizeParameters(operation.parameters),
        requestBody: summarizeRequestBody(operation.requestBody),
        responseCodes: isRecord(operation.responses) ? Object.keys(operation.responses) : []
      });
    }
  }

  const groupedByTag = groupBy(operations, operation => String(operation.tag || 'default'));
  return {
    pathCount: Object.keys(paths).length,
    operationCount: operations.length,
    tags: Object.keys(groupedByTag),
    operations,
    groupedByTag
  };
}

function extractAsyncApiResources(spec: unknown): AnyRecord {
  const root = isRecord(spec) ? spec : {};
  const channels = isRecord(root.channels) ? root.channels : {};
  const operations: AnyRecord[] = [];

  for (const [channelName, channelValue] of Object.entries(channels)) {
    if (!isRecord(channelValue)) continue;
    for (const direction of ['publish', 'subscribe'] as const) {
      const operation = channelValue[direction];
      if (!isRecord(operation)) continue;
      const messageRefs = extractMessageRefs(operation.message);
      operations.push({
        direction,
        channel: channelName,
        address: pickString(channelValue, 'address') || channelName,
        summary: cleanText(pickString(operation, 'summary')),
        description: cleanText(pickString(operation, 'description')),
        messageRefs,
        messages: messageRefs.map(ref => summarizeAsyncMessage(root, ref))
      });
    }
  }

  return {
    channelCount: Object.keys(channels).length,
    operationCount: operations.length,
    operations
  };
}

function extractMessageRefs(message: unknown): string[] {
  if (isRecord(message) && typeof message.$ref === 'string') return [message.$ref];
  if (isRecord(message) && Array.isArray(message.oneOf)) {
    return message.oneOf.map(item => isRecord(item) && typeof item.$ref === 'string' ? item.$ref : undefined).filter((value): value is string => Boolean(value));
  }
  return [];
}

function summarizeAsyncMessage(root: AnyRecord, ref: string): AnyRecord {
  const messageName = ref.split('/').pop() || ref;
  const components = isRecord(root.components) ? root.components : {};
  const messages = isRecord(components.messages) ? components.messages : {};
  const message = isRecord(messages[messageName]) ? messages[messageName] : {};
  const payload = isRecord(message.payload) ? message.payload : {};
  const headers = isRecord(message.headers) ? message.headers : {};

  return {
    name: messageName,
    title: pickString(message, 'title', 'name') || messageName,
    summary: cleanText(pickString(message, 'summary')),
    payloadSchemaRef: typeof payload.$ref === 'string' ? payload.$ref : undefined,
    headerTraits: Object.keys(headers)
  };
}

function summarizeParameters(parameters: unknown): AnyRecord[] {
  if (!Array.isArray(parameters)) return [];
  return parameters.filter(isRecord).map(parameter => ({
    name: pickString(parameter, 'name'),
    in: pickString(parameter, 'in'),
    required: typeof parameter.required === 'boolean' ? parameter.required : undefined,
    description: cleanText(pickString(parameter, 'description')),
    schema: summarizeSchemaRef(parameter.schema)
  }));
}

function summarizeRequestBody(requestBody: unknown): AnyRecord | undefined {
  if (!isRecord(requestBody)) return undefined;
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  return {
    required: typeof requestBody.required === 'boolean' ? requestBody.required : undefined,
    contentTypes: Object.keys(content),
    description: cleanText(pickString(requestBody, 'description'))
  };
}

function summarizeSchemaRef(schema: unknown): AnyRecord | undefined {
  if (!isRecord(schema)) return undefined;
  return {
    ref: typeof schema.$ref === 'string' ? schema.$ref : undefined,
    type: pickString(schema, 'type'),
    format: pickString(schema, 'format')
  };
}

function extractSchemaSummary(spec: unknown): AnyRecord {
  const root = isRecord(spec) ? spec : {};
  const components = isRecord(root.components) ? root.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  return {
    schemaCount: Object.keys(schemas).length,
    schemas: Object.entries(schemas).map(([name, schema]) => {
      const schemaRecord = isRecord(schema) ? schema : {};
      const properties = isRecord(schemaRecord.properties) ? schemaRecord.properties : {};
      return {
        name,
        type: pickString(schemaRecord, 'type'),
        propertyCount: Object.keys(properties).length,
        properties: Object.keys(properties).slice(0, 50)
      };
    })
  };
}

function extractCdsFields(source: unknown): AnyRecord[] {
  const fields = findNamedArray(source, ['fields', 'Fields', 'FieldList', 'elements', 'Elements']);
  return fields.filter(isRecord).map(field => ({
    name: pickString(field, 'Name', 'FieldName', 'fieldName', 'name'),
    description: cleanText(pickString(field, 'Description', 'description', 'Label', 'label')),
    dataType: pickString(field, 'DataType', 'dataType', 'Type', 'type'),
    length: pickString(field, 'FieldLength', 'Length', 'length'),
    successor: pickString(field, 'Successor', 'successor')
  })).filter(field => field.name);
}

function extractReleaseState(...sources: Array<unknown>): AnyRecord {
  const result: AnyRecord = {};
  for (const source of sources) {
    if (!isRecord(source)) continue;
    result.keyUserExtensibility = result.keyUserExtensibility || pickString(source, 'ReleaseStateKeyUserExtensibility', 'releaseStateKeyUserExtensibility');
    result.developerExtensibility = result.developerExtensibility || pickString(source, 'ReleaseStateDeveloperExtensibility', 'releaseStateDeveloperExtensibility');
    result.overall = result.overall || pickString(source, 'ReleaseState', 'releaseState', 'State');
  }
  return result;
}

function extractCapabilities(...sources: Array<unknown>): unknown[] {
  for (const source of sources) {
    const direct = findNamedArray(source, ['SupportedCapabilities', 'supportedCapabilities', 'Capabilities', 'capabilities']);
    if (direct.length > 0) {
      return direct.map(item => isRecord(item) ? {
        name: pickString(item, 'Name', 'Title', 'name', 'title') || JSON.stringify(item)
      } : String(item));
    }
  }
  return [];
}

function extractExtensibility(...sources: Array<unknown>): AnyRecord {
  const result: AnyRecord = {};
  for (const source of sources) {
    if (!isRecord(source)) continue;
    result.keyUser = result.keyUser ?? pickValue(source, 'ExtensibleWithKeyUserExtensibility', 'extensibleWithKeyUserExtensibility');
    result.developer = result.developer ?? pickValue(source, 'ExtensibleWithDeveloperExtensibility', 'extensibleWithDeveloperExtensibility');
  }
  return result;
}

function extractBusinessContexts(...sources: Array<unknown>): unknown[] {
  for (const source of sources) {
    const contexts = findNamedArray(source, ['BusinessContexts', 'businessContexts', 'BusinessContext', 'businessContext']);
    if (contexts.length > 0) {
      return contexts.map(item => isRecord(item) ? {
        name: pickString(item, 'Name', 'Title', 'name', 'title') || JSON.stringify(item),
        id: pickString(item, 'Id', 'ID', 'id')
      } : String(item));
    }
  }
  return [];
}

function summarizeGenericValue(value: GenericValue, includeParsedSmallJson: boolean): AnyRecord {
  const textPreview = (cleanText(value.text) || '').slice(0, 2000);
  const summary: AnyRecord = {
    contentType: value.contentType,
    size: value.text.length,
    preview: textPreview
  };

  if (value.json !== undefined) {
    summary.jsonKeys = isRecord(value.json) ? Object.keys(value.json) : undefined;
    summary.sections = extractGenericSections(value.json);
    if (includeParsedSmallJson && value.text.length < 100_000) {
      summary.parsed = value.json as never;
    }
  } else if (value.text.trimStart().startsWith('<')) {
    const rootMatch = value.text.match(/<([A-Za-z0-9_:.-]+)/);
    summary.xmlRoot = rootMatch?.[1];
  }

  return summary;
}

function extractGenericSections(json: unknown): AnyRecord[] {
  if (!isRecord(json)) return [];
  return Object.entries(json).map(([key, value]) => ({
    name: key,
    type: Array.isArray(value) ? 'array' : typeof value,
    count: Array.isArray(value) ? value.length : undefined
  })).slice(0, 100);
}

function groupPackageArtifacts(artifacts: AnyRecord[], baseUrl: string): AnyRecord {
  const normalized = artifacts.map(artifact => {
    const id = pickString(artifact, 'Name', 'TechnicalName', 'Id', 'ID') || '';
    const artifactType = pickString(artifact, 'Type', 'ArtifactType');
    const categoryKey = pickString(artifact, 'ContentType', 'ContainerName');
    return {
      id,
      title: pickString(artifact, 'DisplayName', 'Title', 'Name') || id,
      artifactType,
      subType: pickString(artifact, 'SubType'),
      state: pickString(artifact, 'State', 'Status', 'APIState'),
      version: pickString(artifact, 'Version', 'Release'),
      url: canonicalUrl(baseUrl, inferKindFromSearch(categoryKey, artifactType), id)
    };
  });

  return {
    items: normalized,
    groupedByType: groupBy(normalized, item => [item.artifactType, item.subType].filter(Boolean).join('/') || 'unknown')
  };
}

function extractUrls(source: unknown): AnyRecord[] {
  const urls: AnyRecord[] = [];
  const visit = (value: unknown, title?: string) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      urls.push({ title, url: value });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, title);
      return;
    }
    if (!isRecord(value)) return;
    const url = pickString(value, 'Url', 'URL', 'url', 'Href', 'href', 'Link', 'link');
    if (url && /^https?:\/\//i.test(url)) {
      urls.push({ title: pickString(value, 'Title', 'Name', 'DisplayName') || title, url });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '__metadata') visit(child, key);
    }
  };
  visit(source);
  return uniqueBy(urls, item => String(item.url));
}

function parseAggregation(value?: string): AnyRecord {
  if (!value) return {};
  const parsed = parseJsonSafe(value);
  return isRecord(parsed) ? parsed : {};
}

function extractSubtypeCounts(aggregation: AnyRecord): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(aggregation)) {
    if (['TotalPackages', 'TotalArtifacts', 'ArtifactCount', 'PackageCount'].includes(key)) continue;
    if (typeof value === 'number') result[key] = value;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isRecord(item)) continue;
        const name = pickString(item, 'Name', 'name', 'Type', 'type', 'SubType', 'subType');
        const count = asNumber(pickValue(item, 'Count', 'count', 'Total', 'total'));
        if (name && count !== undefined) result[name] = count;
      }
    }
    if (isRecord(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        const count = asNumber(nestedValue);
        if (count !== undefined) result[nestedKey] = count;
      }
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function validateSpecFormat(kind: string, format: SpecFormat): void {
  const allowed: Record<string, SpecFormat[]> = {
    api: ['json', 'yaml', 'edmx'],
    event: ['json', 'yaml'],
    cdsview: ['json'],
    artifact: ['raw']
  };
  if (!allowed[kind]?.includes(format)) {
    throw new Error(`Unsupported spec format "${format}" for kind "${kind}". Supported formats: ${(allowed[kind] || []).join(', ')}`);
  }
}

function requireArtifactType(artifactType?: string): string {
  if (!artifactType) throw new Error('artifactType is required when kind is artifact, for example artifactType=BADI');
  return artifactType;
}

function parseJsonRequired(text: string, label: string): unknown {
  const parsed = parseJsonSafe(text);
  if (parsed === undefined) throw new Error(`Failed to parse ${label}`);
  return parsed;
}

function parseJsonSafe(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return normalizeSapDates(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function normalizeSapDates(value: unknown): unknown {
  if (typeof value === 'string') {
    return parseMaybeDate(value);
  }
  if (Array.isArray(value)) return value.map(item => normalizeSapDates(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeSapDates(child)]));
  }
  return value;
}

function parseMaybeDate(value?: string): string | undefined {
  if (!value) return value;
  const match = value.trim().match(/^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/);
  if (!match) return value;
  const timestamp = Number.parseInt(match[1], 10);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toISOString();
}

function cleanText(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = htmlToText(value);
  return cleaned || undefined;
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(ul|ol|p|div|span|section|article)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function findNamedArray(source: unknown, names: string[]): unknown[] {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const seen = new Set<unknown>();

  const visit = (value: unknown): unknown[] | undefined => {
    if (seen.has(value)) return undefined;
    if (isRecord(value) || Array.isArray(value)) seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (!isRecord(value)) return undefined;
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase())) {
        if (Array.isArray(child)) return child;
        if (isRecord(child) && Array.isArray(child.results)) return child.results;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '__metadata') continue;
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };

  return visit(source) || [];
}

function pickString(record: unknown, ...keys: string[]): string | undefined {
  const value = pickValue(record, ...keys);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function pickValue(record: unknown, ...keys: string[]): unknown {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  const lowerKeys = keys.map(key => key.toLowerCase());
  for (const [recordKey, value] of Object.entries(record)) {
    if (lowerKeys.includes(recordKey.toLowerCase()) && value !== null && value !== undefined) return value;
  }
  return undefined;
}

function titleFromSpec(spec: unknown): string | undefined {
  const root = isRecord(spec) ? spec : {};
  const info = isRecord(root.info) ? root.info : {};
  return pickString(info, 'title');
}

function inferApiType(spec: unknown): string | undefined {
  const root = isRecord(spec) ? spec : {};
  if (typeof root.openapi === 'string') return 'OpenAPI';
  return undefined;
}

function canonicalUrl(baseUrl: string, kind: 'api' | 'event' | 'cdsview' | 'artifact', id: string): string | undefined {
  if (!id) return undefined;
  if (kind === 'api') return `${baseUrl}/api/${encodeURIComponent(id)}/overview`;
  if (kind === 'event') return `${baseUrl}/event/${encodeURIComponent(id)}/overview`;
  if (kind === 'cdsview') return `${baseUrl}/cdsviews/${encodeURIComponent(id)}`;
  return undefined;
}

function isLoginHtml(contentType: string, text: string): boolean {
  const start = text.trimStart().slice(0, 500).toLowerCase();
  return contentType.includes('text/html') || start.startsWith('<html') || start.includes('sappubliccatalog.authentication');
}

function snippet(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').slice(0, max);
}

function odataKey(value: string): string {
  return encodeURIComponent(value.replace(/'/g, "''"));
}

function escapeJsonString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function acceptForFormat(format: SpecFormat): string {
  if (format === 'json') return 'application/json';
  if (format === 'yaml') return 'application/yaml, text/yaml, text/plain';
  if (format === 'edmx') return 'application/xml, text/xml, text/plain';
  return 'application/octet-stream, text/plain, */*';
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const key = keyFn(item);
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value as JsonObject : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
