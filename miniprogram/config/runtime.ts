export type ProductMode = 'solo' | 'collaboration';

// Release automation replaces this value with "collaboration" only after the platform gate passes.
const buildMode: string = 'solo';
const mode: ProductMode = buildMode === 'collaboration' ? 'collaboration' : 'solo';

export const runtimeConfig = Object.freeze({
  mode,
  collaborationEnabled: mode === 'collaboration',
  productName: '同行账本',
});
