import {
  buildDispatchMetadataFromEnv,
  DEFAULT_DISPATCH_METADATA_PATH,
  writeDispatchMetadata,
} from "./dispatch-metadata.js";

const payload = buildDispatchMetadataFromEnv(process.env);
writeDispatchMetadata(DEFAULT_DISPATCH_METADATA_PATH, payload);
