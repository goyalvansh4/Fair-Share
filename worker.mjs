import openNextWorker from './.open-next/worker.js';

async function checkSupabase(env) {
  const projectUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!projectUrl || !publishableKey) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY for the scheduled health check.');
  }

  const endpoint = new URL('/rest/v1/rpc/daily_health_check', projectUrl);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Supabase daily health check failed with HTTP ${response.status}.`);
  const result = await response.json();
  if (result !== true) throw new Error('Supabase daily health check returned an unexpected result.');
  console.info(`Supabase daily health check succeeded at ${new Date().toISOString()}.`);
}

// Asks the app itself to send any monthly statements that are due. A failure here never affects the health check.
async function sendDueStatements(env) {
  if (!env.CRON_SECRET || !env.WORKER_SELF_REFERENCE) return;
  const response = await env.WORKER_SELF_REFERENCE.fetch('https://fairshare.internal/api/cron/statements', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
  if (!response.ok) throw new Error(`Statement run failed with HTTP ${response.status}.`);
  console.info(`Statement run: ${await response.text()}`);
}

const worker = {
  fetch(request, env, ctx) {
    return openNextWorker.fetch(request, env, ctx);
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkSupabase(env));
    ctx.waitUntil(sendDueStatements(env).catch(error => console.error(error)));
  },
};

export default worker;
