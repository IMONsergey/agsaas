// Compatibility entry point. DB ingress and Storage workers share one contract.
export {
  InvalidStorageKeyError,
  requireVaultPathForTeam,
  requireVaultPrefixForTeam,
  validateStorageKey,
  validateVaultKey,
} from "@midday/utils/storage-path";
