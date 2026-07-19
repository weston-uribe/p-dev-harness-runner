import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface BrowserOpenResult {
  opened: boolean;
  warning?: string;
}

export function resolveBrowserCommand(url: string): {
  command: string;
  args: string[];
} {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

export async function openBrowserBestEffort(
  url: string,
  execFileImpl: typeof execFileAsync = execFileAsync,
): Promise<BrowserOpenResult> {
  const { command, args } = resolveBrowserCommand(url);
  try {
    await execFileImpl(command, args, { shell: false });
    return { opened: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      opened: false,
      warning: `Could not open browser (${message}). Open this URL manually: ${url}`,
    };
  }
}

export function createBestEffortBrowserOpener(
  execFileImpl: typeof execFileAsync = execFileAsync,
): BrowserOpener {
  return {
    async open(url: string): Promise<void> {
      const result = await openBrowserBestEffort(url, execFileImpl);
      if (!result.opened) {
        console.warn(result.warning);
      }
    },
  };
}

export const defaultBrowserOpener = createBestEffortBrowserOpener();
