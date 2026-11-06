import { runCron } from './cron';
import { app } from './app';
import { handleDav } from './dav/handler';
import { handleEmail } from './inbound/handler';
import { handleJmap } from './jmap/handler';
import { Meter, meters } from './lib/timing';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const meter = new Meter();
      meters.set(request, meter);
      return app.fetch(request, meter.instrument(env), ctx);
    }
    // CardDAV/CalDAV: Basic auth with app passwords, outside the cookie/CSRF world of /api.
    if (url.pathname === '/dav' || url.pathname.startsWith('/dav/') || url.pathname === '/.well-known/caldav' || url.pathname === '/.well-known/carddav') {
      return handleDav(request, env);
    }
    // JMAP: Basic/Bearer app-password auth, outside the cookie/CSRF world of /api.
    if (url.pathname === '/jmap' || url.pathname.startsWith('/jmap/') || url.pathname === '/.well-known/jmap') return handleJmap(request, env);
    // Only /api/*, /dav/* and the DAV discovery paths run the Worker first; anything else that reaches us is an asset or SPA route.
    return env.ASSETS.fetch(request);
  },
  email: handleEmail,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
