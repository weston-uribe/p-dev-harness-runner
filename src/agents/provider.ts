import { cursorAgentProvider } from "./cursor-provider.js";
import type { AgentProvider } from "./types.js";
import type { HarnessConfig } from "../config/types.js";

export function getAgentProvider(_config: HarnessConfig): AgentProvider {
  return cursorAgentProvider;
}
