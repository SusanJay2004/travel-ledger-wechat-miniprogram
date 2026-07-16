export interface ConnectivitySnapshot {
  offline: boolean;
  notice: string;
}

export async function getConnectivitySnapshot(): Promise<ConnectivitySnapshot> {
  try {
    const { networkType } = await wx.getNetworkType();
    if (networkType === 'none') {
      return { offline: true, notice: '当前无网络，仅可查看本机缓存。' };
    }
    if (networkType === '2g' || networkType === '3g') {
      return { offline: false, notice: '当前网络较慢，共享修改可能需要更久才能同步。' };
    }
  } catch {
    // A network probe may be unavailable on older clients; the API result remains authoritative.
  }
  return { offline: false, notice: '' };
}
