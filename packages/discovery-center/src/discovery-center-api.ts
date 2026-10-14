import { defaultLogger as logger } from '@marianfoo/sap-mcp-auth';
import TurndownService from 'turndown';
import { PACKAGE_VERSION } from './version.js';
import type {
  MissionDetail,
  MissionSearchResult,
  MissionStepContent,
  RawActiveMission,
  RawCardContent,
  RawCurrentUser,
  RawMissionCard,
  RawMissionPageContent,
  RawMissionSearchItem,
  RawProductGroup,
  RawStartedMission
} from './types.js';

export const DISCOVERY_CENTER_URL = 'https://discovery-center.cloud.sap';
const API_URL = `${DISCOVERY_CENTER_URL}/platformx/api/v1`;
// The approuter forwards the login session only on its /protected route; /platformx answers 401 to every cookie.
export const PROTECTED_API_URL = `${DISCOVERY_CENTER_URL}/protected/platformx/api/v1`;
const USER_AGENT = `sap-discovery-center-mcp/${PACKAGE_VERSION}`;
const HTML_TAG = /<(p|div|br|ul|ol|li|h[1-6]|a|img|table|pre|code|strong|em|span)\b/i;
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });

export class SapDiscoveryCenterClient {
  async searchMissions(query: string, top: number): Promise<MissionSearchResult[]> {
    const [raw, productNames] = await Promise.all([this.fetchMissionSearch(query), this.fetchProductNames()]);

    return raw.slice(0, top).map(mission => ({
      id: mission.Id,
      name: mission.Name,
      type: mission.Type,
      partnerCompany: mission.PartnerCompany,
      description: mission.UCLongDescription ?? '',
      products: splitList(mission.Product, ',').map(id => productNames.get(id) ?? id),
      featured: mission.UCRibbonText === 'featured',
      url: missionUrl(mission.Id)
    }));
  }

  async missionDetail(missionIdOrName: string): Promise<MissionDetail> {
    const missionId = await this.resolveMissionId(missionIdOrName);
    const content = await this.getJson<RawMissionPageContent | null>(`/mission-masters/${missionId}/page-content`);

    // Unknown mission IDs return HTTP 200 with an empty body here, but HTTP 500 from /cards
    if (!content?.metadata?.Id) {
      throw new Error(`Mission not found: ${missionIdOrName}`);
    }

    const cards = await this.getJson<RawMissionCard[]>(`/mission-masters/${missionId}/cards`);
    const { metadata } = content;
    const useCase = content.UseCases?.[0];

    return {
      id: metadata.Id,
      name: metadata.Name,
      type: metadata.ApplicationType,
      status: metadata.Status,
      partnerCompany: metadata.PartnerCompany,
      description: metadata.Description,
      challenge: useCase?.ChallengeString ?? '',
      solution: useCase?.HowToSolveString ?? '',
      benefits: useCase?.BenefitString ?? '',
      useCaseId: useCase?.id ?? null,
      prerequisites: splitList(metadata.Prerequisites, '\n'),
      searchTags: splitList(metadata.SearchTags, ','),
      lastModified: metadata.LastModified,
      url: missionUrl(metadata.Id),
      communityLink: metadata.CommunityLink || null,
      services: (content.AppMaterials ?? []).map(material => ({
        name: material.Name,
        category: material.Category,
        optional: material.Optional,
        link: material.Link
      })),
      steps: (cards ?? []).map(card => ({
        id: String(card.id),
        phase: phaseName(card.listName),
        name: card.name,
        labels: (card.labelList ?? []).map(label => label.labelText)
      }))
    };
  }

