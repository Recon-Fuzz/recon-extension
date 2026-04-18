import * as assert from 'assert';
import { combinePathSources } from '../utils';

/**
 * Pure-TS unit tests for `combinePathSources()`.
 *
 * Regression guard for the bug where `getEnvironmentPath()` used the Unix
 * PATH separator (`:`) on Windows. That corrupted any Windows path containing
 * a drive letter (e.g. `C:\Users\...`) and caused spawned `forge`, `echidna`,
 * `medusa`, `halmos` processes to fail with "command not found" on Windows.
 *
 * Uses Mocha TDD interface (`suite` / `test`) — the default for VS Code
 * extension tests under `@vscode/test-cli`.
 */
suite('combinePathSources()', () => {
    // ---- Windows -------------------------------------------------------

    suite('on win32', () => {
        const plat: NodeJS.Platform = 'win32';
        const sep = ';';

        test('joins userPath + defaultPath using the Windows separator', () => {
            const out = combinePathSources(
                'C:\\Users\\me\\bin',
                '',
                'C:\\Windows\\System32;C:\\Windows',
                plat,
                sep,
            );
            assert.strictEqual(
                out,
                'C:\\Users\\me\\bin;C:\\Windows\\System32;C:\\Windows',
            );
        });

        test('returns defaultPath when userPath is empty', () => {
            const out = combinePathSources(
                '',
                '',
                'C:\\Windows\\System32;C:\\Windows',
                plat,
                sep,
            );
            assert.strictEqual(out, 'C:\\Windows\\System32;C:\\Windows');
        });

        test('does NOT split on ":" (preserves drive letters like C:\\...)', () => {
            const userPath = 'C:\\Users\\me\\.foundry\\bin';
            const defaultPath = 'C:\\Windows\\System32';
            const out = combinePathSources(userPath, '', defaultPath, plat, sep);
            // Drive letters must survive intact.
            assert.ok(out.includes('C:\\Users\\me\\.foundry\\bin'));
            assert.ok(out.includes('C:\\Windows\\System32'));
            const parts = out.split(';');
            assert.deepStrictEqual(parts, [
                'C:\\Users\\me\\.foundry\\bin',
                'C:\\Windows\\System32',
            ]);
        });

        test('does not read shellPath on Windows (no login shell)', () => {
            const out = combinePathSources(
                'C:\\a',
                'C:\\b', // would be present on posix, ignored on windows
                'C:\\c',
                plat,
                sep,
            );
            assert.strictEqual(out, 'C:\\a;C:\\c');
            assert.ok(!out.includes('C:\\b'));
        });

        test('returns empty string when every input is empty', () => {
            const out = combinePathSources('', '', '', plat, sep);
            assert.strictEqual(out, '');
        });
    });

    // ---- POSIX (linux / darwin) ----------------------------------------

    suite('on posix (linux/darwin)', () => {
        const plat: NodeJS.Platform = 'linux';
        const sep = ':';

        test('merges all three sources deduplicated with ":"', () => {
            const out = combinePathSources(
                '/home/me/bin',
                '/usr/local/bin:/home/me/bin',
                '/usr/bin:/bin',
                plat,
                sep,
            );
            const parts = out.split(':');
            // All uniques must appear; order preserves first-seen.
            assert.deepStrictEqual(parts, [
                '/home/me/bin',
                '/usr/local/bin',
                '/usr/bin',
                '/bin',
            ]);
        });

        test('drops empty-string fragments from consecutive colons', () => {
            const out = combinePathSources(
                '',
                '::/usr/local/bin::',
                '/usr/bin::',
                plat,
                sep,
            );
            assert.ok(!out.split(':').includes(''), 'no empty segments allowed');
            assert.ok(out.includes('/usr/local/bin'));
            assert.ok(out.includes('/usr/bin'));
        });

        test('darwin behaves like linux', () => {
            const out = combinePathSources(
                '/Users/me/bin',
                '/opt/homebrew/bin',
                '/usr/bin',
                'darwin',
                sep,
            );
            assert.deepStrictEqual(out.split(':'), [
                '/Users/me/bin',
                '/opt/homebrew/bin',
                '/usr/bin',
            ]);
        });
    });
});
