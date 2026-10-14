// Shapes of the SAP Discovery Center REST API used by its UI under /platformx/api/v1.
// Mission catalog calls need no login; step contents need an SAP session cookie.

export interface MissionSearchResult {
  id: number;
  name: string;
  type: string;
  partnerCompany: string;
  description: string;
  products: string[];
  featured: boolean;
  url: string;
}

export interface MissionService {
  name: string;
  category: string;
  optional: boolean;
  link: string;
}

export interface MissionStep {
  id: string;
  phase: string;
  name: string;
  labels: string[];
}

export interface MissionDetail {
  id: number;
  name: string;
  type: string;
  status: string;
  partnerCompany: string;
  description: string;
  challenge: string;
  solution: string;
  benefits: string;
  /** Use case a started mission is bound to. */
  useCaseId: number | null;
  prerequisites: string[];
  searchTags: string[];
  lastModified: string;
  url: string;
  communityLink: string | null;
  services: MissionService[];
  steps: MissionStep[];
}

export interface MissionStepContent {
  id: string;
  phase: string;
  name: string;
  /** Step text as markdown with absolute link and image URLs. A linked step of another kind holds its URL. */
  content: string;
  /** Step kind as set by the mission author, e.g. "GitHub"; null for text written in Discovery Center. */
  type: string | null;
  /** Source a linked step renders from, e.g. a GitHub file or a developers.sap.com tutorial. */
  source: string | null;
  /** IDs of other missions the step links to, e.g. the per-application follow-up missions. */
  relatedMissions: number[];
}

// Mission search item. Product holds comma-separated product and product group IDs.
export interface RawMissionSearchItem {
  Id: number;
  Name: string;
  Type: string;
  PartnerCompany: string;
  Product?: string;
  UCLongDescription?: string;
  UCRibbonText?: string | null;
}

export interface RawProductGroup {
  id: string;
  name: string;
  products: { id: string; name: string }[];
}

export interface RawMissionPageContent {
  metadata: {
    Id: number;
    Name: string;
    Description: string;
    ApplicationType: string;
    Status: string;
    PartnerCompany: string;
    Prerequisites: string | null;
    SearchTags: string | null;
    LastModified: string;
    CommunityLink: string | null;
  };
  UseCases: {
    id: number;
    ChallengeString: string | null;
    HowToSolveString: string | null;
    BenefitString: string | null;
  }[];
  AppMaterials: {
    Name: string;
    Category: string;
    Optional: boolean;
    Link: string;
  }[];
}

export interface RawMissionCard {
  id: number | string;
  name: string;
  listName: string;
  labelList: { labelText: string }[] | null;
}

export interface RawCurrentUser {
  /** SAP user ID, e.g. an S-user. */
  username: string;
}

// A mission the user has started. AppId is the catalog mission ID.
export interface RawActiveMission {
  Id: number;
  AppId: number;
}

export interface RawStartedMission {
  missionId: number;
  appId: number;
}

export interface RawCardContent {
  id: number | string;
  name: string;
  listName: string;
  cardType: string | null;
  cardTypeRefEntity: string | null;
  cardContent: string | null;
}