  /**
   * Fetch the content of one step, or of every step when stepId is omitted. Requires an SAP session cookie.
   *
   * Step texts exist only on a started mission, so a mission the user has not started yet is started and left
   * open. Discovery Center refuses to cancel it, and completing it would count as a completed mission.
   */
  async stepContents(missionId: number, stepId: string | undefined, cookie: string): Promise<MissionStepContent[]> {
    const mission = await this.missionDetail(String(missionId));
    const steps = stepId ? mission.steps.filter(step => step.id === stepId) : mission.steps;
    if (steps.length === 0) {
      throw new Error(`Mission ${missionId} has no step ${stepId}. Use the mission tool to list its steps.`);
    }

    const active = await this.getJson<RawActiveMission[]>('/missions/mine/active', cookie);
    const startedByUser = (active ?? []).find(started => started.AppId === missionId);
    const instanceId = startedByUser?.Id ?? (await this.startMission(missionId, mission.useCaseId, cookie));

    // A started mission gets its own step IDs, so its steps are matched to the catalog by phase and name.
    const cards = await this.getJson<RawMissionCard[]>(`/cards?missionId=${instanceId}`, cookie);
    const contents: MissionStepContent[] = [];
    for (const step of steps) {
      const card = (cards ?? []).find(
        candidate => phaseName(candidate.listName) === step.phase && candidate.name === step.name
      );
      if (!card) {
        throw new Error(`Step "${step.name}" is missing from started mission ${instanceId}`);
      }
      const raw = await this.getJson<RawCardContent[]>(`/cards/${card.id}/content?missionId=${instanceId}`, cookie);
      const content = raw?.[0];
      const source = content?.cardTypeRefEntity || null;
      const markdown = source && content?.cardType === 'GitHub'
        ? await fetchGitHubMarkdown(source)
        : stepTextToMarkdown(unwrapContent(content?.cardContent ?? ''));
      contents.push({
        id: step.id,
        phase: step.phase,
        name: step.name,
        content: markdown,
        type: content?.cardType || null,
        source,
        relatedMissions: relatedMissionIds(markdown, missionId)
      });
    }
    return contents;
  }

  private async startMission(missionId: number, useCaseId: number | null, cookie: string): Promise<number> {
    const user = await this.getJson<RawCurrentUser | null>('/users/current', cookie);
    if (!user?.username) {
      throw new Error('SAP Discovery Center returned no current user');
    }
    const params = new URLSearchParams({ username: user.username, appID: String(missionId) });
    if (useCaseId) params.set('usecaseID', String(useCaseId));

    const started = await this.postJson<RawStartedMission | null>(`/missions?${params}`, cookie);
    if (!started?.missionId) {
      throw new Error(`SAP Discovery Center did not start mission ${missionId}; it may be invite-only`);
    }
    logger.warn(`Started mission ${missionId} as ${started.missionId} to read its steps`);
    return started.missionId;
  }

  /** The current-user call returns 401 without a valid Discovery Center session. */
  async validateSession(cookie: string): Promise<boolean> {
    const response = await fetch(`${PROTECTED_API_URL}/users/current`, { headers: this.headers(cookie) });
    return response.ok;
  }

  async resolveMissionId(missionIdOrName: string): Promise<number> {
    const trimmed = missionIdOrName.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);

    const raw = await this.fetchMissionSearch(trimmed);
    if (raw.length === 0) {
      throw new Error(`No mission found matching "${trimmed}". Use mission_search to find the mission ID.`);
    }

    const lower = trimmed.toLowerCase();
    return (raw.find(mission => mission.Name.toLowerCase() === lower) ?? raw[0]).Id;
  }

  // The search endpoint ignores top/skip, so the full result list is fetched and trimmed client-side.
  private async fetchMissionSearch(query: string): Promise<RawMissionSearchItem[]> {
    const params = new URLSearchParams({ searchString: query, filterType: 'mission-catalog-search', top: '1000' });
    const raw = await this.getJson<RawMissionSearchItem[]>(`/discovery/fuzzy-search?${params}`);

    if (!Array.isArray(raw) || raw.some(mission => typeof mission?.Id !== 'number' || !mission.Name)) {
      throw new Error('SAP Discovery Center returned an invalid mission search response');
    }
    return raw;
  }

  /** Map product and product group IDs used in mission search results to their names. */
  private async fetchProductNames(): Promise<Map<string, string>> {
    const raw = await this.getJson<{ products: RawProductGroup[] } | null>('/mission-masters/product-categories?version=1');

    const names = new Map<string, string>();
    for (const group of raw?.products ?? []) {
      names.set(group.id, group.name);
      for (const product of group.products ?? []) {
        names.set(product.id, product.name);
      }
    }
    return names;
  }

  private async getJson<T>(path: string, cookie?: string): Promise<T> {
    const response = await fetch(`${cookie ? PROTECTED_API_URL : API_URL}${path}`, { headers: this.headers(cookie) });
    return this.parseResponse<T>(response, path);
  }

  // The approuter rejects writes without a CSRF token, which it hands out on a GET asking for one.
  private async postJson<T>(path: string, cookie: string): Promise<T> {
    const tokenResponse = await fetch(`${PROTECTED_API_URL}/users/current`, {
      headers: { ...this.headers(cookie), 'x-csrf-token': 'fetch' }
    });
    const token = tokenResponse.headers.get('x-csrf-token');
    if (!token) {
      throw new Error(`SAP Discovery Center returned no CSRF token (HTTP ${tokenResponse.status})`);
    }
    const response = await fetch(`${PROTECTED_API_URL}${path}`, {
      method: 'POST',
      headers: { ...this.headers(cookie), 'x-csrf-token': token }
    });
    return this.parseResponse<T>(response, path);
  }

  private async parseResponse<T>(response: Response, path: string): Promise<T> {
    const text = await response.text();

    if (response.status === 401) {
      throw new Error(`SESSION_EXPIRED: SAP Discovery Center returned 401 for ${path}`);
    }
    if (!response.ok) {
      throw new Error(`SAP Discovery Center API returned ${response.status} for ${path}: ${text.slice(0, 300)}`);
    }
    if (!text.trim()) {
      return null as T;
    }
    return JSON.parse(text) as T;
  }

  private headers(cookie?: string): Record<string, string> {
    return {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT,
      ...(cookie ? { cookie, referer: `${DISCOVERY_CENTER_URL}/protected/index.html` } : {})
    };
  }
}

