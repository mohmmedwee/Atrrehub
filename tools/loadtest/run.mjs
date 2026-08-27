/**
 * Load test for the Atrrehub API.
 *
 * Written against Node's own fetch rather than k6 or Artillery, deliberately:
 * a load test that needs a tool nobody has installed is a load test nobody
 * runs, and the numbers below matter more than the harness that produced them.
 *
 *   node tools/loadtest/run.mjs --url http://localhost:4000 \
 *     --email owner@example.com --password '…' --vus 20 --duration 30
 *
 * It reports per-scenario latency percentiles and a pass/fail against the
 * thresholds in THRESHOLDS, so it can gate a release rather than just print
 * numbers somebody has to interpret.
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);

const BASE = (args.url ?? 'http://localhost:4000').replace(/\/+$/, '');
const VUS = Number(args.vus ?? 10);
const DURATION_S = Number(args.duration ?? 30);
const WARMUP_S = Number(args.warmup ?? 3);
/**
 * Offered load, in requests per second across all virtual users. 0 removes the
 * throttle.
 *
 * This exists because of what the first run of this tool found: the API's
 * default bucket is 600 requests per minute *per principal*, so twenty
 * unthrottled users signed in as one person produced 44,753 rate-limited
 * responses out of 49,747 — and the percentiles measured the rate limiter
 * rather than the API. A load test has to stay inside the limit, or use as
 * many principals as the load it claims to represent.
 */
const TARGET_RPS = Number(args.rps ?? 9);

/**
 * What "fast enough" means, per scenario.
 *
 * p95 rather than the mean: the mean hides the tail, and the tail is what a
 * person actually experiences. Read paths are held to a tighter bound than
 * writes because a write does real work and a list does not.
 */
const THRESHOLDS = {
  'GET /conversations': { p95: 400, errorRate: 0.01 },
  'GET /customers': { p95: 400, errorRate: 0.01 },
  'GET /tickets': { p95: 400, errorRate: 0.01 },
  'GET /analytics/executive': { p95: 1500, errorRate: 0.01 },
  'POST /customers': { p95: 800, errorRate: 0.01 },
  'GET /knowledge/search': { p95: 1000, errorRate: 0.01 },
};

async function login() {
  if (args.token) return args.token;
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: args.email, password: args.password }),
  });
  if (!response.ok) {
    throw new Error(`Login failed with ${response.status}. Pass --token to skip it.`);
  }
  return (await response.json()).data.accessToken;
}

/** The mix a real workspace produces: mostly reads, a few writes. */
function scenarios(token) {
  const auth = { authorization: `Bearer ${token}` };
  return [
    { name: 'GET /conversations', weight: 30, run: () => get('/conversations?limit=25', auth) },
    { name: 'GET /customers', weight: 20, run: () => get('/customers?limit=25', auth) },
    { name: 'GET /tickets', weight: 20, run: () => get('/tickets?limit=25', auth) },
    { name: 'GET /analytics/executive', weight: 10, run: () => get('/analytics/executive', auth) },
    { name: 'GET /knowledge/search', weight: 10, run: () => get('/knowledge/search?q=password', auth) },
    {
      name: 'POST /customers',
      weight: 10,
      run: () =>
        request('POST', '/customers', auth, {
          firstName: 'Load',
          lastName: `Test${Math.random().toString(36).slice(2, 8)}`,
          contactMethods: [
            { kind: 'email', value: `load-${Math.random().toString(36).slice(2)}@loadtest.invalid` },
          ],
        }),
    },
  ];
}

const get = (path, auth) => request('GET', path, auth);

async function request(method, path, auth, body) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        ...auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
        // Every write is retryable, which is what the SDK does too.
        ...(body ? { 'idempotency-key': crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // The body must be drained or the socket is not returned to the pool, and
    // the test measures connection starvation instead of the server.
    await response.arrayBuffer();
    return {
      ms: performance.now() - started,
      ok: response.ok,
      // A 429 is the platform working correctly, not failing. Counting it as an
      // error makes a properly-defended API look broken under load.
      rateLimited: response.status === 429,
      status: response.status,
    };
  } catch (error) {
    return {
      ms: performance.now() - started,
      ok: false,
      rateLimited: false,
      status: 0,
      error: String(error),
    };
  }
}

