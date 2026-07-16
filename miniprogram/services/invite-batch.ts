export interface InviteCandidate {
  userId: string;
  displayName: string;
}

export interface InviteFailure<TCandidate extends InviteCandidate> {
  candidate: TCandidate;
  message: string;
}

export interface InviteBatchResult<TCandidate extends InviteCandidate> {
  succeeded: readonly TCandidate[];
  failed: readonly InviteFailure<TCandidate>[];
}

export async function inviteBatch<TCandidate extends InviteCandidate>(
  candidates: readonly TCandidate[],
  invite: (candidate: TCandidate) => Promise<void>,
): Promise<InviteBatchResult<TCandidate>> {
  const succeeded: TCandidate[] = [];
  const failed: InviteFailure<TCandidate>[] = [];
  for (const candidate of candidates) {
    try {
      await invite(candidate);
      succeeded.push(candidate);
    } catch (error: unknown) {
      failed.push({ candidate, message: toMessage(error) });
    }
  }
  return { succeeded, failed };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '邀请失败，请稍后重试。';
}
