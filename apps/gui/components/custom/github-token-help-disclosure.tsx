"use client";

import Image from "next/image";
import { FORM } from "@/lib/constants";
import {
  GITHUB_CLASSIC_PAT_SCOPES,
  GITHUB_PAT_SETTINGS_URL,
  GITHUB_TOKEN_HELP_DISCLOSURE_LABEL,
} from "@harness/setup/github-workflow-permissions";

const SCREENSHOTS = {
  generateNewToken: "/setup/github-token/github-pat-generate-new-token.png",
  generateClassic: "/setup/github-token/github-pat-generate-classic.png",
  verifyEmail: "/setup/github-token/github-pat-verify-email.png",
} as const;

function HelpScreenshot({
  src,
  alt,
}: {
  src: string;
  alt: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <Image
        src={src}
        alt={alt}
        width={640}
        height={360}
        className="h-auto w-full max-w-sm"
        sizes="(max-width: 640px) 100vw, 320px"
      />
    </div>
  );
}

export function GitHubTokenHelpDisclosure() {
  return (
    <details className="rounded-md border border-border/80 bg-muted/10 p-3">
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
        {GITHUB_TOKEN_HELP_DISCLOSURE_LABEL}
      </summary>
      <ol className="mt-3 list-decimal space-y-4 pl-5 text-sm text-muted-foreground">
        <li className="space-y-1">
          <p>
            Go to{" "}
            <a
              href={GITHUB_PAT_SETTINGS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2"
            >
              {GITHUB_PAT_SETTINGS_URL}
            </a>
            .
          </p>
          <p className={FORM.secretHint}>
            Open <strong className="font-medium text-foreground">Personal access tokens</strong>{" "}
            and choose the <strong className="font-medium text-foreground">Tokens (classic)</strong>{" "}
            tab if GitHub shows both classic and fine-grained options.
          </p>
        </li>
        <li className="space-y-2">
          <p>Click <strong className="font-medium text-foreground">Generate new token</strong>.</p>
          <HelpScreenshot
            src={SCREENSHOTS.generateNewToken}
            alt="GitHub Personal access tokens page with Generate new token button"
          />
        </li>
        <li className="space-y-2">
          <p>
            Choose{" "}
            <strong className="font-medium text-foreground">
              Generate new token (classic)
            </strong>
            .
          </p>
          <p className={FORM.secretHint}>
            Use classic for the guided happy path. Fine-grained tokens can work,
            but they require repo-specific permissions and are better for advanced
            setup.
          </p>
          <HelpScreenshot
            src={SCREENSHOTS.generateClassic}
            alt="GitHub dropdown showing Generate new token classic for general use"
          />
        </li>
        <li className="space-y-2">
          <p>
            If GitHub asks you to verify your email, complete that step before
            continuing.
          </p>
          <HelpScreenshot
            src={SCREENSHOTS.verifyEmail}
            alt="GitHub email verification prompt with Verify via email button"
          />
        </li>
        <li>
          Give the token a clear name, for example{" "}
          <strong className="font-medium text-foreground">
            Product Development Harness
          </strong>
          .
        </li>
        <li className="space-y-1">
          <p>Select these scopes:</p>
          <ul className="list-disc space-y-1 pl-5">
            {GITHUB_CLASSIC_PAT_SCOPES.map((scope) => (
              <li key={scope.id}>
                <strong className="font-medium text-foreground">{scope.id}</strong>
                {" — "}
                {scope.description}
              </li>
            ))}
          </ul>
        </li>
        <li>
          Click <strong className="font-medium text-foreground">Generate token</strong>{" "}
          at the bottom of the page.
        </li>
        <li className="space-y-1">
          <p>
            Copy the token immediately and store it somewhere safe. GitHub only
            shows it once.
          </p>
          <p className={FORM.secretHint}>
            Paste the copied token into the field above, then click Verify.
          </p>
        </li>
      </ol>
      <div className="mt-4 rounded-md border border-dashed border-border/80 bg-background/50 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Advanced option</p>
        <p className="mt-1">
          Fine-grained tokens can also work if they have access to each target
          repo and include Contents write plus Workflows write permissions. Use
          this only if you want repo-specific access control.
        </p>
      </div>
    </details>
  );
}
