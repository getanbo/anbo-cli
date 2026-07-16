import manifest from "../runtime-manifest.json" with { type: "json" };

export type CertifiedMiniStackPlatform = "linux/amd64" | "linux/arm64";

export interface CertifiedMiniStackCompatibility {
  id: string;
  environment: Readonly<Record<string, string>>;
  certification: string;
}

if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) {
  throw new Error("runtime-manifest.json must pin an immutable sha256 digest");
}
if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0 ||
    manifest.platforms.some((platform) => !/^linux\/(?:amd64|arm64)$/.test(platform)) ||
    new Set(manifest.platforms).size !== manifest.platforms.length) {
  throw new Error("runtime-manifest.json must declare unique supported certified platforms");
}
const arm64Compatibility = manifest.compatibility["linux/arm64"];
if (arm64Compatibility.id !== "openssl-armcap-zero-v1" ||
    arm64Compatibility.environment.OPENSSL_armcap !== "0" ||
    arm64Compatibility.certification !== "native-full-ed25519-asyncssh-kms-v1") {
  throw new Error("runtime-manifest.json must declare the certified ARM64 compatibility recipe");
}

export const CERTIFIED_MINISTACK_VERSION = manifest.upstream.version;
export const CERTIFIED_MINISTACK_IMAGE = manifest.certified_image;
export const CERTIFIED_MINISTACK_DIGEST = manifest.digest as `sha256:${string}`;
export const CERTIFIED_MINISTACK_PLATFORMS = Object.freeze(
  [...manifest.platforms] as CertifiedMiniStackPlatform[],
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
export const CERTIFIED_MINISTACK_SOURCE = manifest.source;
