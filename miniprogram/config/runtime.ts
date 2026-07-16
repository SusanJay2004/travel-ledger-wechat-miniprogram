export type ProductMode = 'solo' | 'collaboration';

export const runtimeConfig = {
  mode: 'solo' as ProductMode,
  collaborationEnabled: false,
  productName: '同行账本',
};

export function configureRuntimeMode(mode: ProductMode): void {
  runtimeConfig.mode = mode;
  runtimeConfig.collaborationEnabled = mode === 'collaboration';
}
