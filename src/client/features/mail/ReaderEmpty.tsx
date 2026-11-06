import { LogoMark } from '../../components/Logo';
import { Kbd } from '../../components/Kbd';

export function ReaderEmpty() {
  return (
    <div className="hidden flex-1 flex-col items-center justify-center gap-4 bg-bg text-center md:flex">
      <LogoMark size={48} className="opacity-80" />
      <div>
        <p className="text-sm font-medium text-fg">Select a conversation</p>
        <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[13px] text-faint">
          Use <Kbd>j</Kbd> <Kbd>k</Kbd> to move, <Kbd>o</Kbd> to open, <Kbd>?</Kbd> for all shortcuts
        </p>
      </div>
    </div>
  );
}
