import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Laptop, Share, Smartphone } from 'lucide-react';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Switch } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import {
  currentSubscription, disablePush, enablePush, fetchPublicKey, getThisDeviceId, isIos, notificationPermission,
  pushApi, pushSupport, setThisDeviceId,
} from '../../lib/push';
import { useMeData, useUpdateMe } from '../../lib/queries/me';
import { deviceLabel } from './SecuritySettings';

const qkDevices = ['push-devices'] as const;
const qkPublicKey = ['push-public-key'] as const;

export function NotificationsSettings() {
  const support = pushSupport();
  return (
    <>
      <PageTitle title="Notifications" description="Get a notification for new mail in your inboxes, even when Cirrus Mail is closed." />
      {support === 'ios-install' ? <IosInstallSection /> : support === 'unsupported' ? <InTabSection /> : <ThisDeviceSection />}
      <PreviewSection />
      <DevicesSection />
    </>
  );
}

function DeniedHelp() {
  return (
    <p role="alert" className="mt-4 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
      Notifications are blocked for this site.{' '}
      {isIos()
        ? 'On iPhone or iPad, open Settings → Notifications → Cirrus and turn on Allow Notifications, then come back here.'
        : `Allow notifications for ${location.host} in your browser's site settings (usually the icon next to the address bar), then reload this page.`}
    </p>
  );
}

function ThisDeviceSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [permission, setPermission] = useState(notificationPermission);
  const [hasSub, setHasSub] = useState<boolean | null>(null);
  const [deviceId, setDeviceId] = useState(getThisDeviceId);
  const devices = useQuery({ queryKey: qkDevices, queryFn: pushApi.devices });
  // Fetched ahead of the click, so subscribing right after the permission prompt needs no extra round trip.
  const publicKey = useQuery({ queryKey: qkPublicKey, queryFn: fetchPublicKey, staleTime: Infinity });

  useEffect(() => {
    let live = true;
    currentSubscription().then((s) => live && setHasSub(!!s), () => live && setHasSub(false));
    return () => {
      live = false;
    };
  }, []);

  // On only when this browser holds a subscription the server still lists (it may have been removed elsewhere).
  const listed = !!deviceId && !!devices.data?.some((d) => d.id === deviceId);
  const enabled = permission === 'granted' && !!hasSub && listed;

  const enable = useMutation({
    mutationFn: () => enablePush(publicKey.data?.publicKey),
    onSuccess: ({ permission: p, device }) => {
      setPermission(p);
      if (device) {
        setHasSub(true);
        setDeviceId(device.id);
        setThisDeviceId(device.id);
        void qc.invalidateQueries({ queryKey: qkDevices });
        toast({ tone: 'success', title: 'Notifications are on for this device' });
      }
    },
    onError: (e) => {
      setPermission(notificationPermission());
      toast({ tone: 'error', title: 'Could not enable notifications', description: errorMessage(e) });
    },
  });

  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: () => {
      setHasSub(false);
      setDeviceId(null);
      setThisDeviceId(null);
      void qc.invalidateQueries({ queryKey: qkDevices });
    },
    onError: (e) => toast({ tone: 'error', title: 'Could not turn off notifications', description: errorMessage(e) }),
  });

  const test = useMutation({
    mutationFn: pushApi.test,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qkDevices });
      if (r.sent) toast({ tone: 'success', title: `Test sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}`, description: r.failed ? `${r.failed} could not be reached.` : undefined });
      else toast({ tone: 'error', title: 'No device could be reached', description: 'Try turning notifications off and on again on that device.' });
    },
    onError: (e) => toast({ tone: 'error', title: 'Test not sent', description: errorMessage(e) }),
  });

  const loading = hasSub === null || devices.isPending;
  return (
    <Section title="This device" description="Notifications arrive through your browser's push service, encrypted end to end.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px]">
          {enabled ? <Bell size={16} className="text-success" /> : <BellOff size={16} className="text-faint" />}
          {loading ? 'Checking…' : enabled ? 'Notifications are on for this device.' : permission === 'denied' ? 'Blocked in this browser.' : 'Not enabled on this device.'}
        </p>
        <div className="flex flex-wrap gap-2">
          {enabled && <Button loading={test.isPending} onClick={() => test.mutate()}>Send test notification</Button>}
          {enabled ? (
            <Button variant="ghost" className="text-danger" loading={disable.isPending} onClick={() => disable.mutate()}>Disable</Button>
          ) : (
            permission !== 'denied' && (
              // Permission is requested only here, on click.
              <Button variant="primary" disabled={loading} loading={enable.isPending} onClick={() => enable.mutate()}>Enable on this device</Button>
            )
          )}
        </div>
      </div>
      {permission === 'denied' && <DeniedHelp />}
    </Section>
  );
}

