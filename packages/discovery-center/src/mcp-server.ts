#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultLogger as logger } from '@marianfoo/sap-mcp-auth';
import { z } from 'zod';
import { createDiscoveryCenterAuthenticator } from './auth.js';
import { SapDiscoveryCenterClient } from './discovery-center-api.js';
import { PACKAGE_VERSION } from './version.js';

// MCP clients pass credentials via their "env" config; never override those.
loadDotenv({ path: process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : undefined, override: false, quiet: true });

const client = new SapDiscoveryCenterClient();
const authenticator = createDiscoveryCenterAuthenticator(client);

async function withAuthRetry<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  const { cookieHeader } = await authenticator.ensureSession();
  try {
    return await fn(cookieHeader);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SESSION_EXPIRED')) {
      logger.warn('Discovery Center session expired, re-authenticating and retrying once');
      authenticator.invalidateAuth();
      const { cookieHeader: freshCookie } = await authenticator.ensureSession();
      return fn(freshCookie);
    }
    throw error;
  }
}

function errorResult(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`${prefix}: ${message}`);
  return { content: [{ type: 'text' as const, text: `${prefix}: ${message}` }], isError: true };
}

const server = new McpServer({ name: 'sap-discovery-center-mcp', version: PACKAGE_VERSION });

server.registerTool(
  'mission_search',
  {
    title: 'Search SAP Discovery Center Missions',
    description:
      'Search the SAP Discovery Center mission catalog. Missions are guided, step-by-step implementation projects on SAP BTP, ' +
      'e.g. "Activate Joule for SAP SuccessFactors" or "Set Up Joule Studio". No SAP login needed. ' +
      'Follow up with `mission` for prerequisites, services and steps.',
    inputSchema: {
      query: z.string().min(1).describe('Search terms in English: product names or use case keywords.'),
      top: z.number().int().min(1).max(25).default(10).describe('Maximum number of missions to return.')
    },
    annotations: { readOnlyHint: true }
  },
  async ({ query, top }) => {
    try {
      const missions = await client.searchMissions(query, top);
      return {
        content: [{ type: 'text', text: `Found ${missions.length} mission(s) for "${query}".` }],
        structuredContent: { missions }
      };
    } catch (error) {
      return errorResult('Mission search failed', error);
    }
  }
);

server.registerTool(
  'mission',
  {
    title: 'Get SAP Discovery Center Mission',
    description:
      'Get one SAP Discovery Center mission: the use case, prerequisites, the BTP services it needs and its steps by phase ' +
      '(Discover, Prepare, Set Up, Complete). No SAP login needed. Step texts come from `mission_step`.',
    inputSchema: {
      missionId: z.string().min(1).describe('Mission ID from mission_search, or the mission name.')
    },
    annotations: { readOnlyHint: true }
  },
  async ({ missionId }) => {
    try {
      const mission = await client.missionDetail(missionId);
      return {
        content: [{ type: 'text', text: `${mission.name}: ${mission.steps.length} step(s), ${mission.services.length} service(s).` }],
        structuredContent: { mission }
      };
    } catch (error) {
      return errorResult('Mission fetch failed', error);
    }
  }
);

server.registerTool(
  'mission_step',
  {
    title: 'Get SAP Discovery Center Mission Step Content',
    description:
      'Get the instructions of mission steps: HTML or markdown text, or the GitHub / developers.sap.com tutorial a step links to. ' +
      'Requires SAP login. Omit stepId to get every step of the mission. Step texts exist only on a started mission: ' +
      'a mission the user has not started is started under their SAP account and stays in their "My Missions".',
    inputSchema: {
      missionId: z.string().min(1).describe('Mission ID from mission_search, or the mission name.'),
      stepId: z.string().optional().describe('Step ID from the `mission` tool. Omit for all steps.')
    },
    // Starting a not yet started mission is a write to the user's SAP account
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  async ({ missionId, stepId }) => {
    try {
      const id = await client.resolveMissionId(missionId);
      const steps = await withAuthRetry(cookie => client.stepContents(id, stepId, cookie));
      return {
        content: [{ type: 'text', text: `Fetched ${steps.length} step(s) of mission ${id}.` }],
        structuredContent: { missionId: id, steps }
      };
    } catch (error) {
      return errorResult('Mission step fetch failed', error);
    }
  }
);

async function main(): Promise<void> {
  if (process.env.AUTH_LOGIN_ONLY === 'true') {
    await authenticator.ensureSession();
    logger.warn('SAP Discovery Center authentication is valid.');
    await authenticator.destroy();
    return;
  }

  await server.connect(new StdioServerTransport());
  logger.warn('SAP Discovery Center MCP Server ready on stdio');
}

async function shutdown(): Promise<void> {
  await server.close();
  await authenticator.destroy();
  process.exit(0);
}

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  return !!invoked && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(invoked));
}

if (isDirectRun()) {
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  main().catch(error => {
    logger.error('Failed to start SAP Discovery Center MCP Server', error);
    process.exit(1);
  });
}
