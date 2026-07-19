import { readFile } from "node:fs/promises";
import { parseFixtureMarkdown } from "../fixture/frontmatter.js";
import {
  teamKeyFromIssueIdentifier,
  type LinearIssueSnapshot,
} from "../linear/client.js";

export type { FixtureMetadata } from "../fixture/frontmatter.js";

export async function loadIssueFixture(
  fixturePath: string,
  issueKey: string,
): Promise<LinearIssueSnapshot> {
  const raw = await readFile(fixturePath, "utf8");
  const { metadata, body } = parseFixtureMarkdown(raw);

  return {
    id: `fixture-${issueKey}`,
    identifier: issueKey,
    title: metadata.title ?? `Fixture issue ${issueKey}`,
    description: body,
    status: metadata.status,
    projectId: null,
    projectName: metadata.projectName,
    teamName: metadata.teamName,
    teamKey: teamKeyFromIssueIdentifier(issueKey),
    teamId: null,
    url: null,
  };
}
