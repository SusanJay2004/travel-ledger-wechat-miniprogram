import { callApi, type SessionProfile } from '../../services/api';
import { getSessionProfile } from '../../services/session';

interface CodeData {
  errorMessage: string;
  fileId: string;
  loading: boolean;
  profile: SessionProfile | null;
}

interface CodeMethods {
  handleCopyId(): void;
  loadCode(): Promise<void>;
}

Page<CodeData, CodeMethods>({
  data: { errorMessage: '', fileId: '', loading: true, profile: null },

  onLoad() {
    void this.loadCode();
  },

  async loadCode() {
    this.setData({ errorMessage: '', loading: true });
    try {
      const [profile, code] = await Promise.all([
        getSessionProfile(),
        callApi<{ fileId: string }>('session.qrCode'),
      ]);
      this.setData({ fileId: code.fileId, loading: false, profile });
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
