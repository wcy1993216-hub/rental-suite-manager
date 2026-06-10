import type { Profile } from "@/lib/types";

const PROFILE_CACHE_PREFIX = "rental-profile";
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ProfileCachePayload {
  savedAt: number;
  profile: Profile;
}

export function readCachedProfile(userId: string) {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(`${PROFILE_CACHE_PREFIX}:${userId}`);
    if (!raw) return null;
    const payload = JSON.parse(raw) as ProfileCachePayload;
    if (Date.now() - payload.savedAt > PROFILE_CACHE_TTL_MS) return null;
    if (payload.profile.user_id !== userId) return null;
    return payload.profile;
  } catch {
    return null;
  }
}

export function writeCachedProfile(profile: Profile) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(
      `${PROFILE_CACHE_PREFIX}:${profile.user_id}`,
      JSON.stringify({
        savedAt: Date.now(),
        profile
      } satisfies ProfileCachePayload)
    );
  } catch {
    // Cache failure should never block login.
  }
}
