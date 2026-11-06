import { runCron } from './cron';
import { app } from './app';
import { handleEmail } from './inbound/handler';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    // Only /api/* runs the Worker first; anything else that reaches us is an asset or SPA route.
    return env.ASSETS.fetch(request);
  },
  email: handleEmail,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
