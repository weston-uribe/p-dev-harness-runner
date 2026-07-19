export interface SourceGuiCliOptions {
  host?: string;
  port?: number;
  openBrowser: boolean;
}

export function parseSourceGuiCliOptions(argv: string[]): SourceGuiCliOptions {
  const options: SourceGuiCliOptions = {
    openBrowser: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--port requires a number");
      }
      options.port = Number.parseInt(value, 10);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = Number.parseInt(arg.slice("--port=".length), 10);
      continue;
    }

    if (arg === "--host") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--host requires a value");
      }
      options.host = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }

    if (arg === "--route" || arg.startsWith("--route=")) {
      throw new Error(
        "p-dev no longer accepts --route. PDev chooses Configure or Workflow automatically from /.",
      );
    }
  }

  if (options.port !== undefined) {
    if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) {
      throw new Error("--port must be a valid TCP port between 1 and 65535");
    }
  }

  return options;
}
