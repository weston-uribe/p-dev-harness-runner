import net from "node:net";

export interface GuiPortOptions {
  host?: string;
  port?: number;
  envPort?: string;
  maxAttempts?: number;
}

export interface GuiPortResolution {
  host: string;
  port: number;
  requestedPort: number;
}

export const DEFAULT_GUI_HOST = "localhost";
export const DEFAULT_GUI_PORT = 3000;

export function resolveRequestedGuiPort(options?: GuiPortOptions): number {
  if (options?.port !== undefined) {
    return options.port;
  }

  const envPort = options?.envPort ?? process.env.HARNESS_GUI_PORT;
  if (envPort?.trim()) {
    const parsed = Number.parseInt(envPort.trim(), 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return DEFAULT_GUI_PORT;
}

export function resolveGuiHost(options?: GuiPortOptions): string {
  const host = options?.host ?? process.env.HARNESS_GUI_HOST ?? DEFAULT_GUI_HOST;
  return host.trim() || DEFAULT_GUI_HOST;
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    server.listen({ host, port }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export async function resolveAvailableGuiPort(
  options?: GuiPortOptions,
): Promise<GuiPortResolution> {
  const host = resolveGuiHost(options);
  const requestedPort = resolveRequestedGuiPort(options);
  const maxAttempts = options?.maxAttempts ?? 50;

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = requestedPort + offset;
    if (candidate > 65535) {
      break;
    }

    if (await isPortAvailable(host, candidate)) {
      return { host, port: candidate, requestedPort };
    }
  }

  throw new Error(
    `No available GUI port found starting at ${requestedPort} on ${host}`,
  );
}
