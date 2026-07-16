Page({
  data: {
    tripId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ tripId: query['id'] ?? '' });
  },

  handleAddDate() {
    void wx.showToast({ icon: 'none', title: '日期与账单编辑正在建设' });
  },

  handleSettle() {
    void wx.showToast({ icon: 'none', title: '还没有可计算的账单' });
  },
});
