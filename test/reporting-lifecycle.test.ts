import { expect, test } from 'bun:test';

test('shutdown has a deadline when the output pipe is not being drained', async () => {
  const child = Bun.spawn([process.execPath, 'run', './test/fixtures/reporting-lifecycle.ts', 'debug', 'flood'],
    { stdout: 'pipe', stderr: 'pipe' });
  const started = Date.now();
  const timer = setTimeout(() => child.kill(), 4000);
  try {
    // Deliberately do not read stdout until after exit.
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3500);
    await new Response(child.stdout).text();
    expect(await new Response(child.stderr).text()).toBe('');
  } finally { clearTimeout(timer); child.kill(); }
});

for (const level of ['off', 'debug']) for (const fatal of [false, true]) {
  test(`reporting lifecycle ${level}, fatal=${fatal}: bounded exit and sanitized output`, async () => {
    const child = Bun.spawn([process.execPath, 'run', './test/fixtures/reporting-lifecycle.ts', level, fatal ? 'fatal' : 'normal'],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 4000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(fatal ? 1 : 0);
      expect(err).toBe('');
      if (level === 'off') expect(out).toBe('');
      else {
        expect(out).toContain('SUBMISSIONS_STOPPED');
        if (fatal) {
          expect(out).toContain('fixture fatal');
          expect(out.indexOf('SUBMISSIONS_STOPPED')).toBeLessThan(out.indexOf('Bot stopped after a fatal error'));
          expect(out).not.toContain('private.rpc');
          expect(out).not.toContain('1'.repeat(64));
        }
      }
    } finally { clearTimeout(timer); child.kill(); }
  });
}
