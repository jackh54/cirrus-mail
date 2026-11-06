// An Apple configuration profile that adds CardDAV and CalDAV accounts. It carries no password:
// the device asks for the app password when the profile is installed.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildMobileconfig(o: { hostname: string; port: number; ssl: boolean; email: string; userId: string; name: string }): string {
  const id = `${o.hostname.split('.').reverse().join('.')}.cirrus-mail`;
  const str = (k: string, v: string) => `<key>${k}</key><string>${esc(v)}</string>`;
  const account = (kind: 'CardDAV' | 'CalDAV', type: string, label: string, principal: string) => `
    <dict>
      ${str('PayloadType', type)}
      <key>PayloadVersion</key><integer>1</integer>
      ${str('PayloadIdentifier', `${id}.${kind.toLowerCase()}`)}
      ${str('PayloadUUID', crypto.randomUUID().toUpperCase())}
      ${str('PayloadDisplayName', label)}
      ${str(`${kind}AccountDescription`, label)}
      ${str(`${kind}HostName`, o.hostname)}
      <key>${kind}Port</key><integer>${o.port}</integer>
      <key>${kind}UseSSL</key>${o.ssl ? '<true/>' : '<false/>'}
      ${str(`${kind}Username`, o.email)}
      ${str(`${kind}PrincipalURL`, principal)}
    </dict>`;
  const principal = `/dav/principals/${o.userId}/`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>${account('CardDAV', 'com.apple.carddav.account', 'Cirrus Contacts', principal)}${account('CalDAV', 'com.apple.caldav.account', 'Cirrus Calendar', principal)}
  </array>
  ${str('PayloadDisplayName', `Cirrus Mail (${o.name})`)}
  ${str('PayloadIdentifier', id)}
  ${str('PayloadType', 'Configuration')}
  ${str('PayloadUUID', crypto.randomUUID().toUpperCase())}
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}
