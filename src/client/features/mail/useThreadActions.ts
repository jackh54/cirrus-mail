import { useCallback } from 'react';
import type { Folder, ThreadAction } from '@shared/api';
import { useConfirm } from '../../components/Confirm';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { longDate, pluralize } from '../../lib/format';
import { useThreadAction } from '../../lib/queries/mail';

const DONE: Partial<Record<ThreadAction, string>> = {
  archive: 'Archived',
  trash: 'Moved to Trash',
  spam: 'Marked as spam',
  not_spam: 'Moved to Inbox',
  delete_forever: 'Deleted forever',
  unsnooze: 'Moved back to Inbox',
  mute: 'Conversation muted',
  unmute: 'Conversation unmuted',
};

const REVERSE: Partial<Record<ThreadAction, ThreadAction>> = { snooze: 'unsnooze', mute: 'unmute', unmute: 'mute' };

const UNDOABLE: ThreadAction[] = ['archive', 'trash', 'spam', 'move'];

/**
 * Runs a thread action (optimistic), confirms destructive ones, and offers Undo for moves
 * by moving the threads back to the folder being viewed.
 */
export function useThreadActions(mb: string, listKey: string | null, folders: Folder[] | undefined) {
  const mutation = useThreadAction(mb);
  const { toast } = useToast();
  const confirm = useConfirm();

  return useCallback(
    async (action: ThreadAction, threadIds: string[], folderId?: string, until?: number): Promise<boolean> => {
      if (!threadIds.length) return false;
      if (action === 'delete_forever') {
        const ok = await confirm({
          title: `Delete ${pluralize(threadIds.length, 'conversation')} forever?`,
          body: 'This cannot be undone. The messages and their attachments are removed from storage.',
          confirmLabel: 'Delete forever',
          danger: true,
        });
        if (!ok) return false;
      }
      const canUndo = UNDOABLE.includes(action) && !!listKey && listKey !== 'starred' && listKey !== 'snoozed' && listKey !== 'search';
      const reverse = REVERSE[action];
      const targetName = action === 'move' ? folders?.find((f) => f.id === folderId)?.name : undefined;
      mutation.mutate(
        { threadIds, action, folderId, until },
        {
          onSuccess: () => {
            const label = action === 'move' ? `Moved to ${targetName ?? 'folder'}` : action === 'snooze' ? `Snoozed until ${longDate(until ?? 0)}` : DONE[action];
            if (!label) return;
            toast({
              title: threadIds.length > 1 ? `${label} · ${pluralize(threadIds.length, 'conversation')}` : label,
              tone: action === 'delete_forever' ? 'neutral' : 'success',
              action: reverse
                ? { label: 'Undo', onClick: () => mutation.mutate({ threadIds, action: reverse }) }
                : canUndo && listKey
                  ? { label: 'Undo', onClick: () => mutation.mutate({ threadIds, action: 'move', folderId: listKey }) }
                  : undefined,
            });
          },
          onError: (e) => toast({ tone: 'error', title: "Couldn't update the conversation", description: errorMessage(e) }),
        },
      );
      return true;
    },
    [mutation, toast, confirm, listKey, folders],
  );
}
