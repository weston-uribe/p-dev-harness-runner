import { readPrivateRuntimeContext } from "../public-execution/private-runtime-context.js";
import {
  buildDispatchMetadataFromEnv,
  DEFAULT_DISPATCH_METADATA_PATH,
  writeDispatchMetadata,
} from "./dispatch-metadata.js";

const fromEnv = buildDispatchMetadataFromEnv(process.env);
const privateCtx = readPrivateRuntimeContext();
const payload = {
  ...fromEnv,
  ...(privateCtx.issueKey ? { issueKey: privateCtx.issueKey } : {}),
  ...(privateCtx.repoConfigId ? { repoConfigId: privateCtx.repoConfigId } : {}),
  ...(privateCtx.baseBranch ? { baseBranch: privateCtx.baseBranch } : {}),
  ...(privateCtx.mergeConcurrencyGroup
    ? { mergeConcurrencyGroup: privateCtx.mergeConcurrencyGroup }
    : {}),
};
writeDispatchMetadata(DEFAULT_DISPATCH_METADATA_PATH, payload);
