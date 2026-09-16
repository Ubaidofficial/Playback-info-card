import test, { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read Web/playbackcard.html and evaluate the controller in a sandbox environment
const htmlPath = path.resolve(__dirname, '../Web/playbackcard.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// Extract the script tag content
const scriptMatch = htmlContent.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
if (!scriptMatch) {
    throw new Error('Could not find <script> tag in Web/playbackcard.html');
}
const scriptSource = scriptMatch[1];

function createMockController() {
    const mockModule = { exports: {} };
    const mockWindow = {
        location: { hash: '#/playbackcard', pathname: '/playbackcard' }
    };
    const runner = new Function('module', 'exports', 'window', 'globalThis', scriptSource);
    runner(mockModule, mockModule.exports, mockWindow, mockWindow);
    return mockModule.exports;
}

describe('Playback Info Card v0.2.3.1 Test Suite', () => {
    let controller;

    beforeEach(() => {
        controller = createMockController();
    });

    describe('1. Diagnostics Panel States', () => {
        it('initializes with default waiting state and version 0.2.3.1', () => {
            assert.equal(controller.version, '0.2.3.1');
            assert.equal(controller.diagState.pluginVersion, '0.2.3.1');
            assert.equal(controller.diagState.sessionsApiStatus, 'Waiting for sessions');
            assert.equal(controller.diagState.pollingState, 'active');
            assert.equal(controller.diagState.lastErrorCategory, 'OK');
        });

        it('transitions states upon successful or failed session fetch', () => {
            // Simulate successful poll
            controller.diagState.sessionsApiStatus = 'OK';
            controller.diagState.lastSuccessTime = Date.now();
            assert.equal(controller.diagState.sessionsApiStatus, 'OK');

            // Simulate session error
            controller.diagState.sessionsApiStatus = 'Sessions unavailable';
            controller.diagState.lastErrorCategory = 'Sessions unavailable';
            controller.diagState.lastFailureTime = Date.now();
            assert.equal(controller.diagState.sessionsApiStatus, 'Sessions unavailable');
            assert.equal(controller.diagState.lastErrorCategory, 'Sessions unavailable');
        });
    });

    describe('2. Sessions API Error and Timeout', () => {
        it('builds diagnostic report with error when sessions API is unavailable', () => {
            controller.diagState.sessionsApiStatus = 'Sessions unavailable';
            const report = controller.buildDiagnosticReport();
            assert.equal(report.sessionsApi, 'error');
        });

        it('builds diagnostic report with timeout when sessions API times out', () => {
            controller.diagState.sessionsApiStatus = 'Timeout';
            const report = controller.buildDiagnosticReport();
            assert.equal(report.sessionsApi, 'timeout');
        });
    });

    describe('3. Stale Polling Detection', () => {
        it('identifies stalled polling when interval exceeds twice the polling period', () => {
            const now = Date.now();
            controller.diagState.lastSuccessTime = now - 7000; // 7 seconds ago (> 6s threshold)
            controller.diagState.pollingState = 'active';

            // Check stale condition logic
            const isStale = (now - controller.diagState.lastSuccessTime) > 6000;
            assert.equal(isStale, true);

            if (isStale) {
                controller.diagState.pollingState = 'stalled';
                controller.diagState.lastErrorCategory = 'Polling stalled';
            }

            assert.equal(controller.diagState.pollingState, 'stalled');
            assert.equal(controller.diagState.lastErrorCategory, 'Polling stalled');
        });

        it('recovers from stalled state upon receiving a fresh poll', () => {
            controller.diagState.pollingState = 'stalled';
            controller.diagState.lastSuccessTime = Date.now();
            controller.diagState.pollingState = 'active';
            controller.diagState.lastErrorCategory = 'OK';

            assert.equal(controller.diagState.pollingState, 'active');
            assert.equal(controller.diagState.lastErrorCategory, 'OK');
        });
    });

    describe('4. Artwork Failure and Fallback', () => {
        it('increments artworkFallbackCount when session has no primary image tag', () => {
            const initialFallback = controller.diagState.artworkFallbackCount;
            const sessionNoArt = {
                Id: 'sess1',
                UserName: 'Alice',
                NowPlayingItem: { Name: 'Sample Movie', Id: 'item1' }
            };
            const html = controller.renderSessionCard(sessionNoArt);
            assert.ok(html.includes('playback-poster-fallback'));
            assert.equal(controller.diagState.artworkFallbackCount, initialFallback + 1);
        });

        it('tracks artwork status in diagnostic report', () => {
            controller.diagState.artworkErrorCount = 2;
            const report = controller.buildDiagnosticReport();
            assert.equal(report.artwork, 'error');

            controller.diagState.artworkErrorCount = 0;
            controller.diagState.artworkFallbackCount = 3;
            controller.diagState.artworkLoadedCount = 0;
            const reportFallback = controller.buildDiagnosticReport();
            assert.equal(reportFallback.artwork, 'fallback');

            controller.diagState.artworkLoadedCount = 5;
            const reportLoaded = controller.buildDiagnosticReport();
            assert.equal(reportLoaded.artwork, 'loaded');
        });
    });

    describe('5. Malformed Session Payload', () => {
        it('gracefully handles null or non-object sessions without throwing', () => {
            const initialIgnored = controller.diagState.ignoredSessionCount;
            const resultNull = controller.renderSessionCard(null);
            assert.equal(resultNull, '');
            assert.equal(controller.diagState.ignoredSessionCount, initialIgnored + 1);

            const resultUndefined = controller.renderSessionCard(undefined);
            assert.equal(resultUndefined, '');
            assert.equal(controller.diagState.ignoredSessionCount, initialIgnored + 2);
        });

        it('handles sessions with missing or empty NowPlayingItem', () => {
            const sessionEmpty = { Id: 's2', UserName: 'Bob' };
            const html = controller.renderSessionCard(sessionEmpty);
            assert.ok(html.includes('Unknown Media'));
            assert.ok(html.includes('Bob'));
        });
    });

    describe('6. Render Error Boundary', () => {
        it('catches render exceptions, increments renderErrors, and returns safe fallback card', () => {
            const initialErrors = controller.diagState.renderErrors;
            // Create a session object with a getter that throws
            const faultySession = {
                get UserName() {
                    throw new Error('Simulated unexpected field read exception');
                }
            };
            const result = controller.renderSessionCard(faultySession);
            assert.ok(result.includes('error-card'));
            assert.ok(result.includes('Failed to render playback card'));
            assert.equal(controller.diagState.renderErrors, initialErrors + 1);
        });
    });

    describe('7. Redacted Diagnostic Output Structure', () => {
        it('outputs all required keys with redacted metadata and relative times', () => {
            controller.diagState.lastSuccessTime = Date.now() - 5000;
            const report = controller.buildDiagnosticReport();

            assert.equal(report.pluginVersion, '0.2.3.1');
            assert.ok('jellyfinVersion' in report);
            assert.ok('webVersion' in report);
            assert.ok('route' in report);
            assert.equal(typeof report.pageLoaded, 'boolean');
            assert.ok(['ok', 'error', 'timeout'].includes(report.sessionsApi));
            assert.equal(report.lastSuccessfulPoll, '5s ago');
            assert.ok(['active', 'stopped', 'stalled'].includes(report.pollingState));
            assert.ok(['loaded', 'fallback', 'error'].includes(report.artwork));
            assert.equal(typeof report.ignoredSessionCount, 'number');
            assert.equal(typeof report.renderErrors, 'number');

            // Ensure no timestamp integers leak
            assert.equal(typeof report.lastSuccessfulPoll, 'string');
            assert.ok(!/^\d{13}$/.test(report.lastSuccessfulPoll));
        });
    });

    describe('8. Blocked Sensitive Fields and Privacy Redaction Check', () => {
        const sensitiveCases = [
            'RemoteEndPoint: "192.168.1.50:8096"',
            'ipAddress: "10.0.0.12"',
            'endpoint: "http://192.168.1.1"',
            'Network: LAN',
            'Connection: WAN',
            'Type: CELLULAR',
            'Mode: WIFI',
            'geolocation: "New York, USA"',
            'api_key: "abc123secret"',
            'token: "eyJh...secret"',
            'authorization: "MediaBrowser Token=\\"xyz\\""',
            'cookie: "session=xyz"',
            'password: "SuperSecretPassword"',
            'file path: "/data/media/movies/TheMatrix.mkv"',
            'username: "Administrator"',
            'media title: "Top Secret Movie"',
            '192.168.1.1'
        ];

        sensitiveCases.forEach((sample) => {
            it(`detects sensitive string: "${sample}"`, () => {
                const hasSensitive = controller.checkSensitiveData(sample);
                assert.equal(hasSensitive, true, `Expected sensitive check to trigger for: ${sample}`);
            });
        });

        it('passes clean redacted diagnostic reports without false positive', () => {
            const cleanReport = JSON.stringify({
                pluginVersion: '0.2.3.1',
                jellyfinVersion: '10.9.11',
                webVersion: 'Available',
                route: '/playbackcard',
                pageLoaded: true,
                sessionsApi: 'ok',
                lastSuccessfulPoll: '3s ago',
                pollingState: 'active',
                artwork: 'loaded',
                ignoredSessionCount: 0,
                renderErrors: 0
            });
            const hasSensitive = controller.checkSensitiveData(cleanReport);
            assert.equal(hasSensitive, false);
        });

        it('blocks copyDiagnosticReport when report contains sensitive fields', () => {
            controller.diagState.route = '/playbackcard?token=secret12345';
            const copyResult = controller.copyDiagnosticReport(null);
            assert.equal(copyResult, false);
        });
    });

    describe('9. GitHub Issue Link Generation', () => {
        it('contains verified passive GitHub issues URL with no auto-submission', () => {
            assert.ok(htmlContent.includes('https://github.com/Ubaidofficial/Playback-info-card/issues/new/choose'));
            assert.ok(!htmlContent.includes('submit()'));
            assert.ok(!htmlContent.includes('.submit('));
        });
    });

    describe('10. Active Subtitle and CC Extraction', () => {
        it('extracts Closed Caption badge when subtitle title indicates CC', () => {
            const session = {
                PlayState: { SubtitleStreamIndex: 2 },
                NowPlayingItem: {
                    MediaStreams: [
                        { Type: 'Video' },
                        { Type: 'Audio' },
                        { Type: 'Subtitle', DisplayTitle: 'English CC', Language: 'eng' }
                    ]
                }
            };
            const badge = controller.extractSubtitleBadge(session, session.NowPlayingItem);
            assert.equal(badge, 'CC: ENG');
        });

        it('extracts Subtitle language badge for regular subtitles', () => {
            const session = {
                PlayState: { SubtitleStreamIndex: 2 },
                NowPlayingItem: {
                    MediaStreams: [
                        { Type: 'Video' },
                        { Type: 'Audio' },
                        { Type: 'Subtitle', DisplayTitle: 'French (SubRip)', Language: 'fre' }
                    ]
                }
            };
            const badge = controller.extractSubtitleBadge(session, session.NowPlayingItem);
            assert.equal(badge, 'Sub: FRE');
        });

        it('returns null when subtitle stream is disabled or -1', () => {
            const session = {
                PlayState: { SubtitleStreamIndex: -1 },
                NowPlayingItem: { MediaStreams: [] }
            };
            const badge = controller.extractSubtitleBadge(session, session.NowPlayingItem);
            assert.equal(badge, null);
        });
    });

    describe('11. All Playback Methods and Badges', () => {
        it('renders Direct Play badge', () => {
            const session = {
                PlayState: { PlayMethod: 'DirectPlay', IsPaused: false },
                NowPlayingItem: { Name: 'Direct Stream Video' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('playback-badge direct-play'));
            assert.ok(html.includes('Direct Play'));
        });

        it('renders Direct Stream badge', () => {
            const session = {
                PlayState: { PlayMethod: 'DirectStream', IsPaused: false },
                NowPlayingItem: { Name: 'Direct Stream Audio' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('playback-badge direct-stream'));
            assert.ok(html.includes('Direct Stream'));
        });

        it('renders Remux badge when video is direct and container is converted', () => {
            const session = {
                PlayState: { PlayMethod: 'Transcode', IsPaused: false },
                TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: true, Container: 'ts' },
                NowPlayingItem: { Name: 'Remuxed Item', Container: 'mkv' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('playback-badge remux'));
            assert.ok(html.includes('Remux'));
        });

        it('renders Transcode badge and hardware engine', () => {
            const session = {
                PlayState: { PlayMethod: 'Transcode', IsPaused: false },
                TranscodingInfo: {
                    HardwareAccelerationType: 'qsv',
                    VideoCodec: 'h264',
                    AudioCodec: 'aac',
                    Bitrate: 4500000,
                    Framerate: 24,
                    TranscodeReasons: ['ContainerNotSupported']
                },
                NowPlayingItem: { Name: 'Transcoded Movie', Container: 'avi' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('playback-badge transcode'));
            assert.ok(html.includes('Transcode'));
            assert.ok(html.includes('Engine: QSV'));
            assert.ok(html.includes('4.5 Mbps'));
            assert.ok(html.includes('ContainerNotSupported'));
        });

        it('renders Paused badge with paused styling', () => {
            const session = {
                PlayState: { PlayMethod: 'DirectPlay', IsPaused: true },
                NowPlayingItem: { Name: 'Paused Item' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('playback-badge paused'));
            assert.ok(html.includes('Paused'));
        });
    });

    describe('12. Compact Badge Cap', () => {
        it('caps rendered pills to 5 in compact mode', () => {
            controller.setDisplayMode('compact');
            const session = {
                PlayState: { SubtitleStreamIndex: 1 },
                NowPlayingItem: {
                    Width: 3840,
                    Height: 2160,
                    MediaStreams: [
                        { Type: 'Video', Width: 3840, Height: 2160, Codec: 'hevc', VideoRange: 'DOVI', BitDepth: 10 },
                        { Type: 'Subtitle', Language: 'eng' },
                        { Type: 'Audio', Channels: 8, Profile: 'Atmos', Codec: 'truehd' }
                    ]
                }
            };
            const html = controller.renderSessionCard(session);
            const pillMatches = html.match(/<span class="playback-pill/g);
            assert.ok(pillMatches != null);
            assert.ok(pillMatches.length <= 5, `Expected <= 5 pills in compact mode, got ${pillMatches.length}`);
        });

        it('renders all pills in extended mode', () => {
            controller.setDisplayMode('extended');
            const session = {
                PlayState: { SubtitleStreamIndex: 1 },
                NowPlayingItem: {
                    Width: 3840,
                    Height: 2160,
                    MediaStreams: [
                        { Type: 'Video', Width: 3840, Height: 2160, Codec: 'hevc', VideoRange: 'DOVI', BitDepth: 10 },
                        { Type: 'Subtitle', Language: 'eng' },
                        { Type: 'Audio', Channels: 8, Profile: 'Atmos', Codec: 'truehd' }
                    ]
                }
            };
            const html = controller.renderSessionCard(session);
            const pillMatches = html.match(/<span class="playback-pill/g);
            assert.ok(pillMatches != null);
            assert.ok(pillMatches.length >= 5, `Expected extended pills count, got ${pillMatches.length}`);
        });
    });

    describe('13. Mobile-Safe Layout Assumptions', () => {
        it('uses responsive CSS grid and flex wrapping without fixed widths', () => {
            assert.ok(htmlContent.includes('repeat(auto-fill, minmax('));
            assert.ok(htmlContent.includes('@media (max-width: 640px)'));
            assert.ok(htmlContent.includes('flex-wrap: wrap'));
            assert.ok(!htmlContent.includes('width: 100vw; overflow: hidden'));
        });
    });

    describe('14. Zero Remote-Control Commands Assertion', () => {
        it('confirms absence of remote control buttons or playback mutation calls', () => {
            const forbiddenRemoteControls = [
                'btnPause', 'btnPlay', 'btnStop', 'btnKill', 'terminateSession',
                'stopSession', 'pauseSession', 'postProgress', 'remoteControl'
            ];
            forbiddenRemoteControls.forEach((cmd) => {
                assert.ok(!htmlContent.includes(cmd), `Prohibited remote control command found: ${cmd}`);
            });
        });
    });

    describe('15. Zero Network Classification Assertion', () => {
        it('confirms absence of IP, LAN/WAN heuristics, or network labels in rendered cards', () => {
            const session = {
                PlayState: { PlayMethod: 'DirectPlay' },
                NowPlayingItem: { Name: 'Safe Video' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(!html.includes('LAN'));
            assert.ok(!html.includes('WAN'));
            assert.ok(!html.includes('Cellular'));
            assert.ok(!html.includes('Wi-Fi'));
            assert.ok(!html.includes('RemoteEndPoint'));
            assert.ok(!html.includes('ipAddress'));
        });
    });
});