function IosInstallSection() {
  return (
    <Section title="This device" description="On iPhone and iPad, notifications work in the Home Screen app (iOS 16.4 or later).">
      <p className="flex items-start gap-2 text-[13px]">
        <Share size={16} className="mt-0.5 shrink-0 text-muted" />
        <span>Add Cirrus to your Home Screen (Share → Add to Home Screen), open it from there, then enable notifications here.</span>
      </p>
    </Section>
  );
}

/** No Web Push here: keep the in-tab alerts for new mail while Cirrus Mail is open but not in focus. */
function InTabSection() {
  const [permission, setPermission] = useState(notificationPermission);
  const ask = async () => {
    const p = await Notification.requestPermission();
    setPermission(p);
    if (p === 'granted') new Notification('Notifications are on', { body: 'Cirrus Mail will tell you about new mail while this tab is open.', icon: '/icons/icon-192.png' });
  };
  return (
    <Section title="This device" description="This browser does not support push notifications. Cirrus Mail can still notify you while it is open in a tab but not in focus.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px]">
          {permission === 'granted' ? <Bell size={16} className="text-success" /> : <BellOff size={16} className="text-faint" />}
          {permission === 'granted' && 'In-tab notifications are on for this browser.'}
          {permission === 'denied' && 'Blocked in this browser.'}
          {permission === 'default' && 'Not enabled yet.'}
          {permission === 'unsupported' && 'This browser does not support notifications.'}
        </p>
        {permission === 'default' && <Button variant="primary" onClick={() => void ask()}>Enable notifications</Button>}
      </div>
      {permission === 'denied' && <DeniedHelp />}
    </Section>
  );
}

function PreviewSection() {
  const { user } = useMeData();
  const update = useUpdateMe();
  const { toast } = useToast();
  return (
    <Section title="Privacy">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13px] font-medium">Show sender and subject in notifications</p>
          <p className="text-[12px] text-muted">When off, notifications only say "New mail" and the mailbox address, which is safer on a lock screen.</p>
        </div>
        <Switch
          checked={user.pushPreview}
          label="Show sender and subject in notifications"
          onChange={(pushPreview) => update.mutate({ pushPreview }, { onError: (e) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) }) })}
        />
      </div>
    </Section>
  );
}

function DevicesSection() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: qkDevices, queryFn: pushApi.devices });
  const confirm = useConfirm();
  const { toast } = useToast();
  const thisDevice = getThisDeviceId();
  const remove = useMutation({
    mutationFn: pushApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: qkDevices }),
    onError: (e) => toast({ tone: 'error', title: 'Could not remove device', description: errorMessage(e) }),
  });

  return (
    <Section title="Devices" description="Devices that get notifications for your mail. Devices that stop responding are removed automatically.">
      {devices.isPending ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : devices.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(devices.error)}</p>
      ) : !devices.data.length ? (
        <p className="text-[13px] text-muted">No devices yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {devices.data.map((d) => {
            const label = deviceLabel(d.userAgent);
            return (
              <li key={d.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-8 items-center justify-center rounded-md bg-surface-2 text-muted [&_svg]:stroke-[1.75]">
                  {label.mobile ? <Smartphone size={16} /> : <Laptop size={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {label.name}
                    {d.id === thisDevice && <span className="ml-2 text-[12px] font-normal text-success">This device</span>}
                  </p>
                  <p className="text-[12px] text-muted">
                    Added {relativeAgo(d.createdAt)}{d.lastSuccessAt ? `, last notified ${relativeAgo(d.lastSuccessAt)}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Stop notifications on this device?', confirmLabel: 'Remove', danger: true }))) return;
                    remove.mutate(d.id);
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
