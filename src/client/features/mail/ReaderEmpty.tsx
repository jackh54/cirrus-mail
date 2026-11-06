import { Kbd } from '../../components/Kbd';
import { MOD_KEY } from '../palette/events';

export function ReaderEmpty() {
  return (
    <div className="hidden flex-1 flex-col items-center justify-center bg-bg text-center md:flex">
      <p className="text-[13px] text-muted">No conversation selected</p>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-faint">
        <Kbd>J</Kbd><Kbd>K</Kbd> to move <span className="mx-1" /> <Kbd>O</Kbd> to open <span className="mx-1" /> <Kbd>{`${MOD_KEY}K`}</Kbd> for commands
      </p>
    </div>
  );
}