function missionUrl(id: number): string {
  return `${DISCOVERY_CENTER_URL}/missiondetail/${id}/`;
}

function splitList(value: string | null | undefined, separator: string): string[] {
  return (value ?? '')
    .split(separator)
    .map(item => item.trim())
    .filter(Boolean);
}

// GitHub steps only link a file; the UI renders its markdown, so read the raw file behind the blob URL.
// The link is set by the mission author, so anything but a github.com blob URL is returned as is, never fetched.
async function fetchGitHubMarkdown(blobUrl: string): Promise<string> {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(blobUrl);
  if (!match) return blobUrl;
  const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
  const response = await fetch(rawUrl, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${rawUrl}`);
  }
  // Authors break lines with <br> inside the markdown; images resolve against the raw file, links against the blob page.
  const markdown = (await response.text()).replace(/<br\s*\/?>/gi, '\n');
  return absoluteUrls(markdown, blobUrl, rawUrl);
}

// Steps written in Discovery Center's own editor are HTML, with links and images relative to the site.
function stepTextToMarkdown(text: string): string {
  if (!HTML_TAG.test(text)) return text;
  return absoluteUrls(turndown.turndown(text), DISCOVERY_CENTER_URL, DISCOVERY_CENTER_URL);
}

// Makes inline markdown images and links, <img src> and <a href> absolute; reference-style link definitions stay
// as written. Code spans and fenced blocks are left untouched.
function absoluteUrls(markdown: string, linkBase: string, imageBase: string): string {
  const resolve = (url: string, base: string) => (/^([a-z][a-z0-9+.-]*:|#)/i.test(url) ? url : new URL(url, base).href);
  // Images first: in a linked image "[![alt](img.png)](page.md)" the second pass then only sees relative link targets.
  const target = (base: string) => (_: string, prefix: string, bracketed: string | undefined, plain: string | undefined) =>
    `${prefix}${bracketed ? `<${resolve(bracketed, base)}>` : resolve(plain ?? '', base)}`;
  const resolveProse = (prose: string) => prose
    .replace(/(!\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^)\s]+))/g, target(imageBase))
    .replace(/(\]\(\s*)(?:<([^>]+)>|([^)\s]+))/g, target(linkBase))
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)/gi, (_, prefix: string, url: string) => prefix + resolve(url, imageBase))
    .replace(/(<a\b[^>]*\bhref=["'])([^"']+)/gi, (_, prefix: string, url: string) => prefix + resolve(url, linkBase));
  // split with a capture group keeps the code parts at the odd indices
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 ? part : resolveProse(part)))
    .join('');
}

// Steps often hand over to other missions, linked as /missiondetail/<mission>/<use case>/.
function relatedMissionIds(markdown: string, missionId: number): number[] {
  const ids = [...markdown.matchAll(/discovery-center\.cloud\.sap\/(?:protected\/index\.html#\/)?missiondetail\/(\d+)/g)]
    .map(match => Number(match[1]))
    .filter(id => id !== missionId);
  return [...new Set(ids)];
}

// The catalog spells phases inconsistently ("Discover", "SET UP"); title case makes them comparable.
function phaseName(listName: string): string {
  return listName.trim().toLowerCase().replace(/(^|\s)\S/g, start => start.toUpperCase());
}

// Steps copied from SAP's step repository store their text as JSON {"content": "..."}.
function unwrapContent(value: string): string {
  if (!value.trimStart().startsWith('{')) return value;
  try {
    const parsed = JSON.parse(value) as { content?: string };
    return parsed.content ?? value;
  } catch {
    return value;
  }
}
