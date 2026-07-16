import { assertCents } from './money.js';
import type { Allocation, Cents, ParticipantShare } from './types.js';

interface RankedAllocation extends Allocation {
  remainder: number;
}

export function allocateByShares(
  amountCents: Cents,
  participants: readonly ParticipantShare[],
): readonly Allocation[] {
  assertCents(amountCents);
  if (participants.length === 0) throw new RangeError('At least one participant is required.');

  const totalShares = participants.reduce((sum, participant) => {
    if (!Number.isInteger(participant.shares) || participant.shares < 0) {
      throw new RangeError('Shares must be non-negative integers.');
    }
    return sum + participant.shares;
  }, 0);
  if (totalShares <= 0) throw new RangeError('Total shares must be positive.');

  const ranked: RankedAllocation[] = participants.map((participant) => {
    const numerator = amountCents * participant.shares;
    return {
      memberId: participant.memberId,
      amountCents: Math.floor(numerator / totalShares),
      remainder: numerator % totalShares,
    };
  });

  const allocated = ranked.reduce((sum, item) => sum + item.amountCents, 0);
  const remaining = amountCents - allocated;
  const remainderOrder = [...ranked].sort(
    (left, right) =>
      right.remainder - left.remainder || left.memberId.localeCompare(right.memberId),
  );
  for (let index = 0; index < remaining; index += 1) {
    const target = remainderOrder[index];
    if (target === undefined) throw new Error('Allocation remainder invariant failed.');
    target.amountCents += 1;
  }

  return ranked
    .map(({ memberId, amountCents }) => ({ memberId, amountCents }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
}
