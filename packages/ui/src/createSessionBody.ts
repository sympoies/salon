import type { AgentKind } from "./frames.ts";
import { isProviderResumeAgent, parseProviderResumeInput } from "./providerResume.ts";
import { launchProfileOwnsAccount, sessionAccountProvider } from "./sessionAccounts.ts";
import type { CreateBody } from "./types.ts";
import { cwdForCreate, type WorkdirSelection } from "./workdirPicker.ts";

export type CreateSessionMode = "new" | "resume";

export interface CreateSessionBodyInput {
  readonly mode: CreateSessionMode;
  readonly agent: AgentKind;
  readonly agentProfile?: string;
  readonly title: string;
  readonly workdirSelection: WorkdirSelection;
  readonly prompt: string;
  readonly providerResumeId: string;
  /** The account chosen for the agent's provider; empty for the provider default. */
  readonly account: string;
}

export function createSessionBody(input: CreateSessionBodyInput): CreateBody | null {
  const body: CreateBody = { agent: input.agent };
  if (input.agentProfile) {
    Object.assign(body, { agent_profile: input.agentProfile });
  }
  const title = input.title.trim();
  if (title) {
    Object.assign(body, { title });
  }

  if (input.mode === "resume") {
    if (!isProviderResumeAgent(input.agent)) {
      return null;
    }
    const providerResumeId = parseProviderResumeInput(input.providerResumeId).id;
    if (!providerResumeId) {
      return null;
    }
    Object.assign(body, { provider_resume_id: providerResumeId });
    return body;
  }

  const selectedCwd = cwdForCreate(input.workdirSelection);
  if (selectedCwd) {
    Object.assign(body, { cwd: selectedCwd });
  }
  if (input.prompt.trim()) {
    Object.assign(body, { prompt: input.prompt });
  }
  const provider = sessionAccountProvider(input.agent);
  if (provider && input.account && !(input.agentProfile && launchProfileOwnsAccount(provider))) {
    Object.assign(body, { [`${provider}_account`]: input.account });
  }
  return body;
}
