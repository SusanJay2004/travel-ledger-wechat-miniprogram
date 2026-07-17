import { callApi, type SessionProfile } from '../../services/api';
import { getSessionProfile } from '../../services/session';

interface CodeData {
  errorMessage: string;
  url: string;
  loading: boolean;
  profile: SessionProfile | null;
}

interface CodeMethods {
  handleCopyId(): void;
  loadCode(): Promise<void>;
}

Page<CodeData, CodeMethods>({
  data: { errorMessage: '', loading: true, profile: null, url: '' },

  onLoad() {
    void this.loadCode();
  },

  async loadCode() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const [profile, code] = await Promise.all([
        getSessionProfile(true),
        callApi<{ url: string }>('session.qrCode'),
      ]);
      this.setData({ loading: false, profile, url: code.url });
    } catch (error: unknown) {
      this.setData({ errorMessage: toMessage(error), loading: false });
    }
  },

  handleCopyId() {
    const publicId = this.data.profile?.publicId;
    if (publicId !== undefined) {
      void wx.setClipboardData({ data: publicId });
    }
  },
});

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '二维码生成失败，请稍后重试。';
}
