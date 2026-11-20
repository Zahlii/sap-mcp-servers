#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SapWebAuthenticator } from '@marianfoo/sap-mcp-auth';
import { createApiHubAuthenticator } from './auth.js';
import { SapApiHubClient } from './api-hub-client.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import {
  FetchInputSchema,
  PackageInputSchema,
  ResourcesInputSchema,
  SearchInputSchema,
  SpecInputSchema
} from './schemas.js';
import type { FetchInput, PackageInput, ResourcesInput, SearchInput, ServerConfig, SpecInput } from './types.js';
import { PACKAGE_VERSION } from './version.js';

class SapApiHubMcpServer {
  private config: ServerConfig;
  private authenticator: SapWebAuthenticator;
  private apiHubClient: SapApiHubClient;
  private mcpServer: McpServer;
  private httpServer?: HttpServer;
  private streamableSessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    server: SapApiHubMcpServer;
  }>();

  constructor() {
    this.config = loadConfig();
    this.authenticator = createApiHubAuthenticator(this.config);
    this.apiHubClient = new SapApiHubClient(this.config);
    this.mcpServer = new McpServer({
      name: 'sap-api-hub-mcp',
      version: PACKAGE_VERSION
    });

    this.setupTools();
  }

  async start(): Promise<void> {
    const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
    if (transport === 'streamable-http' || transport === 'http' || transport === 'streamable') {
      await this.startStreamableHttp();
      return;
    }

    await this.startStdio();
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, session] of this.streamableSessions) {
      this.streamableSessions.delete(sessionId);
      await session.transport.close().catch(error => logger.warn(`Failed to close Streamable HTTP transport ${sessionId}`, error));
      await session.server.shutdown().catch(error => logger.warn(`Failed to close Streamable HTTP server ${sessionId}`, error));
    }

    if (this.httpServer) {
      await new Promise<void>(resolveClose => this.httpServer!.close(() => resolveClose()));
      this.httpServer = undefined;
    }

    await this.mcpServer.close().catch(error => logger.warn('Failed to close MCP server', error));
    await this.closeRuntimeResources();
  }

  private async startStdio(): Promise<void> {
    logger.warn('Starting SAP API Hub MCP Server over stdio');
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    logger.warn('SAP API Hub MCP Server ready on stdio');
  }

  private async connectTransport(transport: StdioServerTransport | StreamableHTTPServerTransport): Promise<void> {
    await this.mcpServer.connect(transport);
  }

  private async startStreamableHttp(): Promise<void> {
    const port = Number.parseInt(process.env.MCP_PORT || process.env.PORT || '3001', 10);
    const host = process.env.MCP_HOST || '127.0.0.1';
    const path = process.env.MCP_HTTP_PATH || '/mcp';

    this.httpServer = createServer(async (req, res) => {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      if (requestUrl.pathname !== path) {
        writeJsonRpcError(res, 404, `Not found. MCP endpoint is ${path}.`);
        return;
      }

      if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
        writeJsonRpcError(res, 405, 'Method not allowed.');
        return;
      }

      let parsedBody: unknown;
      let createdTransport: StreamableHTTPServerTransport | undefined;
      let createdServer: SapApiHubMcpServer | undefined;

      try {
        if (req.method === 'POST') {
          parsedBody = await readJsonBody(req);
        }

        const sessionId = getSessionId(req);
        let session = sessionId ? this.streamableSessions.get(sessionId) : undefined;

        if (!session) {
          if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
            writeJsonRpcError(res, 400, 'Bad Request: initialize with POST before using this Streamable HTTP session.');
            return;
          }

          const sessionServer = new SapApiHubMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: initializedSessionId => {
              this.streamableSessions.set(initializedSessionId, {
                transport,
                server: sessionServer
              });
              logger.warn(`SAP API Hub Streamable HTTP session initialized: ${initializedSessionId}`);
            }
          });

          transport.onclose = () => {
            const initializedSessionId = transport.sessionId;
            if (initializedSessionId) {
              this.streamableSessions.delete(initializedSessionId);
              logger.warn(`SAP API Hub Streamable HTTP session closed: ${initializedSessionId}`);
            }
            void sessionServer.closeRuntimeResources().catch(error => logger.warn('Failed to close API Hub session runtime resources', error));
          };

          createdTransport = transport;
          createdServer = sessionServer;
          await sessionServer.connectTransport(transport);
          session = { transport, server: sessionServer };
        }

        await session.transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`SAP API Hub Streamable HTTP request failed: ${message}`);
        if (createdTransport && !createdTransport.sessionId) {
          await createdTransport.close().catch(closeError => logger.warn('Failed to close failed Streamable HTTP transport', closeError));
          await createdServer?.shutdown().catch(closeError => logger.warn('Failed to shutdown failed Streamable HTTP server', closeError));
        }
        if (!res.headersSent) {
          writeJsonRpcError(res, 500, 'Internal server error.');
        }
      }
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      this.httpServer!.once('error', rejectListen);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off('error', rejectListen);
        resolveListen();
      });
    });

    logger.warn(`SAP API Hub MCP Server ready over Streamable HTTP at http://${host}:${port}${path}`);
  }

  private async closeRuntimeResources(): Promise<void> {
    await this.authenticator.destroy();
  }

  private async withAuthRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { cookieHeader } = await this.authenticator.ensureSession();
    try {
      return await fn(cookieHeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SESSION_EXPIRED') || message.includes('401') || message.includes('Unauthorized')) {
        logger.warn('API Hub session expired, re-authenticating and retrying once');
        this.authenticator.invalidateAuth();
        const { cookieHeader: newCookie } = await this.authenticator.ensureSession();
        return fn(newCookie);
      }
      throw error;
    }
  }

  private setupTools(): void {
    this.mcpServer.registerTool(
      'categories',
      {
        title: 'List SAP API Hub Categories',
        description: 'Return SAP Business Accelerator Hub content categories, descriptions, package counts, artifact counts, subtype counts, and category keys usable in other tools.',
        inputSchema: {}
      },
      async () => {
        try {
          const response = await this.withAuthRetry(token => this.apiHubClient.categories(token));
          const text = [
            `Found ${response.categories.length} SAP API Hub content categories.`,
            '',
            ...response.categories.map(category => {
              const counts = [
                category.packageCount !== undefined ? `${category.packageCount} packages` : undefined,
                category.artifactCount !== undefined ? `${category.artifactCount} artifacts` : undefined
              ].filter(Boolean).join(', ');
              return `- ${category.title} (${category.categoryKey})${counts ? `: ${counts}` : ''}`;
            })
          ].join('\n');

          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: toStructuredContent(response)
          };
        } catch (error) {
          return this.errorResult('API Hub categories failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'search',
      {
        title: 'Search SAP API Hub',
        description: 'Search SAP Business Accelerator Hub artifacts. Optional categoryKey examples: API, Events, CDSViews, S4HANACloudBADI. Optional artifactType examples: API, Event, CDSVIEW, BADI. Data products have no category of their own: they are listed as API artifacts with subType DELTAAPI, in a package named "... Data Products API"; their entities and fields come only from `spec`.',
        inputSchema: SearchInputSchema
      },
      async ({ q, categoryKey, artifactType, top, skip }) => {
        try {
          const input: SearchInput = { q, categoryKey, artifactType, top, skip };
          const response = await this.withAuthRetry(token => this.apiHubClient.search(input, token));
          const shown = response.results.slice(0, Math.min(response.results.length, 10));
          const text = [
            `Found ${response.total ?? response.results.length} SAP API Hub result(s) for "${input.q}".`,
            '',
            ...shown.map(result => `- ${result.title} (${result.id})${result.artifactType ? ` [${result.artifactType}]` : ''}${result.url ? ` - ${result.url}` : ''}`)
          ].join('\n');

          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: toStructuredContent(response)
          };
        } catch (error) {
          return this.errorResult('API Hub search failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'fetch',
      {
        title: 'Fetch SAP API Hub Metadata',
        description: 'Fetch normalized metadata for an API, Event, CDS View, generic artifact, or package. APIs, Events, and CDS Views use category-specific extraction; other artifacts use a generic fallback.',
        inputSchema: FetchInputSchema
      },
      async ({ id, kind, artifactType, version }) => {
        try {
          const input: FetchInput = { id, kind, artifactType, version };
          validateArtifactTypeInput(input.kind, input.artifactType);
          const detail = await this.withAuthRetry(token => this.apiHubClient.fetch(input, token));

          return {
            content: [{ type: 'text' as const, text: renderFetchSummary(detail) }],
            structuredContent: toStructuredContent(detail)
          };
        } catch (error) {
          return this.errorResult('API Hub fetch failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'resources',
      {
        title: 'Fetch SAP API Hub Resource Summary',
        description: 'Return API paths, Event channels, CDS View fields/capabilities/business contexts, or generic artifact sections without returning full specs. A data product shows no paths here: its entities are only in the `spec` file.',
        inputSchema: ResourcesInputSchema
      },
      async ({ id, kind, artifactType, version }) => {
        try {
          const input: ResourcesInput = { id, kind, artifactType, version };
          validateArtifactTypeInput(input.kind, input.artifactType);
          const resources = await this.withAuthRetry(token => this.apiHubClient.resources(input, token));

          return {
            content: [{ type: 'text' as const, text: renderResourcesSummary(resources) }],
            structuredContent: toStructuredContent(resources)
          };
        } catch (error) {
          return this.errorResult('API Hub resources failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'spec',
      {
        title: 'Fetch SAP API Hub Specification',
        description: 'Download the full specification to a local file; the result holds its path in `file` and its size in bytes, never the body. Specs can be several MB: read or grep the file. APIs support json/yaml/edmx, Events support json/yaml, CDS Views support json, and generic artifacts support raw. A data product\'s API resource (e.g. sap-s4com-SalesOrder-v1) is kind api, format json, and returns CSN.',
        inputSchema: SpecInputSchema
      },
      async ({ id, kind, format, artifactType, version }) => {
        try {
          const input: SpecInput = { id, kind, format, artifactType, version };
          validateSpecInput(input);
          const spec = await this.withAuthRetry(token => this.apiHubClient.spec(input, token));
          const file = await saveSpec(this.config.specDir, input, spec.text);
          const result = {
            id,
            kind,
            format,
            version,
            url: spec.url,
            contentType: spec.contentType,
            size: Buffer.byteLength(spec.text),
            file
          };

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result
          };
        } catch (error) {
          return this.errorResult('API Hub spec failed', error);
        }
      }
    );

    this.mcpServer.registerTool(
      'package',
      {
        title: 'Fetch SAP API Hub Package',
        description: 'Return package metadata, documentation URLs/files, and artifacts grouped by type/subtype.',
        inputSchema: PackageInputSchema
      },
      async ({ id, includeArtifacts, top }) => {
        try {
          const input: PackageInput = { id, includeArtifacts, top };
          const packageDetail = await this.withAuthRetry(token => this.apiHubClient.fetchPackage(input, token));

          return {
            content: [{ type: 'text' as const, text: renderPackageSummary(packageDetail) }],
            structuredContent: toStructuredContent(packageDetail)
          };
        } catch (error) {
          return this.errorResult('API Hub package failed', error);
        }
      }
    );
  }

  private errorResult(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${prefix}: ${message}`);
    return {
      content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
      isError: true
    };
  }
}

function renderFetchSummary(detail: unknown): string {
  const record = asRecord(detail);
  const kind = stringValue(record.kind) || 'artifact';
  const title = stringValue(record.title) || stringValue(record.id) || 'SAP API Hub artifact';
  const lines = [`# ${title}`, ''];

  pushLine(lines, 'ID', stringValue(record.id));
  pushLine(lines, 'Kind', kind);
  pushLine(lines, 'Status', stringValue(record.status) || stringValue(record.state));
  pushLine(lines, 'Type', stringValue(record.type) || stringValue(record.artifactType));
  pushLine(lines, 'Version', stringValue(record.version));
  pushLine(lines, 'Release', stringValue(record.release));
  pushLine(lines, 'URL', stringValue(record.url));

  const description = stringValue(record.introduction) || stringValue(record.description);
  if (description) {
    lines.push('', '## Overview', '', description);
  }

  if (Array.isArray(record.authMethods)) {
    lines.push('', '## Authentication Methods', '');
    for (const method of record.authMethods) {
      const methodRecord = asRecord(method);
      lines.push(`- ${stringValue(methodRecord.label) || stringValue(methodRecord.name) || 'Unknown'}`);
    }
  }

  if (isRecord(record.configuration)) {
    const config = record.configuration;
    lines.push('', '## Configuration', '');
    pushLine(lines, 'Service URL', stringValue(config.serviceUrl));
    pushLine(lines, 'Sandbox URL', stringValue(config.sandboxUrl));
    pushLine(lines, 'Production URL', stringValue(config.productionUrl));
  }

  if (isRecord(record.apiReference)) {
    pushLine(lines, 'API operations', numberValue(record.apiReference.operationCount));
  }
  if (isRecord(record.eventReference)) {
    pushLine(lines, 'Event operations', numberValue(record.eventReference.operationCount));
  }
  if (typeof record.fieldCount === 'number') {
    pushLine(lines, 'Fields', record.fieldCount);
  }

  return lines.join('\n');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function getSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (Array.isArray(header)) return header[0];
  return header;
}

function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message
    },
    id: null
  }));
}

function validateArtifactTypeInput(kind: string, artifactType?: string): void {
  if (kind === 'artifact' && !artifactType) {
    throw new Error('artifactType is required when kind is artifact, for example artifactType=BADI');
  }
}

function validateSpecInput(input: SpecInput): void {
  validateArtifactTypeInput(input.kind, input.artifactType);
  const allowed: Record<string, string[]> = {
    api: ['json', 'yaml', 'edmx'],
    event: ['json', 'yaml'],
    cdsview: ['json'],
    artifact: ['raw']
  };
  if (!allowed[input.kind]?.includes(input.format)) {
    throw new Error(`Unsupported spec format "${input.format}" for kind "${input.kind}". Supported formats: ${(allowed[input.kind] || []).join(', ')}`);
  }
}

async function saveSpec(dir: string, input: SpecInput, text: string): Promise<string> {
  const name = [input.kind, input.artifactType, input.id, input.version].filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]/g, '_');
  const file = join(dir, `${name}.${input.format}`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, text);
  return file;
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function renderResourcesSummary(resources: unknown): string {
  const record = asRecord(resources);
  const title = `${stringValue(record.kind) || 'artifact'} resources for ${stringValue(record.id) || 'unknown'}`;
  const lines = [`# ${title}`, ''];

  pushLine(lines, 'Path count', numberValue(record.pathCount));
  pushLine(lines, 'Operation count', numberValue(record.operationCount));
  pushLine(lines, 'Channel count', numberValue(record.channelCount));

  if (Array.isArray(record.operations)) {
    const operations = record.operations.slice(0, 25);
    lines.push('', '## Operations', '');
    for (const operation of operations) {
      const op = asRecord(operation);
      const method = stringValue(op.method) || stringValue(op.direction) || '';
      const path = stringValue(op.path) || stringValue(op.channel) || '';
      const summary = stringValue(op.summary);
      lines.push(`- ${method} ${path}${summary ? ` - ${summary}` : ''}`.trim());
    }
  }

  if (Array.isArray(record.fields)) {
    lines.push('', '## Fields', '');
    for (const field of record.fields.slice(0, 50)) {
      const fieldRecord = asRecord(field);
      lines.push(`- ${stringValue(fieldRecord.name) || 'unknown'}${stringValue(fieldRecord.dataType) ? ` (${stringValue(fieldRecord.dataType)})` : ''}${stringValue(fieldRecord.description) ? ` - ${stringValue(fieldRecord.description)}` : ''}`);
    }
  }

  if (Array.isArray(record.sections)) {
    lines.push('', '## Sections', '');
    for (const section of record.sections.slice(0, 50)) {
      const sectionRecord = asRecord(section);
      lines.push(`- ${stringValue(sectionRecord.name) || 'unknown'} (${stringValue(sectionRecord.type) || 'unknown'})`);
    }
  }

  return lines.join('\n');
}

function renderPackageSummary(packageDetail: unknown): string {
  const record = asRecord(packageDetail);
  const lines = [`# ${stringValue(record.title) || stringValue(record.id) || 'SAP API Hub package'}`, ''];
  pushLine(lines, 'ID', stringValue(record.id));
  pushLine(lines, 'Vendor', stringValue(record.vendor));
  pushLine(lines, 'Version', stringValue(record.version));
  pushLine(lines, 'State', stringValue(record.state));
  pushLine(lines, 'Artifacts returned', numberValue(record.artifactCount));

  const description = stringValue(record.description);
  if (description) lines.push('', description);

  if (isRecord(record.artifacts) && isRecord(record.artifacts.groupedByType)) {
    lines.push('', '## Artifact Groups', '');
    for (const [group, items] of Object.entries(record.artifacts.groupedByType)) {
      lines.push(`- ${group}: ${Array.isArray(items) ? items.length : 0}`);
    }
  }

  return lines.join('\n');
}

function pushLine(lines: string[], label: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  lines.push(`- ${label}: ${value}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isDirectRun(): boolean {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? realpathSync(resolve(process.argv[1])) : '';
    return thisFile === invoked;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const server = new SapApiHubMcpServer();

  const shutdown = async () => {
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.start().catch(async error => {
    logger.error('SAP API Hub MCP Server failed to start', error);
    await server.shutdown();
    process.exit(1);
  });
}

export { SapApiHubMcpServer };
