export const PRODUCT_NAME = '同行账本';
export const DEFAULT_SIGNATURE = '这个人很懒，什么也没留下～';

export const LIMITS = {
  activeTripsPerUser: 100,
  billsPerTrip: 100,
  membersPerTrip: 20,
  publicIdLength: 10,
  billTitleCodePoints: 12,
  tripNameCodePoints: 20,
  usernameCodePoints: 16,
  signatureCodePoints: 60,
  maxBillAmountCents: 999_999_900,
  maxShare: 20,
} as const;

export const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type ProductMode = 'solo' | 'collaboration';
