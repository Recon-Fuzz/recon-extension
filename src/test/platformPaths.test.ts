import * as assert from 'assert';
import {
    combinePathSources,
    escapeHtmlAttribute,
    isSourceOrReconCoveragePath,
    normalizeCoveragePath
} from '../platformPaths';

describe('platform path handling', () => {
    it('preserves Windows drive letters when combining PATH fragments', () => {
        const combined = combinePathSources(
            'C:\\Users\\alice\\.foundry\\bin',
            '/ignored/shell/path',
            'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
            'win32'
        );

        assert.strictEqual(
            combined,
            'C:\\Users\\alice\\.foundry\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd'
        );
    });

    it('uses POSIX shell PATH as an extra source outside Windows', () => {
        const combined = combinePathSources('/user/bin:/shared/bin', '/shell/bin:/shared/bin', '/default/bin', 'linux');

        assert.strictEqual(combined, '/user/bin:/shared/bin:/shell/bin:/default/bin');
    });

    it('normalizes Windows coverage paths before source/recon filtering', () => {
        assert.strictEqual(normalizeCoveragePath('src\\Counter.sol'), 'src/Counter.sol');
        assert.strictEqual(isSourceOrReconCoveragePath('src\\Counter.sol', 'src'), true);
        assert.strictEqual(isSourceOrReconCoveragePath('test\\recon\\CryticToFoundry.sol', 'src'), true);
        assert.strictEqual(isSourceOrReconCoveragePath('lib\\forge-std\\Test.sol', 'src'), false);
    });

    it('escapes Windows paths safely for webview data attributes', () => {
        assert.strictEqual(
            escapeHtmlAttribute('C:\\Users\\alice\\repo\\echidna\\covered.1.lcov'),
            'C:\\Users\\alice\\repo\\echidna\\covered.1.lcov'
        );
        assert.strictEqual(escapeHtmlAttribute('C:\\repo\\a"&<>\'.lcov'), 'C:\\repo\\a&quot;&amp;&lt;&gt;&#39;.lcov');
    });
});
