export {};

import type { AgentRequest, CoordinatorState, OpenProject, SkillCatalog } from "./model";

declare global {
  interface Window {
    milagre: {
      listSkills: (projectPath: string) => Promise<SkillCatalog>;
      getCurrentProject: () => Promise<OpenProject>;
      openProject: () => Promise<OpenProject | null>;
      saveProject: (projectPath: string, state: CoordinatorState) => Promise<void>;
      sendToAgent: (request: AgentRequest) => Promise<string>;
      cancelAgent: () => Promise<boolean>;
    };
  }
}
