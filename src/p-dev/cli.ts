export const DEFAULT_CONFIGURE_ROUTE = "/";

export interface PDevCliOptions {
  host?: string;
  port?: number;
  workspace?: string;
  route: string;
  openBrowser: boolean;
}

export function parsePDevCliOptions(argv: string[]): PDevCliOptions {
  const options: PDevCliOptions = {
    route: DEFAULT_CONFIGURE_ROUTE,
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

    if (arg === "--workspace") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--workspace requires a path");
      }
      options.workspace = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      options.workspace = arg.slice("--workspace=".length);
      continue;
    }

    if (arg === "--route") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--route requires a path");
      }
      options.route = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--route=")) {
      options.route = arg.slice("--route=".length);
      continue;
    }

    if (arg === "--no-open") {
      options.openBrowser = false;
      continue;
    }
  }

  if (options.port !== undefined) {
    if (!Number.isFinite(options.port) || options.port <= 0 || options.port > 65535) {
      throw new Error("--port must be a valid TCP port between 1 and 65535");
    }
  }

  return options;
}
