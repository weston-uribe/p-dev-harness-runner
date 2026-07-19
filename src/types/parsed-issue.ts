export interface ProductFoundationFields {
  platformRuntime?: string;
  languageFramework?: string;
  repositoryStructure?: string;
  testingStrategy?: string;
  ciStrategy?: string;
}

export interface ParsedIssue {
  targetRepoRaw?: string;
  task: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  validationExpectations?: string;
  productFoundation?: ProductFoundationFields;
  parseErrors: string[];
}
