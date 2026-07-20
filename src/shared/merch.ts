export const defaultMerchStoreUrl = "https://gear.stakewars.ai";
export const stakeWarsOwnerUsername = "nathanielrakel@gmail.com";

export type MerchNavItem = {
  label: "Gear";
  url: string;
};

export const normalizeMerchStoreUrl = (value?: string | null) => {
  const candidate = value?.trim() || defaultMerchStoreUrl;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return defaultMerchStoreUrl;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return defaultMerchStoreUrl;
  }
};

export const isStakeWarsOwnerUsername = (username?: string | null) =>
  username?.trim().toLowerCase() === stakeWarsOwnerUsername;

export const merchNavItemForUser = (username?: string | null, merchStoreUrl?: string | null): MerchNavItem | null =>
  isStakeWarsOwnerUsername(username)
    ? { label: "Gear", url: normalizeMerchStoreUrl(merchStoreUrl) }
    : null;