/** Weighted pick, so the mix stays representative rather than round-robin. */
function pick(list) {
  const total = list.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of list) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return list.at(-1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  // Nearest-rank. Simple, and it never invents a number that was not measured.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

async function main() {
  const token = await login();
  const mix = scenarios(token);
  const samples = new Map(mix.map((scenario) => [scenario.name, []]));
  const statuses = new Map();

  const perRequestDelayMs = TARGET_RPS > 0 ? (1000 * VUS) / TARGET_RPS : 0;
  const deadline = Date.now() + (DURATION_S + WARMUP_S) * 1000;
  const warmupUntil = Date.now() + WARMUP_S * 1000;
  let inFlight = 0;

  process.stdout.write(
    `${VUS} virtual users, ${DURATION_S}s (after ${WARMUP_S}s warm-up), against ${BASE}\n` +
      `offered load: ${TARGET_RPS > 0 ? `${TARGET_RPS} req/s` : 'unthrottled'}\n`,
  );

  const worker = async () => {
    while (Date.now() < deadline) {
      // Paced before the request, and regardless of what the last one
      // returned: a throttle that sits on the success path only stops
      // throttling the moment the server starts rejecting, which is exactly
      // when offered load most needs to come down.
      if (perRequestDelayMs > 0) await sleep(perRequestDelayMs);
      if (Date.now() >= deadline) break;

      const scenario = pick(mix);
      inFlight += 1;
      const result = await scenario.run();
      inFlight -= 1;
      // Warm-up results are discarded: the first requests pay for connection
      // setup, JIT and a cold query plan cache, and none of that is what the
      // test is measuring.
      if (Date.now() < warmupUntil) continue;

      const bucket = samples.get(scenario.name);
      statuses.set(`${result.status}`, (statuses.get(`${result.status}`) ?? 0) + 1);

      if (result.rateLimited) {
        // Not a latency sample: the response came from the rate limiter, not
        // from the work being measured, and folding it in would flatter every
        // percentile in the report.
        bucket.rateLimited = (bucket.rateLimited ?? 0) + 1;
        continue;
      }
      bucket.push(result.ms);
      if (!result.ok) (bucket.errors ??= []).push(result.status || result.error);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: VUS }, worker));
  const elapsed = (Date.now() - started) / 1000 - WARMUP_S;

  let total = 0;
  let failed = false;
  const rows = [];

  for (const [name, list] of samples) {
    const sorted = [...list].sort((a, b) => a - b);
    total += sorted.length;
    const errors = list.errors?.length ?? 0;
    const errorRate = sorted.length ? errors / sorted.length : 0;
    const rateLimited = list.rateLimited ?? 0;
    const threshold = THRESHOLDS[name];
    const p95 = percentile(sorted, 95);
    // A scenario that produced no latency samples is a failure, not a pass:
    // "no data" and "fast enough" must never print the same word.
    const pass =
      sorted.length > 0 && (!threshold || (p95 <= threshold.p95 && errorRate <= threshold.errorRate));
    if (!pass) failed = true;

    rows.push({
      name,
      n: sorted.length,
      p50: percentile(sorted, 50),
      p95,
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? 0,
      errorRate,
      rateLimited,
      threshold: threshold?.p95,
      pass,
    });
  }

  const width = Math.max(...rows.map((row) => row.name.length), 20);
  process.stdout.write(
    `\n${'scenario'.padEnd(width)}  ${'n'.padStart(6)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}  ${'err'.padStart(6)} ${'429'.padStart(6)}  ${'p95 max'.padStart(8)}\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.name.padEnd(width)}  ${String(row.n).padStart(6)} ${row.p50.toFixed(0).padStart(7)} ${row.p95.toFixed(0).padStart(7)} ${row.p99.toFixed(0).padStart(7)} ${row.max.toFixed(0).padStart(7)}  ${(row.errorRate * 100).toFixed(1).padStart(5)}% ${String(row.rateLimited).padStart(6)}  ${String(row.threshold ?? '-').padStart(7)}  ${row.pass ? 'pass' : 'FAIL'}\n`,
    );
  }

  process.stdout.write(
    `\n${total} requests in ${elapsed.toFixed(1)}s — ${(total / elapsed).toFixed(0)} req/s, ${inFlight} still in flight\n`,
  );
  process.stdout.write(
    `statuses: ${[...statuses.entries()].sort().map(([code, count]) => `${code}×${count}`).join('  ')}\n`,
  );

  const throttled = rows.reduce((sum, row) => sum + row.rateLimited, 0);
  if (throttled > total * 0.05) {
    process.stdout.write(
      `\nWarning: ${throttled} responses came from the rate limiter, so these\n` +
        `percentiles describe the limiter rather than the API. Lower --rps, or\n` +
        `sign in as more principals — the default bucket is per principal.\n`,
    );
  }

  // Exit non-zero on a threshold breach so this can gate a release rather than
  // print numbers somebody has to remember to read.
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});
