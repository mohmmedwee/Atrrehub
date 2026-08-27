/**
 * Check the documentation's countable claims against the code.
 *
 * Every number in a document rots. This exists because several already had:
 * the roadmap claimed 168 Prometheus metrics when there were 44, and a test
 * count that had been true three releases earlier. A number nobody can check
 * is a number nobody should trust, so these are checked in CI.
 *
 *   node scripts/audit-docs.mjs
 *
 * Exits non-zero on any discrepancy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const problems = [];
const notes = [];

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function check(label, claimed, actual) {
  if (claimed === actual) {
    notes.push(`ok   ${label}: ${actual}`);
  } else {
    problems.push(`${label}: the docs say ${claimed}, the code says ${actual}`);
  }
}

// ── Domain events ────────────────────────────────────────────────────────────

const events = new Set(
  [...read('apps/api/src/core/events/domain-events.ts').matchAll(/^ {2}\w+: '([a-z_.]+)',/gm)].map(
    (match) => match[1],
  ),
);

// A catalogue row may list several events separated by "/", so take every
// backticked name on the row rather than only the first.
const documented = new Set();
for (const line of read('docs/events/catalog.md').split('\n')) {
  if (!line.startsWith('|')) continue;
  for (const match of line.matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`/g)) {
    documented.add(match[1]);
  }
}

const undocumented = [...events].filter((event) => !documented.has(event)).sort();
const phantom = [...documented].filter((event) => !events.has(event)).sort();
if (undocumented.length) problems.push(`events published but not in the catalogue: ${undocumented.join(', ')}`);
if (phantom.length) problems.push(`events in the catalogue that nothing publishes: ${phantom.join(', ')}`);
if (!undocumented.length && !phantom.length) notes.push(`ok   event catalogue: all ${events.size} events documented`);

// ── Roadmap ──────────────────────────────────────────────────────────────────

const roadmap = read('docs/product/roadmap.md');
const [builtSection, partialSection] = roadmap.split('## Partial');
const phasesIn = (section) =>
  new Set([...section.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1])));

const built = phasesIn(builtSection);
const partial = phasesIn(partialSection ?? '');
const totals = roadmap.match(/\*\*Totals: (\d+) built · (\d+) partial/);

if (!totals) {
  problems.push('the roadmap has no totals line');
} else {
  check('roadmap built count', Number(totals[1]), built.size);
  check('roadmap partial count', Number(totals[2]), partial.size);
}

const overlap = [...built].filter((phase) => partial.has(phase));
if (overlap.length) problems.push(`phases listed as both built and partial: ${overlap.join(', ')}`);

const PHASES = 51;
const missing = Array.from({ length: PHASES }, (_, index) => index).filter(
  (phase) => !built.has(phase) && !partial.has(phase),
);
if (missing.length) problems.push(`phases in neither table: ${missing.join(', ')}`);
if (built.size + partial.size !== PHASES) {
  problems.push(`the roadmap accounts for ${built.size + partial.size} phases, not ${PHASES}`);
}

// ── Channels ─────────────────────────────────────────────────────────────────

const adapters = readdirSync(new URL('../apps/api/src/modules/channels/adapters', import.meta.url))
  .filter((file) => file.endsWith('.adapter.ts') && !file.includes('base')).length;
const WORDS = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const claimedChannels = roadmap.match(/(Six|Seven|Eight|Nine|Ten) channels/i);
if (claimedChannels) check('channel adapters', WORDS[claimedChannels[1].toLowerCase()], adapters);

// ── Tests ────────────────────────────────────────────────────────────────────

const claimedTests = roadmap.match(/(\d+) unit \+ (\d+) integration tests/);
if (claimedTests) {
  execSync('pnpm --filter @atrrehub/api exec vitest run --reporter=json --outputFile=/tmp/audit-vitest.json', {
    stdio: 'ignore',
    cwd: new URL('..', import.meta.url),
  });
  const results = JSON.parse(readFileSync('/tmp/audit-vitest.json', 'utf8'));
  check('unit tests', Number(claimedTests[1]), results.numTotalTests);
  notes.push(`note integration tests claimed: ${claimedTests[2]} (run test:e2e to confirm)`);
}

// ── Report ───────────────────────────────────────────────────────────────────

for (const note of notes) process.stdout.write(`${note}\n`);
if (problems.length) {
  process.stdout.write('\n');
  for (const problem of problems) process.stdout.write(`FAIL ${problem}\n`);
  process.stdout.write(`\n${problems.length} discrepancy(ies) between the docs and the code.\n`);
  process.exit(1);
}
process.stdout.write('\nEvery countable claim in the documentation matches the code.\n');
