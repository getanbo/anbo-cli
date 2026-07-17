import manifest from "../runtime-manifest.json" with { type: "json" };

export type CertifiedMiniStackPlatform = "linux/amd64" | "linux/arm64";
const UPSTREAM_SOURCE = "ministackorg/ministack";
const DOWNSTREAM_SOURCE = "getanbo/anbo-ministack";
const DOWNSTREAM_IMAGE = "ghcr.io/getanbo/anbo-ministack";

export interface CertifiedMiniStackCompatibility {
  id: string;
  environment: Readonly<Record<string, string>>;
  certification: string;
}

export interface CertifiedMiniStackInstanceIsolation {
  contractVersion: 1;
  environment: "MINISTACK_INSTANCE_ID";
  healthField: "instance_isolation";
  readonly [key: string]: unknown;
}

interface RuntimeManifest {
  source: string;
  digest: string;
  certified_image: string;
  platforms: string[];
  compatibility: Record<string, CertifiedMiniStackCompatibility>;
  upstream: { repository: string; version: string; commit: string };
  downstream?: { version: string; commit: string };
  instance_isolation?: CertifiedMiniStackInstanceIsolation;
}

const runtimeManifest = manifest as RuntimeManifest;
const isPromotedAnboRuntime = runtimeManifest.source === DOWNSTREAM_SOURCE;

if (!/^sha256:[a-f0-9]{64}$/.test(runtimeManifest.digest)) {
  throw new Error("runtime-manifest.json must pin an immutable sha256 digest");
}
if (!Array.isArray(runtimeManifest.platforms) || runtimeManifest.platforms.length === 0 ||
    runtimeManifest.platforms.some((platform) => !/^linux\/(?:amd64|arm64)$/.test(platform)) ||
    new Set(runtimeManifest.platforms).size !== runtimeManifest.platforms.length) {
  throw new Error("runtime-manifest.json must declare unique supported certified platforms");
}
const arm64Compatibility = runtimeManifest.compatibility["linux/arm64"];
if (arm64Compatibility === undefined ||
    arm64Compatibility.id !== "openssl-armcap-zero-v1" ||
    arm64Compatibility.environment.OPENSSL_armcap !== "0" ||
    arm64Compatibility.certification !== "native-full-ed25519-asyncssh-kms-v1") {
  throw new Error("runtime-manifest.json must declare the certified ARM64 compatibility recipe");
}
if (isPromotedAnboRuntime) {
  if (runtimeManifest.certified_image !== `${DOWNSTREAM_IMAGE}@${runtimeManifest.digest}` ||
      runtimeManifest.upstream.repository !== UPSTREAM_SOURCE ||
      !/^[a-f0-9]{40}$/.test(runtimeManifest.upstream.commit) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runtimeManifest.upstream.version) ||
      !/^[a-f0-9]{40}$/.test(runtimeManifest.downstream?.commit ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runtimeManifest.downstream?.version ?? "") ||
      runtimeManifest.instance_isolation?.contractVersion !== 1 ||
      runtimeManifest.instance_isolation.environment !== "MINISTACK_INSTANCE_ID" ||
      runtimeManifest.instance_isolation.healthField !== "instance_isolation") {
    throw new Error("promoted runtime-manifest.json must preserve verified Anbo release provenance and instance isolation");
  }
} else if (runtimeManifest.source !== UPSTREAM_SOURCE ||
           runtimeManifest.certified_image !== `${UPSTREAM_SOURCE}@${runtimeManifest.digest}` ||
           runtimeManifest.downstream !== undefined ||
           runtimeManifest.instance_isolation !== undefined) {
  // Temporary compatibility for the committed upstream runtime pin. Remove
  // this branch once the first Anbo MiniStack release has been promoted.
  throw new Error("runtime-manifest.json must be the current upstream pin or a promoted Anbo runtime");
}

export const CERTIFIED_MINISTACK_VERSION = runtimeManifest.upstream.version;
export const CERTIFIED_MINISTACK_IMAGE = runtimeManifest.certified_image;
export const CERTIFIED_MINISTACK_DIGEST = runtimeManifest.digest as `sha256:${string}`;
export const CERTIFIED_MINISTACK_PLATFORMS = Object.freeze(
  [...runtimeManifest.platforms] as CertifiedMiniStackPlatform[],
);
export const CERTIFIED_MINISTACK_COMPATIBILITY: Readonly<Partial<
  Record<CertifiedMiniStackPlatform, CertifiedMiniStackCompatibility>
>> = Object.freeze({
  "linux/arm64": Object.freeze({
    id: arm64Compatibility.id,
    environment: Object.freeze({ ...arm64Compatibility.environment }),
    certification: arm64Compatibility.certification,
  }),
});
export const CERTIFIED_MINISTACK_SOURCE = runtimeManifest.source;
export const CERTIFIED_MINISTACK_DOWNSTREAM = isPromotedAnboRuntime
  ? Object.freeze({ ...runtimeManifest.downstream! })
  : undefined;
export const CERTIFIED_MINISTACK_INSTANCE_ISOLATION = isPromotedAnboRuntime
  ? Object.freeze({ ...runtimeManifest.instance_isolation! })
  : undefined;
