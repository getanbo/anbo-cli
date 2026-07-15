import manifest from "../runtime-manifest.json" with { type: "json" };

if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) {
  throw new Error("runtime-manifest.json must pin an immutable sha256 digest");
}

export const CERTIFIED_MINISTACK_VERSION = manifest.upstream.version;
export const CERTIFIED_MINISTACK_IMAGE = manifest.certified_image;
export const CERTIFIED_MINISTACK_DIGEST = manifest.digest as `sha256:${string}`;
export const CERTIFIED_MINISTACK_SOURCE = manifest.source;
