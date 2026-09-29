export {};

import type { ActorAuthSource, AgentApiKeyScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        source?: ActorAuthSource;
      };
    }
  }
}
