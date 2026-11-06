import { useState, type ReactNode } from 'react';
import { Bell, BellOff, Monitor, Moon, Rows3, Rows4, Sun } from 'lucide-react';
import type { Density, Theme } from '@shared/api';
import { Button } from '../../components/Button';
import { PageTitle, Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/api';
import { useMeData, useUpdateMe } from '../../lib/queries/me';

function Choice<T extends string>({ name, value, current, onChange, icon, label }: { name: string; value: T; current: T; onChange: (v: T) => void; icon: ReactNode; label: string }) {
  const checked = value === current;
  return (
    <label
      className={cn(
        'flex h-16 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border text-[13px] transition-colors duration-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring [&_svg]:size-4 [&_svg]:stroke-[1.75]',
        checked ? 'border-primary text-fg shadow-[inset_0_0_0_1px_var(--c-primary)]' : 'border-border text-muted hover:bg-hover hover:text-fg',
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="sr-only" />
      {icon}
      <span className="font-medium">{label}</span>
    </label>
  );
}

export function AppearanceSettings() {
  const { user } = useMeData();
  const update = useUpdateMe();
  const { toast } = useToast();
  const onError = (e: unknown) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) });
  const setTheme = (theme: Theme) => update.mutate({ theme }, { onError });
  const setDensity = (density: Density) => update.mutate({ density }, { onError });

  return (
    <>
      <PageTitle title="Appearance" description="Saved to your account, so it follows you across devices." />
      <Section title="Theme">
        <fieldset className="grid grid-cols-3 gap-3">
          <legend className="sr-only">Theme</legend>
          <Choice name="theme" value="system" current={user.theme} onChange={setTheme} icon={<Monitor size={20} />} label="System" />
          <Choice name="theme" value="light" current={user.theme} onChange={setTheme} icon={<Sun size={20} />} label="Light" />
          <Choice name="theme" value="dark" current={user.theme} onChange={setTheme} icon={<Moon size={20} />} label="Dark" />
        </fieldset>
      </Section>
      <Section title="Density" description="Compact fits more conversations on screen and hides snippets.">
        <fieldset className="grid grid-cols-2 gap-3 sm:max-w-md">
          <legend className="sr-only">Density</legend>
          <Choice name="density" value="comfortable" current={user.density} onChange={setDensity} icon={<Rows3 size={20} />} label="Comfortable" />
          <Choice name="density" value="compact" current={user.density} onChange={setDensity} icon={<Rows4 size={20} />} label="Compact" />
        </fieldset>
      </Section>
      <NotificationsSection />
    </>
  );
}

function NotificationsSection() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  const ask = async () => {
    const p = await Notification.requestPermission();
    setPermission(p);
    if (p === 'granted') new Notification('Notifications are on', { body: 'Cirrus Mail will tell you about new mail while this tab is open.', icon: '/icons/icon-192.png' });
  };
  return (
    <Section title="Desktop notifications" description="Get a notification for new mail while Cirrus Mail is open in a tab but not in focus.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px]">
          {permission === 'granted' ? <Bell size={16} className="text-success" /> : <BellOff size={16} className="text-faint" />}
          {permission === 'granted' && 'Notifications are on for this browser.'}
          {permission === 'denied' && 'Blocked. Allow notifications for this site in your browser settings.'}
          {permission === 'default' && 'Not enabled yet.'}
          {permission === 'unsupported' && 'This browser does not support notifications.'}
        </p>
        {permission === 'default' && <Button variant="primary" onClick={() => void ask()}>Enable notifications</Button>}
      </div>
    </Section>
  );
}
