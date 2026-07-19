import {
  AgentNotFoundError,
  AuthenticationError,
  CursorAgentError,
  NetworkError,
  RateLimitError,
} from "@cursor/sdk";
import type { BuilderThreadReplacementReason } from "../runner/builder-thread-types.js";

export function classifyBuilderResumeError(
  error: unknown,
): BuilderThreadReplacementReason | null {
  if (error instanceof AgentNotFoundError) {
    return "agent_not_found";
  }
  if (error instanceof AuthenticationError) {
    return null;
  }
  if (error instanceof NetworkError) {
    return null;
  }
  if (error instanceof RateLimitError) {
    return null;
  }
  if (error instanceof CursorAgentError) {
    if (error.code === "agent_not_found") {
      return "agent_not_found";
    }
    if (error.code === "agent_deleted") {
      return "agent_deleted";
    }
    if (error.code === "agent_inaccessible") {
      return "agent_inaccessible";
    }
    if (error.isRetryable) {
      return null;
    }
    return null;
  }
  return null;
}
