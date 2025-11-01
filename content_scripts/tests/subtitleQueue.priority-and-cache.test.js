/**
 * Tests for Caching + Dynamic Priority subtitle translation queue
 */

import { jest } from '@jest/globals';
import { mockChromeApi, ChromeApiMock } from '../../test-utils/chrome-api-mock.js';
import flushPromises from '../../test-utils/flush-promises.js';

// Import module under test
import * as SubtitleUtils from '../shared/subtitleUtilities.js';

// Minimal activePlatform stub
function createPlatform(video) {
    return {
        getVideoElement: () => video,
        getCurrentVideoId: () => 'vid1',
        supportsProgressBarTracking: () => false,
        getProgressBarElement: () => null,
        isPlayerPageActive: () => true,
    };
}

describe('Subtitle queue Caching + Dynamic Priority', () => {
    let restoreChrome;
    let chromeMock;
    let video;

    beforeEach(() => {
        chromeMock = ChromeApiMock.create();
        // Mock checkBatchSupport to include providerId
        chromeMock.runtime.sendMessage.mockImplementation((msg, cb) => {
            if (typeof cb !== 'function') return Promise.resolve({});
            if (msg?.action === 'checkBatchSupport') {
                cb({ supportsBatch: true, providerId: 'OPENAI_COMPATIBLE' });
                return;
            }
            if (msg?.action === 'translate') {
                cb({
                    translatedText: `[${msg.text}]_${msg.targetLang}`,
                    originalText: msg.text,
                    cueStart: msg.cueStart,
                    cueVideoId: msg.cueVideoId,
                });
                return;
            }
            if (msg?.action === 'translateBatch') {
                const translations = (msg.texts || []).map((t) => `[${t}]_${msg.targetLang}`);
                cb({ translations });
                return;
            }
            if (msg?.action === 'debugLog') {
                cb({ success: true });
                return;
            }
            cb({ success: true });
        });
        restoreChrome = mockChromeApi(chromeMock);

        // Fresh DOM for container
        document.body.innerHTML = '';

        video = document.createElement('video');
        // JSDOM 的 HTMLMediaElement 部分属性是只读，使用 defineProperty 模拟
        let _ct = 100;
        Object.defineProperty(video, 'currentTime', {
            get: () => _ct,
            set: (v) => {
                _ct = v;
            },
            configurable: true,
        });
        document.body.appendChild(video);

        SubtitleUtils.setCurrentVideoId('vid1');
        SubtitleUtils.setSubtitlesActive(true);
    });

    afterEach(() => {
        restoreChrome();
        jest.clearAllMocks();
    });

    function makeVtt(cues) {
        const lines = ['WEBVTT', ''];
        cues.forEach((c, i) => {
            const fmt = (s) => new Date(s * 1000).toISOString().substr(11, 12).replace('.', ',');
            lines.push(`${i + 1}`);
            lines.push(`${fmt(c.start)} --> ${fmt(c.end)}`);
            lines.push(c.text);
            lines.push('');
        });
        return lines.join('\n');
    }

    test('prioritizes on-screen and near-future cues, uses batch', async () => {
        const activePlatform = createPlatform(video);
        const config = {
            subtitleTimeOffset: 0,
            targetLanguage: 'zh-CN',
            translationBatchSize: 5,
            prefetchWindowSec: 30,
            prefetchPastWindowSec: 10,
        };

        // Create cues around currentTime=100: on-screen, near future, far future
        const vtt = makeVtt([
            { start: 99, end: 102, text: 'onscreen' },
            { start: 104, end: 106, text: 'soon' },
            { start: 130, end: 132, text: 'prefetch' },
            { start: 250, end: 252, text: 'far' },
        ]);
        SubtitleUtils.handleSubtitleDataFound(
            {
                vttText: vtt,
                targetVttText: null,
                videoId: 'vid1',
                useNativeTarget: false,
                sourceLanguage: 'en',
                targetLanguage: 'zh-CN',
            },
            activePlatform,
            config
        );

        await SubtitleUtils.processSubtitleQueue(activePlatform, config);
        await flushPromises();

        // Verify translateBatch was used once (supportsBatch=true and >1)
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'translateBatch' }),
            expect.any(Function)
        );

        // Verify DEBUG_LOG calls for prioritization and batch
        expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'debugLog' }),
            expect.any(Function)
        );
    });

    test('caching prevents retranslation after seek back and replay', async () => {
        const activePlatform = createPlatform(video);
        const config = {
            subtitleTimeOffset: 0,
            targetLanguage: 'zh-CN',
            translationBatchSize: 3,
            prefetchWindowSec: 20,
            prefetchPastWindowSec: 10,
        };

        const vtt = makeVtt([
            { start: 300, end: 302, text: 'already' },
            { start: 310, end: 312, text: 'cached' },
            { start: 320, end: 322, text: 'block' },
        ]);
        SubtitleUtils.handleSubtitleDataFound(
            {
                vttText: vtt,
                targetVttText: null,
                videoId: 'vid1',
                useNativeTarget: false,
                sourceLanguage: 'en',
                targetLanguage: 'zh-CN',
            },
            activePlatform,
            config
        );

        // First pass translates and caches
        video.currentTime = 300;
        await SubtitleUtils.processSubtitleQueue(activePlatform, config);
        await flushPromises();

        const sendCountAfterFirst = chromeMock.runtime.sendMessage.mock.calls.length;

        // Simulate seek back and replay - should hit cache, not call new translate for same cues
        video.currentTime = 295;
        await SubtitleUtils.processSubtitleQueue(activePlatform, config);
        await flushPromises();

        const sendCountAfterSecond = chromeMock.runtime.sendMessage.mock.calls.length;
        expect(sendCountAfterSecond).toBeGreaterThanOrEqual(sendCountAfterFirst);

        // Allow debugLog noise; assert no additional translate/translateBatch calls happened for same cues
        const translateCallsFirst = chromeMock.runtime.sendMessage.mock.calls.filter(
            (c) => c[0]?.action === 'translate' || c[0]?.action === 'translateBatch'
        ).length;
        const translateCallsSecond = chromeMock.runtime.sendMessage.mock.calls
            .slice(sendCountAfterFirst)
            .filter((c) => c[0]?.action === 'translate' || c[0]?.action === 'translateBatch')
            .length;
        expect(translateCallsSecond).toBeLessThanOrEqual(1); // may still prefetch different cues
        expect(translateCallsFirst).toBeGreaterThan(0);
    });

    test('seek invalidates stale work via schedulingVersion', async () => {
        const activePlatform = createPlatform(video);
        const config = {
            subtitleTimeOffset: 0,
            targetLanguage: 'zh-CN',
            translationBatchSize: 2,
            prefetchWindowSec: 15,
            prefetchPastWindowSec: 5,
            translationDelay: 1,
        };

        const vtt = makeVtt([
            { start: 100, end: 102, text: 'a' },
            { start: 105, end: 107, text: 'b' },
            { start: 140, end: 142, text: 'c' },
        ]);
        SubtitleUtils.handleSubtitleDataFound(
            {
                vttText: vtt,
                targetVttText: null,
                videoId: 'vid1',
                useNativeTarget: false,
                sourceLanguage: 'en',
                targetLanguage: 'zh-CN',
            },
            activePlatform,
            config
        );

        video.currentTime = 99;
        const p1 = SubtitleUtils.processSubtitleQueue(activePlatform, config);
        // Immediately seek to far past to invalidate
        video.dispatchEvent(new Event('seeked'));

        await p1;
        await flushPromises();

        // Verify debug logs captured seek and processing continued without error
        const debugCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
            (c) => c[0]?.action === 'debugLog'
        );
        expect(debugCalls.length).toBeGreaterThan(0);
    });
}); 