import { useState } from 'react';
import { Button } from '../../components/Button';
import { Field, Input } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useMeData, useUpdateMe } from '../../lib/queries/me';
import { Avatar } from '../../components/Avatar';

export function ProfileSettings() {
  const { user } = useMeData();
  const update = useUpdateMe();
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const dirty = name.trim() !== user.name && name.trim().length > 0;

  return (
    <>
      <PageTitle title="Profile" description="How you appear inside Cirrus Mail." />
      <Section
        title="Your details"
        footer={
          <Button
            variant="primary"
            disabled={!dirty}
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { name: name.trim() },
                {
                  onSuccess: () => toast({ tone: 'success', title: 'Profile saved' }),
                  onError: (e) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) }),
                },
              )
            }
          >
            Save
          </Button>
        }
      >
        <div className="mb-5 flex items-center gap-3">
          <Avatar address={{ email: user.email, name }} size={48} />
          <div>
            <p className="text-[13px] font-medium">{name || user.email}</p>
            <p className="text-[13px] text-muted">{user.role === 'admin' ? 'Administrator' : 'Member'}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
          <Field label="Sign-in email" hint="Ask an administrator to change it.">
            {(id, d) => <Input id={id} aria-describedby={d} value={user.email} disabled />}
          </Field>
        </div>
      </Section>
    </>
  );
}
