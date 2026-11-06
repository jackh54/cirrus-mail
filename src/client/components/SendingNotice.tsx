import { SEND_WARN_RATIO } from '@shared/api';
import { cn } from '../lib/cn';
import { useSendingStatus } from '../lib/queries/sending';

/**
 * One quiet line about today's daily sending limit. Never blocks anything: the limit is whatever an admin
 * typed in. `limitOnly` hides the "getting close" warning and shows the notice only once the limit is used up.
 */
export function SendingNotice({ limitOnly, className }: { limitOnly?: boolean; className?: string }) {
  const { data } = useSendingStatus();
  if (!data?.dailyLimit) return null;
  const { dailyLimit, sentToday } = data;
  const used = sentToday >= dailyLimit;
  if (!used && (limitOnly || sentToday < SEND_WARN_RATIO * dailyLimit)) return null;
  return (
    <p
      role="status"
      className={cn(
        'text-[12px] leading-4',
        used ? 'rounded-md bg-warning-soft px-3 py-2 text-warning' : 'text-muted',
        className,
      )}
    >
      {used
        ? "Today's sending limit is used up, so sends may fail until 00:00 UTC. Scheduling for later still works."
        : `You've sent ${sentToday.toLocaleString()} of today's ${dailyLimit.toLocaleString()} emails.`}
    </p>
  );
}
