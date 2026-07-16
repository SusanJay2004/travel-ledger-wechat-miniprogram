import { callApi, type SessionProfile } from './api';

let cachedProfile: SessionProfile | null = null;
let pendingProfile: Promise<SessionProfile> | null = null;

export function getSessionProfile(forceRefresh = false): Promise<SessionProfile> {
  if (!forceRefresh && cachedProfile !== null) return Promise.resolve(cachedProfile);
  if (!forceRefresh && pendingProfile !== null) return pendingProfile;

  const request = callApi<SessionProfile>('session.bootstrap')
    .then((profile) => {
      cachedProfile = profile;
      return profile;
    })
    .finally(() => {
      if (pendingProfile === request) pendingProfile = null;
    });
  pendingProfile = request;
  return request;
}

export function updateCachedSessionProfile(profile: SessionProfile): void {
  cachedProfile = profile;
}

export function clearCachedSessionProfile(): void {
  cachedProfile = null;
  pendingProfile = null;
}
