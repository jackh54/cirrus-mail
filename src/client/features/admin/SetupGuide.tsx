import { ExternalLink } from 'lucide-react';
import { Section } from '../../components/PageShell';

const ROUTING = [
  'Open the Cloudflare dashboard and select your domain.',
  'Go to Compute & AI → Email Service → Email Routing. If it is not enabled yet, click "Enable Email Routing" and let it add the MX and SPF records.',
  'Open the "Routing rules" tab and find "Catch-all address".',
  'Click Edit, set the action to "Send to a Worker", choose the cirrus-mail Worker, and save.',
  'Make sure the catch-all is Enabled. Mail to any address @yourdomain now reaches Cirrus, which delivers to mailboxes, aliases and the catch-all you pick above, and rejects everything else.',
];

const SENDING = [
  'In the dashboard go to Compute & AI → Email Service → Email Sending and onboard the same domain.',
  'Add the DNS records it shows (DKIM and the sending SPF include). If the domain uses Cloudflare DNS this is one click.',
  'Wait until the domain shows as verified. Until then, sends fail with a clear error and stay in Drafts.',
  'New accounts start with a small daily sending quota that grows as you send real mail. Cirrus shows a friendly message if you hit it.',
];

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((s, i) => (
        <li key={i} className="flex gap-3 text-[13.5px] leading-relaxed">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{i + 1}</span>
          <span className="pt-0.5">{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function SetupGuide() {
  return (
    <div id="guide" className="scroll-mt-6">
      <Section title="Receive mail: Email Routing catch-all → Worker" description="Inbound mail is free and unlimited. The catch-all only works on apex domains (example.com, not mail.example.com).">
        <Steps items={ROUTING} />
      </Section>
      <Section title="Send mail: Email Sending onboarding" description="Outbound mail needs Workers Paid. 3,000 emails a month are included.">
        <Steps items={SENDING} />
        <a href="https://developers.cloudflare.com/email-routing/" target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
          Cloudflare Email docs <ExternalLink size={13} />
        </a>
      </Section>
    </div>
  );
}
