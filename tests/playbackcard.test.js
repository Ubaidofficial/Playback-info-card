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

describe('Playback Info Card v0.2.6.0 Test Suite', () => {
    let controller;

    beforeEach(() => {
        controller = createMockController();
    });

    describe('1. Diagnostics Panel States', () => {
        it('initializes with default waiting state and version 0.2.6.0', () => {
            assert.equal(controller.version, '0.2.6.0');
            assert.equal(controller.diagState.pluginVersion, '0.2.6.0');
            assert.equal(controller.diagState.sessionsApiStatus, 'Waiting for sessions');
            assert.equal(controller.diagState.pollingState, 'active');
            assert.equal(controller.diagState.lastErrorCategory, 'OK');
        });

        it('builds diagnostic reports reflecting whatever sessionsApiStatus the poll last set', () => {
            // buildDiagnosticReport() is the real code under test -- this only checks that
            // its output tracks diagState, not that diagState itself can be assigned to.
            controller.diagState.sessionsApiStatus = 'OK';
            assert.equal(controller.buildDiagnosticReport().sessionsApi, 'ok');

            controller.diagState.sessionsApiStatus = 'Sessions unavailable';
            controller.diagState.lastErrorCategory = 'Sessions unavailable';
            assert.equal(controller.buildDiagnosticReport().sessionsApi, 'error');
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
        // These exercise the real updateDiagnosticsDisplay() staleness check (STALE_THRESHOLD_MS,
        // exported for testing), not a copy of the threshold logic re-implemented in the test.
        it('identifies stalled polling when interval exceeds the real STALE_THRESHOLD_MS', () => {
            controller.setActivePageForTesting({ querySelector: () => null });
            const now = Date.now();
            controller.diagState.pollingState = 'active';
            controller.diagState.lastSuccessTime = now - (controller.STALE_THRESHOLD_MS + 1000);

            controller.updateDiagnosticsDisplay();

            assert.equal(controller.diagState.pollingState, 'stalled', 'Real staleness check must flip pollingState to stalled');
            assert.equal(controller.diagState.lastErrorCategory, 'Polling stalled');
        });

        it('recovers from stalled state once a fresh poll lands within STALE_THRESHOLD_MS', () => {
            controller.setActivePageForTesting({ querySelector: () => null });
            controller.diagState.pollingState = 'stalled';
            controller.diagState.lastSuccessTime = Date.now();

            controller.updateDiagnosticsDisplay();

            assert.equal(controller.diagState.pollingState, 'active', 'Real recovery check must flip pollingState back to active');
        });

        it('does NOT flag staleness when the last successful poll is within the threshold', () => {
            controller.setActivePageForTesting({ querySelector: () => null });
            controller.diagState.pollingState = 'active';
            controller.diagState.lastSuccessTime = Date.now() - 1000;

            controller.updateDiagnosticsDisplay();

            assert.equal(controller.diagState.pollingState, 'active', 'Must not falsely mark a healthy poll as stalled');
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

            assert.equal(report.pluginVersion, '0.2.6.0');
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
                pluginVersion: '0.2.6.0',
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

        it('validates allow-listed keys and rejects unexpected or malicious fields', () => {
            const validReport = controller.buildDiagnosticReport();
            assert.equal(controller.validateDiagnosticReport(validReport), true);

            // Report with extra unauthorized property
            const extraPropReport = { ...validReport, unauthorizedToken: 'secret' };
            assert.equal(controller.validateDiagnosticReport(extraPropReport), false);

            // Report with missing required property
            const missingPropReport = { ...validReport };
            delete missingPropReport.pluginVersion;
            assert.equal(controller.validateDiagnosticReport(missingPropReport), false);

            // Report with route containing query string or token
            const queryRouteReport = { ...validReport, route: '/playbackcard?api_key=123' };
            assert.equal(controller.validateDiagnosticReport(queryRouteReport), false);

            // Report with route containing full URL
            const urlRouteReport = { ...validReport, route: 'https://evil.com//playbackcard' };
            assert.equal(controller.validateDiagnosticReport(urlRouteReport), false);

            // Report with invalid sessionsApi status
            const invalidApiReport = { ...validReport, sessionsApi: 'hacked' };
            assert.equal(controller.validateDiagnosticReport(invalidApiReport), false);
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
            assert.ok(html.includes('Container not supported'));
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

    describe('14. Admin-Only Session Controls (Stop / Message)', () => {
        // Superseded the plugin's original "zero remote-control surface" invariant --
        // a deliberate, later policy change, not an oversight. Stop/Message now exist,
        // but only for admins, only via Jellyfin's own native Session API (never a custom
        // mutation), and Stop always confirms first since it's disruptive to a real session.
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardSource = fs.readFileSync(dashboardJsPath, 'utf8');

        function createMockDashboard(confirmReturns = true) {
            const mockModule = { exports: {} };
            const calls = { sendPlayStateCommand: [], sendMessageCommand: [] };
            const fakeApiClient = {
                sendPlayStateCommand: (...args) => { calls.sendPlayStateCommand.push(args); return Promise.resolve(); },
                sendMessageCommand: (...args) => { calls.sendMessageCommand.push(args); return Promise.resolve(); }
            };
            const mockWindow = {
                location: { hash: '#/dashboard', pathname: '/dashboard' },
                ApiClient: fakeApiClient,
                confirm: () => confirmReturns,
                prompt: () => 'Hello from admin'
            };
            const runner = new Function('module', 'exports', 'window', 'globalThis', dashboardSource);
            runner(mockModule, mockModule.exports, mockWindow, mockWindow);
            return { controller: mockModule.exports, calls };
        }

        it('renders Stop and Message buttons for an admin, scoped to that session id', () => {
            const { controller: dash } = createMockDashboard();
            const session = { Id: 'sess-1', NowPlayingItem: { Name: 'Movie' } };
            const html = dash.renderSessionCard(session, 0, 'compact', false);
            assert.ok(html.includes('data-action="stop-session"'));
            assert.ok(html.includes('data-action="send-message"'));
            assert.ok(html.includes('data-session-id="sess-1"'));
        });

        it('hides Stop/Message entirely for a non-admin (My Playback self-view)', () => {
            const { controller: dash } = createMockDashboard();
            dash.state.isNonAdmin = true;
            const session = { Id: 'sess-1', NowPlayingItem: { Name: 'Movie' } };
            const html = dash.renderSessionCard(session, 0, 'compact', false);
            assert.ok(!html.includes('data-action="stop-session"'));
            assert.ok(!html.includes('data-action="send-message"'));
        });

        it('only calls the Session API through the shared ApiClient -- never a custom mutation endpoint', () => {
            assert.ok(dashboardSource.includes('sendPlayStateCommand'));
            assert.ok(dashboardSource.includes('sendMessageCommand'));
            assert.ok(!dashboardSource.includes('PlaybackCard/Self/Sessions/Stop'));
            assert.ok(!dashboardSource.includes('terminateSession'));
        });

        it('playbackcard.html carries the same admin-gated Stop/Message wiring', () => {
            assert.ok(htmlContent.includes('currentUserIsAdmin'), 'Gated by the standalone page\'s own admin flag');
            assert.ok(htmlContent.includes('data-action="stop-session"'));
            assert.ok(htmlContent.includes('data-action="send-message"'));
            assert.ok(htmlContent.includes('sendPlayStateCommand') && htmlContent.includes('sendMessageCommand'));
        });

        it('Stop is gated behind the custom confirm modal (not a bare click-to-fire), flagged as a destructive action', () => {
            const clickHandlerStart = dashboardSource.indexOf('attachContainerEvents');
            const stopHandlerStart = dashboardSource.indexOf("data-action=\"stop-session\"", clickHandlerStart);
            const modalCallIdx = dashboardSource.indexOf('showActionModal(', stopHandlerStart);
            const dangerIdx = dashboardSource.indexOf("confirmVariant: 'danger'", stopHandlerStart);
            const apiCallIdx = dashboardSource.indexOf('sendPlayStateCommand(', stopHandlerStart);
            assert.ok(modalCallIdx > -1 && apiCallIdx > -1, 'Both the modal call and the API call must exist in the Stop handler');
            assert.ok(modalCallIdx < apiCallIdx, 'The modal must be shown before sendPlayStateCommand is ever called (API call lives inside onConfirm)');
            assert.ok(dangerIdx > -1 && dangerIdx < apiCallIdx, 'Stop must be flagged as the destructive ("danger") modal variant');
        });

        it('the custom modal replaces native confirm()/prompt() -- no bare OS dialogs for these actions', () => {
            assert.ok(dashboardSource.includes('function showActionModal'));
            assert.ok(dashboardSource.includes('pi-modal-scrim'));
            assert.ok(!/[^.\w]window\.confirm\(|[^.\w]global\.confirm\(/.test(dashboardSource));
            assert.ok(!/[^.\w]window\.prompt\(|[^.\w]global\.prompt\(/.test(dashboardSource));
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

    describe('16. Notification Delivery Diagnostics and Controller Integration', () => {
        it('includes all 12 notification diagnostic fields in buildDiagnosticReport', () => {
            const report = controller.buildDiagnosticReport();
            assert.equal(typeof report.notificationsEnabled, 'boolean');
            assert.equal(typeof report.discordEnabled, 'boolean');
            assert.equal(typeof report.telegramEnabled, 'boolean');
            assert.equal(typeof report.notificationQueueDepth, 'number');
            assert.equal(typeof report.notificationDroppedProgress, 'number');
            assert.equal(typeof report.notificationDedupeCount, 'number');
            assert.equal(typeof report.notificationRetryCount, 'number');
            assert.equal(typeof report.notificationLastAttempt, 'string');
            assert.equal(typeof report.notificationLastSuccess, 'string');
            assert.equal(typeof report.notificationLastFailureCategory, 'string');
            assert.equal(typeof report.discordAvailability, 'string');
            assert.equal(typeof report.telegramAvailability, 'string');
            assert.equal(typeof report.notificationQueueCapacity, 'number');
            assert.equal(typeof report.notificationDroppedCritical, 'number');
            assert.equal(typeof report.notificationCoalescedProgress, 'number');
            assert.equal(typeof report.notificationRateLimitDrops, 'number');
            assert.equal(typeof report.notificationValidationFailures, 'number');
            assert.equal(typeof report.notificationWorkerState, 'string');
            assert.equal(typeof report.notificationLastHttpStatus, 'number');
        });

        it('validates report with notification diagnostics and rejects invalid types', () => {
            const validReport = controller.buildDiagnosticReport();
            assert.equal(controller.validateDiagnosticReport(validReport), true);

            // Negative queue depth rejected
            const badQueueReport = { ...validReport, notificationQueueDepth: -1 };
            assert.equal(controller.validateDiagnosticReport(badQueueReport), false);

            // Non-boolean notification state rejected
            const badEnabledReport = { ...validReport, notificationsEnabled: 'yes' };
            assert.equal(controller.validateDiagnosticReport(badEnabledReport), false);
        });

        it('detects sensitive webhook URLs or bot tokens in sensitive data check', () => {
            const webhookWithToken = 'https://discord.com/api/webhooks/123456789/abcdefghijk_token_here';
            const botToken = 'token: 123456789:ABCDefGhIjKlMnOpQrStUvWxYz';
            assert.equal(controller.checkSensitiveData(webhookWithToken), true);
            assert.equal(controller.checkSensitiveData(botToken), true);
        });

        it('exports notification helper functions on controller', () => {
            assert.equal(typeof controller.loadNotificationSettings, 'function');
            assert.equal(typeof controller.saveNotificationSettings, 'function');
            assert.equal(typeof controller.clearNotificationSecret, 'function');
            assert.equal(typeof controller.sendTestNotification, 'function');
            assert.equal(typeof controller.fetchNotificationDiagnostics, 'function');
        });

        it('strictly targets PlaybackCard/Notifications routes and avoids PlaybackInfoCard mismatch', () => {
            assert.ok(htmlContent.includes("'PlaybackCard/Notifications/Configuration'"));
            assert.ok(htmlContent.includes("'PlaybackCard/Notifications/Test'"));
            assert.ok(htmlContent.includes("'PlaybackCard/Notifications/Diagnostics'"));
            assert.ok(!htmlContent.includes('PlaybackInfoCard/Notifications/'));
        });

        it('initializes diagState with default notifications state structure', () => {
            assert.ok(controller.diagState.notifications);
            assert.equal(typeof controller.diagState.notifications.enabled, 'boolean');
            assert.equal(typeof controller.diagState.notifications.discordEnabled, 'boolean');
            assert.equal(typeof controller.diagState.notifications.telegramEnabled, 'boolean');
        });

        it('contains clear feedback message when notifications remain disabled after saving a destination', () => {
            assert.ok(htmlContent.includes('Settings saved. Notifications remain disabled until the Master Switch is enabled.'));
        });

        it('ensures saving telegram or discord does not force-enable the master switch', () => {
            // Verify source code does not contain chkMaster.checked = true inside discord or telegram sections
            const discordSectionMatch = htmlContent.match(/else if \(section === 'discord'\) {([\s\S]*?)} else if/);
            assert.ok(discordSectionMatch);
            assert.ok(!discordSectionMatch[1].includes('chkMaster.checked = true'));
            assert.ok(!discordSectionMatch[1].includes('payload.notificationsEnabled = true'));

            const telegramSectionMatch = htmlContent.match(/else if \(section === 'telegram'\) {([\s\S]*?)} else if/);
            assert.ok(telegramSectionMatch);
            assert.ok(!telegramSectionMatch[1].includes('chkMaster.checked = true'));
            assert.ok(!telegramSectionMatch[1].includes('payload.notificationsEnabled = true'));
        });
    });

    describe('17. Stream Details, Info Toggle, and My Playback View', () => {
        it('renders accessible [Info] toggle button with aria-expanded and aria-controls using deterministic card ID', () => {
            const session = {
                PlayState: { PlayMethod: 'DirectPlay', IsPaused: false },
                NowPlayingItem: { Name: 'Sample Item' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('class="playback-btn-info"'));
            assert.ok(html.includes('aria-expanded="false"'));
            assert.ok(html.includes('aria-controls="details-card-1"'));
            assert.ok(html.includes('id="details-card-1"'));
            assert.ok(html.includes('data-card-id="card-1"'));
            assert.ok(!html.includes('data-session-id'));
        });

        it('renders Video and Audio status badges (Direct vs Transcode)', () => {
            const directSession = {
                Id: 's-dir',
                PlayState: { PlayMethod: 'DirectPlay' },
                NowPlayingItem: { Name: 'Direct Stream' }
            };
            const directHtml = controller.renderSessionCard(directSession);
            assert.ok(directHtml.includes('stream-badge video-direct'));
            assert.ok(directHtml.includes('Video: Direct'));
            assert.ok(directHtml.includes('stream-badge audio-direct'));
            assert.ok(directHtml.includes('Audio: Direct'));

            const transcodeSession = {
                Id: 's-trans',
                PlayState: { PlayMethod: 'Transcode' },
                TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true },
                NowPlayingItem: { Name: 'Transcoded Stream' }
            };
            const transHtml = controller.renderSessionCard(transcodeSession);
            assert.ok(transHtml.includes('stream-badge video-transcode'));
            assert.ok(transHtml.includes('Video: Transcode'));
            assert.ok(transHtml.includes('stream-badge audio-direct'));
            assert.ok(transHtml.includes('Audio: Direct'));
        });

        it('renders truthful Why and How transcode metadata', () => {
            const session = {
                Id: 's-whyhow',
                PlayState: { PlayMethod: 'Transcode' },
                TranscodingInfo: {
                    HardwareAccelerationType: 'nvenc',
                    VideoCodec: 'h264',
                    AudioCodec: 'aac',
                    Bitrate: 8000000,
                    Framerate: 60,
                    TranscodeReasons: ['ContainerNotSupported', 'VideoCodecNotSupported']
                },
                NowPlayingItem: { Name: 'Why How Test', Container: 'mkv' }
            };
            const html = controller.renderSessionCard(session);
            assert.ok(html.includes('Engine: NVENC'));
            assert.ok(html.includes('Video: H264'));
            assert.ok(html.includes('Audio: AAC'));
            assert.ok(html.includes('Container not supported'));
            assert.ok(html.includes('Video codec not supported'));
        });

        it('renders UserPlaybackSessionDto from personal sessions endpoint cleanly', () => {
            const userDto = {
                MediaTitle: 'User Personal Movie',
                SeriesName: null,
                PlayMethod: 'DirectPlay',
                IsPaused: false,
                PlaybackPercentage: 45,
                IsVideoDirect: true,
                IsAudioDirect: true,
                VideoStatus: 'Video Direct',
                AudioStatus: 'Audio Direct'
            };
            const html = controller.renderSessionCard(userDto);
            assert.ok(html.includes('User Personal Movie'));
            assert.ok(html.includes('My Session'));
            assert.ok(html.includes('stream-badge video-direct'));
            assert.ok(html.includes('Video: Direct'));
        });

        it('keeps the Info panel open across a simulated poll re-render (tracked by session ID, not card position)', () => {
            const session = { Id: 'monitor-persist-1', PlayState: { PlayMethod: 'DirectPlay' }, NowPlayingItem: { Name: 'Long Movie' } };

            // Baseline: closed by default in compact mode.
            controller.prepareRenderPass([session]);
            const closedHtml = controller.renderSessionCard(session, 0);
            assert.ok(closedHtml.includes('aria-expanded="false"'), 'Info panel starts closed');

            // Simulate the user clicking Info (this is what the real click handler does).
            controller.openInfoSessionIds['monitor-persist-1'] = true;

            // Simulate a poll re-render (a fresh prepareRenderPass + renderSessionCard pass,
            // exactly like fetchSessions() rebuilding the grid from scratch every 3s).
            controller.prepareRenderPass([session]);
            const reopenedHtml = controller.renderSessionCard(session, 0);
            assert.ok(reopenedHtml.includes('aria-expanded="true"'), 'Info panel survives a poll re-render instead of silently closing');
            assert.ok(reopenedHtml.includes('class="playback-details-panel open"'), 'Details panel carries the open class');

            // Once the session disappears (stream ended), prepareRenderPass must prune the
            // stale open-state entry so it can never leak onto an unrelated future session
            // that happens to reuse the same card position.
            controller.prepareRenderPass([]);
            assert.ok(!controller.openInfoSessionIds['monitor-persist-1'], 'Open-info state is pruned once its session is gone');
        });

        it('mirrors the v0.2.5.3 additions on this page too (ETA, Atmos, audio language, subtitle delivery method, avatar)', () => {
            const session = {
                Id: 'monitor-additions-1', UserId: 'u-1', UserName: 'X',
                PlayState: { IsPaused: false, SubtitleStreamIndex: 2 },
                PositionTicks: 0, RunTimeTicks: 3600 * 10000000,
                NowPlayingItem: {
                    Name: 'X', MediaStreams: [
                        { Type: 'Audio', Channels: 8, Language: 'eng', Profile: 'Atmos', Codec: 'truehd' },
                        { Type: 'Subtitle', Index: 2, Language: 'eng', Codec: 'srt', DeliveryMethod: 'Encode' }
                    ]
                }
            };
            const html = controller.renderSessionCard(session, 0);
            assert.ok(html.includes('playback-eta'), 'ETA renders on this page too');
            assert.ok(html.includes('Atmos'), 'Atmos badge renders');
            assert.ok(html.includes('ENG'), 'Audio language enriches the channel-layout field');
            assert.ok(html.includes('Burned into video (forces transcode)'), 'Subtitle delivery method is surfaced');
            assert.equal(controller.resolveUserAvatarUrl(session, { getUserImageUrl: (id) => '/u/' + id }), '/u/u-1');
        });
    });

    describe('18. Primary Dashboard Integration (v0.2.5.3)', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');

        function createMockDashboard(env = {}) {
            const mockModule = { exports: {} };
            const mockWindow = {
                location: { hash: '#/dashboard', pathname: '/web/index.html' },
                addEventListener: () => {},
                removeEventListener: () => {},
                setInterval: () => 123,
                clearInterval: () => {},
                ...env.window
            };
            const mockDocument = {
                getElementById: (id) => null,
                querySelector: (sel) => null,
                querySelectorAll: (sel) => [],
                createElement: (tag) => ({
                    id: '',
                    tagName: tag.toUpperCase(),
                    style: {},
                    classList: { contains: () => false, add: () => {}, remove: () => {} },
                    setAttribute: () => {},
                    getAttribute: () => null,
                    appendChild: () => {},
                    insertBefore: () => {}
                }),
                addEventListener: () => {},
                removeEventListener: () => {},
                readyState: 'complete',
                ...env.document
            };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }

        it('initializes with version 0.2.6.0', () => {
            const dash = createMockDashboard();
            assert.equal(dash.version, '0.2.6.0');
            assert.equal(dash.state.version, '0.2.6.0');
            assert.equal(dash.state.displayMode, 'compact');
        });

        it('identifies Dashboard and Devices views autonomously without opening plugin settings', () => {
            const dashDashboard = createMockDashboard({
                window: { location: { hash: '#/dashboard', pathname: '/web/index.html' } }
            });
            assert.equal(dashDashboard.isDashboardPage(), true);

            const dashDevices = createMockDashboard({
                window: { location: { hash: '#/devices', pathname: '/web/index.html' } }
            });
            assert.equal(dashDevices.isDashboardPage(), true);

            const dashSettings = createMockDashboard({
                window: { location: { hash: '#/settings/plugins', pathname: '/web/index.html' } }
            });
            assert.equal(dashSettings.isDashboardPage(), false);
        });

        it('completely replaces the stock Devices section with NOW PLAYING and removes stock Devices from DOM', () => {
            let insertBeforeCalled = false;
            let removeChildCalled = false;
            let removedNode = null;
            let insertedNode = null;

            const stockDevicesElement = {
                id: 'activeDevices',
                className: 'activeDevices section',
                style: { display: 'block' },
                parentNode: null
            };

            const parent = {
                insertBefore: (newNode, refNode) => {
                    insertBeforeCalled = true;
                    insertedNode = newNode;
                    newNode.parentNode = parent;
                },
                removeChild: (childNode) => {
                    removeChildCalled = true;
                    removedNode = childNode;
                    childNode.parentNode = null;
                }
            };
            stockDevicesElement.parentNode = parent;

            const mockDoc = {
                getElementById: (id) => null,
                querySelector: (sel) => (sel.includes('.activeDevices') || sel.includes('#activeDevices') ? stockDevicesElement : null),
                querySelectorAll: () => [],
                createElement: (tag) => ({
                    id: '',
                    setAttribute: () => {},
                    getAttribute: () => null,
                    addEventListener: () => {}
                }),
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const container = dash.ensureContainerInserted();

            assert.ok(container, 'NOW PLAYING container must be created');
            assert.equal(container.id, 'playback-card-nowplaying-container');
            assert.equal(insertBeforeCalled, true, 'Container must be mounted in Devices location');
            assert.strictEqual(insertedNode, container, 'Mounted node must be the NOW PLAYING container');
            assert.equal(removeChildCalled, true, 'Stock Devices section must be removed from the DOM');
            assert.strictEqual(removedNode, stockDevicesElement, 'Removed node must be the stock Devices element');
            assert.equal(stockDevicesElement.style.display, 'none', 'Stock Devices element style must be hidden');
            assert.equal(stockDevicesElement.parentNode, null, 'Stock Devices element must have null parentNode after removal');
        });

        it('does not create duplicate NOW PLAYING containers during repeated calls or SPA navigation', () => {
            let createdCount = 0;
            let existingContainer = null;

            const stockDevices = {
                id: 'activeDevices',
                className: 'activeDevices',
                style: { display: 'block' },
                parentNode: {
                    insertBefore: (newNode) => { newNode.parentNode = stockDevices.parentNode; },
                    removeChild: (childNode) => { childNode.parentNode = null; }
                }
            };

            const mockDoc = {
                getElementById: (id) => (id === 'playback-card-nowplaying-container' ? existingContainer : null),
                querySelector: (sel) => (stockDevices.parentNode ? stockDevices : null),
                querySelectorAll: () => [],
                createElement: (tag) => {
                    createdCount++;
                    existingContainer = {
                        id: '',
                        setAttribute: () => {},
                        getAttribute: () => null,
                        addEventListener: () => {}
                    };
                    return existingContainer;
                },
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const container1 = dash.ensureContainerInserted();
            assert.ok(container1, 'First container created and mounted');
            assert.equal(createdCount, 1);

            // Second call: existing container is returned without creating another
            const container2 = dash.ensureContainerInserted();
            assert.strictEqual(container2, container1, 'Must return same container singleton');
            assert.equal(createdCount, 1, 'No duplicate container element created');
        });

        it('detects and replaces modern Jellyfin 12.1 React/MUI DevicesWidget in-place', () => {
            let insertBeforeCalled = false;
            let removeChildCalled = false;
            let insertedBeforeRef = null;

            const leftColumnStack = {
                className: 'MuiStack-root css-column',
                parentElement: null,
                children: []
            };

            const serverInfoWidget = {
                className: 'MuiBox-root',
                parentElement: leftColumnStack,
                parentNode: leftColumnStack
            };

            const devicesWidgetBox = {
                className: 'MuiBox-root css-devices-widget',
                parentElement: leftColumnStack,
                parentNode: leftColumnStack,
                style: { display: 'block' },
                querySelector: () => null,
                querySelectorAll: () => []
            };

            const devicesButtonLink = {
                tagName: 'A',
                href: '/dashboard/devices',
                className: 'MuiButtonBase-root MuiButton-root MuiButton-text',
                parentElement: devicesWidgetBox,
                parentNode: devicesWidgetBox,
                closest: () => null
            };

            leftColumnStack.children = [serverInfoWidget, devicesWidgetBox];
            leftColumnStack.insertBefore = (newNode, refNode) => {
                insertBeforeCalled = true;
                insertedBeforeRef = refNode;
                newNode.parentNode = leftColumnStack;
            };
            leftColumnStack.removeChild = (childNode) => {
                removeChildCalled = true;
                childNode.parentNode = null;
            };

            const mockDoc = {
                getElementById: (id) => null,
                querySelector: (sel) => null,
                querySelectorAll: (sel) => {
                    if (sel.includes('dashboard/devices')) {
                        return [devicesButtonLink];
                    }
                    return [];
                },
                createElement: (tag) => ({
                    id: '',
                    setAttribute: () => {},
                    getAttribute: () => null,
                    addEventListener: () => {}
                }),
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const container = dash.ensureContainerInserted();

            assert.ok(container, 'Container mounted');
            assert.equal(insertBeforeCalled, true, 'Container inserted into left column Stack');
            assert.strictEqual(insertedBeforeRef, devicesWidgetBox, 'Inserted before DevicesWidget in-place');
            assert.equal(removeChildCalled, true, 'Stock 12.1 DevicesWidget removed from DOM');
            assert.equal(devicesWidgetBox.style.display, 'none', 'Stock 12.1 DevicesWidget display set to none');
            assert.equal(devicesWidgetBox.parentNode, null, 'Stock 12.1 DevicesWidget unparented');
        });

        it('strictly excludes navigation drawer/sidebar items and finds the real Devices widget inside main', () => {
            let replacedInMain = false;

            const navDrawer = {
                tagName: 'NAV',
                className: 'MuiDrawer-root',
                closest: (sel) => (sel.includes('.MuiDrawer-root') || sel.includes('nav') ? navDrawer : null)
            };

            const drawerDevicesLink = {
                tagName: 'A',
                href: '/dashboard/devices',
                className: 'MuiListItemButton-root',
                parentElement: navDrawer,
                parentNode: navDrawer,
                closest: (sel) => (sel.includes('.MuiDrawer-root') || sel.includes('nav') ? navDrawer : null)
            };

            const mainLayoutStack = {
                tagName: 'DIV',
                className: 'MuiStack-root',
                children: []
            };

            const realDevicesWidget = {
                tagName: 'DIV',
                className: 'MuiBox-root stock-devices-box',
                parentElement: mainLayoutStack,
                parentNode: mainLayoutStack,
                style: { display: 'block' },
                closest: () => null,
                querySelectorAll: () => []
            };

            const realHeading = {
                tagName: 'H2',
                textContent: 'Devices',
                parentElement: realDevicesWidget,
                parentNode: realDevicesWidget,
                closest: () => null
            };

            mainLayoutStack.children = [realDevicesWidget];
            mainLayoutStack.insertBefore = (newNode, refNode) => {
                if (refNode === realDevicesWidget) {
                    replacedInMain = true;
                    newNode.parentNode = mainLayoutStack;
                }
            };
            mainLayoutStack.removeChild = (child) => {
                child.parentNode = null;
            };

            const mockDoc = {
                getElementById: (id) => null,
                querySelector: () => null,
                querySelectorAll: (sel) => {
                    if (sel.includes('Typography') || sel.includes('h2') || sel.includes('sectionTitle')) {
                        return [
                            {
                                textContent: 'Devices',
                                closest: (s) => (s.includes('MuiDrawer') ? navDrawer : null)
                            },
                            realHeading
                        ];
                    }
                    if (sel.includes('dashboard/devices')) {
                        return [drawerDevicesLink];
                    }
                    return [];
                },
                createElement: (tag) => ({ id: '', setAttribute: () => {}, addEventListener: () => {} }),
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const container = dash.ensureContainerInserted();

            assert.ok(container, 'Container must be created');
            assert.equal(replacedInMain, true, 'Must replace real Devices widget inside main, ignoring navigation drawer');
            assert.equal(realDevicesWidget.style.display, 'none');
            assert.equal(realDevicesWidget.parentNode, null);
        });

        it('NEVER mounts at the top of the dashboard or falls back to mainContent.firstChild when Devices block is not found', () => {
            let insertedAtTop = false;
            let appendedToMain = false;

            const mainContent = {
                firstChild: { id: 'some-top-widget' },
                insertBefore: () => { insertedAtTop = true; },
                appendChild: () => { appendedToMain = true; }
            };

            const mockDoc = {
                getElementById: () => null,
                querySelector: (sel) => (sel.includes('.content-primary') ? mainContent : null),
                querySelectorAll: () => [],
                createElement: () => ({ id: '' }),
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const result = dash.ensureContainerInserted();

            assert.strictEqual(result, null, 'Must return null when devices section is not found yet');
            assert.equal(insertedAtTop, false, 'MUST NOT mount at the top of the dashboard');
            assert.equal(appendedToMain, false, 'MUST NOT append to main content without devices section');
        });

        it('survives Jellyfin DOM rerenders and replaces stock Devices when re-rendered', () => {
            let removeChildCalled = false;
            let removedNode = null;

            const existingContainer = {
                id: 'playback-card-nowplaying-container',
                parentNode: { insertBefore: () => {}, removeChild: () => {} }
            };

            const newlyRerenderedDevices = {
                id: 'activeDevices',
                className: 'activeDevices',
                style: { display: 'block' },
                parentNode: {
                    insertBefore: (newNode, refNode) => {
                        newNode.parentNode = newlyRerenderedDevices.parentNode;
                    },
                    removeChild: (childNode) => {
                        removeChildCalled = true;
                        removedNode = childNode;
                        childNode.parentNode = null;
                    }
                }
            };

            const mockDoc = {
                getElementById: (id) => (id === 'playback-card-nowplaying-container' ? existingContainer : null),
                querySelector: (sel) => (sel.includes('.activeDevices') ? newlyRerenderedDevices : null),
                querySelectorAll: () => [],
                createElement: () => ({ id: '' }),
                addEventListener: () => {}
            };

            const dash = createMockDashboard({ document: mockDoc });
            const container = dash.ensureContainerInserted();

            assert.strictEqual(container, existingContainer, 'Must reuse existing container');
            assert.equal(removeChildCalled, true, 'Re-rendered stock devices must be removed');
            assert.strictEqual(removedNode, newlyRerenderedDevices, 'Removed element must be the re-rendered devices section');
            assert.equal(newlyRerenderedDevices.style.display, 'none');
        });

        it('renders empty state "No active playback" and preserves connected device visibility when no streams are playing', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };

            const connectedDevicesOnly = [
                {
                    Id: 'chrome-session-windows',
                    UserName: 'ServerAdmin',
                    Client: 'Jellyfin Web',
                    DeviceName: 'Chrome',
                    ApplicationVersion: '12.1.0',
                    LastActivityDate: new Date().toISOString(),
                    NowPlayingItem: null,
                    PlayState: null
                }
            ];

            dash.renderDashboardContainer(container, [], connectedDevicesOnly);

            // Empty playback state
            assert.ok(container.innerHTML.includes('No active playback'), 'Empty state must show exact text "No active playback"');
            assert.ok(!container.innerHTML.includes('No active playback streams currently on this server'), 'Old empty text removed');

            // Connected devices visibility
            assert.ok(container.innerHTML.includes('Connected Devices'), 'Must render Connected Devices section');
            assert.ok(container.innerHTML.includes('Chrome'), 'Renders device name Chrome');
            assert.ok(container.innerHTML.includes('Jellyfin Web'), 'Renders client name Jellyfin Web');
            assert.ok(container.innerHTML.includes('v12.1.0'), 'Renders application version v12.1.0');
            assert.ok(container.innerHTML.includes('ServerAdmin'), 'Renders connected user name');
            assert.ok(container.innerHTML.includes('Idle'), 'Renders Idle status for non-playing device');

            // Stock devices suppression
            assert.ok(!container.innerHTML.includes('activeDevices'), 'Stock devices table must not appear');
            assert.ok(!container.innerHTML.includes('devicesList'), 'Stock devices list must not appear');
        });

        it('renders both rich playback card and connected devices when active playback is running', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };

            const moonfinPlayingSession = {
                Id: 'moonfin-stream',
                UserName: 'LivingRoom',
                Client: 'Moonfin',
                DeviceName: 'Android TV',
                ApplicationVersion: '1.0.4',
                PlayMethod: 'DirectPlay',
                IsPaused: false,
                PositionTicks: 12000000000,
                RunTimeTicks: 72000000000,
                NowPlayingItem: {
                    Name: 'Interstellar',
                    ProductionYear: 2014,
                    Width: 3840,
                    Height: 2160,
                    Container: 'mkv'
                }
            };

            const chromeIdleSession = {
                Id: 'chrome-idle',
                UserName: 'WebUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome',
                ApplicationVersion: '12.1.0',
                LastActivityDate: new Date().toISOString(),
                NowPlayingItem: null
            };

            dash.renderDashboardContainer(container, [moonfinPlayingSession], [moonfinPlayingSession, chromeIdleSession]);

            // Now Playing area renders rich card
            assert.ok(container.innerHTML.includes('Interstellar'), 'Renders active playback title');
            assert.ok(container.innerHTML.includes('Moonfin &mdash; Android TV (v1.0.4)'), 'Renders Moonfin client & device');
            assert.ok(!container.innerHTML.includes('No active playback'), 'Empty state not shown when playback active');

            // Connected devices area renders both connected clients
            assert.ok(container.innerHTML.includes('Connected Devices'), 'Renders Connected Devices heading');
            assert.ok(container.innerHTML.includes('WebUser'), 'Renders connected Chrome user');
            assert.ok(container.innerHTML.includes('Playing: Interstellar'), 'Renders playing status badge');
        });

        it('enforces strict privacy in connected devices rendering (zero IP, token, or local path)', () => {
            const dash = createMockDashboard();
            const sessionWithSensitiveFields = {
                Id: 'priv-1',
                UserName: 'PrivateUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome',
                ApplicationVersion: '12.1.0',
                RemoteEndPoint: '192.168.1.100:54321',
                Token: 'secret-auth-token-xyz',
                LocalAddress: '10.0.0.5',
                ServerAddress: 'https://jellyfin.local:8096',
                Path: 'D:\\Media\\Movies\\Secret.mkv'
            };

            const html = dash.renderConnectedDeviceItem(sessionWithSensitiveFields);
            assert.ok(!html.includes('192.168.1.100'), 'Must not leak client IP');
            assert.ok(!html.includes('secret-auth-token'), 'Must not leak auth token');
            assert.ok(!html.includes('10.0.0.5'), 'Must not leak local IP');
            assert.ok(!html.includes('D:\\Media'), 'Must not leak filesystem path');
            assert.ok(html.includes('Chrome'), 'Device name is present');
            assert.ok(html.includes('PrivateUser'), 'User is present');
        });

        it('renders Moonfin Android TV session card with poster, client, device, badges, and Info toggle', () => {
            const dash = createMockDashboard();
            const moonfinSession = {
                Id: 'moonfin-1',
                UserName: 'LivingRoom',
                Client: 'Moonfin',
                DeviceName: 'Android TV',
                ApplicationVersion: '1.0.4',
                PlayMethod: 'DirectPlay',
                IsPaused: false,
                PositionTicks: 12000000000, // 20 mins
                RunTimeTicks: 72000000000,  // 120 mins
                PlaybackPercentage: 16.7,
                NowPlayingItem: {
                    Name: 'Interstellar',
                    ProductionYear: 2014,
                    Width: 3840,
                    Height: 2160,
                    Container: 'mkv',
                    MediaStreams: [
                        { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'HDR' },
                        { Type: 'Audio', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1' }
                    ]
                }
            };

            // Active Playing State
            const activeHtml = dash.renderSessionCard(moonfinSession, 0, 'compact', false);
            assert.ok(activeHtml.includes('LivingRoom'), 'Shows username');
            assert.ok(activeHtml.includes('Moonfin &mdash; Android TV (v1.0.4)'), 'Shows Moonfin client, device, and version');
            assert.ok(activeHtml.includes('Interstellar'), 'Shows media title');
            assert.ok(activeHtml.includes('2014'), 'Shows production year');
            assert.ok(activeHtml.includes('Direct Play'), 'Shows Direct Play badge');
            assert.ok(activeHtml.includes('4K'), 'Shows 4K resolution badge');
            assert.ok(activeHtml.includes('HEVC'), 'Shows HEVC video codec badge');
            assert.ok(activeHtml.includes('7.1'), 'Shows 7.1 audio channels badge');
            assert.ok(activeHtml.includes('MKV'), 'Shows MKV container badge');
            assert.ok(activeHtml.includes('data-action="toggle-info"'), 'Shows Info toggle button');
            assert.ok(activeHtml.includes('aria-expanded="false"'), 'Info toggle has aria-expanded false');
            assert.ok(activeHtml.includes('aria-controls="details-dash-card-1"'), 'Info toggle points to this card\'s own inline details panel, not a shared side panel');
            assert.ok(activeHtml.includes('data-card-id="dash-card-1"'), 'Info toggle carries its card correlation id');

            // Paused State
            moonfinSession.IsPaused = true;
            const pausedHtml = dash.renderSessionCard(moonfinSession, 0, 'compact', false);
            assert.ok(pausedHtml.includes('Paused'), 'Shows Paused badge when paused');

            // Resumed State
            moonfinSession.IsPaused = false;
            const resumedHtml = dash.renderSessionCard(moonfinSession, 0, 'compact', false);
            assert.ok(resumedHtml.includes('Direct Play'), 'Shows Direct Play when resumed');

            // Stopped State (cleanup to empty state)
            const emptyContainer = { innerHTML: '' };
            dash.renderDashboardContainer(emptyContainer, []);
            assert.ok(emptyContainer.innerHTML.includes('No active playback'), 'Reverts cleanly to No active playback');
            assert.ok(!emptyContainer.innerHTML.includes('Interstellar'), 'Playback card removed on stop');
        });

        it('calculates session count breakdown accurately for Direct Play, Direct Stream, Transcode, and Paused', () => {
            const dash = createMockDashboard();
            const mockSessions = [
                {
                    Id: 's1',
                    PlayMethod: 'DirectPlay',
                    IsPaused: false,
                    NowPlayingItem: { Name: 'Direct Stream Video' }
                },
                {
                    Id: 's2',
                    PlayMethod: 'DirectStream',
                    IsPaused: false,
                    NowPlayingItem: { Name: 'Direct Stream Audio' }
                },
                {
                    Id: 's3',
                    PlayMethod: 'Transcode',
                    IsPaused: false,
                    TranscodingInfo: { IsVideoDirect: false },
                    NowPlayingItem: { Name: 'Transcoded Video' }
                },
                {
                    Id: 's4',
                    PlayMethod: 'DirectPlay',
                    IsPaused: true,
                    NowPlayingItem: { Name: 'Paused Video' }
                }
            ];

            const counts = dash.calculateSessionCounts(mockSessions);
            assert.equal(counts.directPlay, 1, 'Direct Play count');
            assert.equal(counts.directStream, 1, 'Direct Stream count');
            assert.equal(counts.transcode, 1, 'Transcode count');
            assert.equal(counts.paused, 1, 'Paused count');
        });

        it('reports exact fallback text "Reason not reported by server" when transcode reasons are missing', () => {
            const dash = createMockDashboard();
            const transcodeSessionNoReasons = {
                Id: 's-no-reasons',
                UserName: 'TestUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome',
                PlayMethod: 'Transcode',
                TranscodingInfo: {
                    IsVideoDirect: false,
                    IsAudioDirect: true,
                    HardwareAccelerationType: 'nvenc',
                    TranscodeReasons: [] // Empty reasons
                },
                NowPlayingItem: { Name: 'Transcoded Movie', Container: 'mkv' }
            };

            // Extended mode reveals the icon-led Reason/Engine rows (compact mode never does).
            const html = dash.renderSessionCard(transcodeSessionNoReasons, 1, 'extended', false);
            assert.ok(html.includes('Reason not reported by server'), 'Must render exact fallback text');
            assert.ok(html.includes('<span class="playback-ext-label">Reason</span>'), 'Must include labeled Reason row');
            assert.ok(html.includes('<span class="playback-ext-label">Engine</span><span class="playback-ext-detail">NVENC</span>'), 'Must include NVENC hardware acceleration value');
        });

        it('reports truthful human-readable transcode reasons when reported by server', () => {
            const dash = createMockDashboard();
            const transcodeSessionWithReasons = {
                Id: 's-with-reasons',
                UserName: 'TestUser',
                Client: 'Moonfin',
                DeviceName: 'Android TV',
                PlayMethod: 'Transcode',
                TranscodingInfo: {
                    IsVideoDirect: false,
                    IsAudioDirect: false,
                    TranscodeReasons: ['ContainerNotSupported', 'VideoCodecNotSupported']
                },
                NowPlayingItem: { Name: 'Moonfin Test Media', Container: 'avi' }
            };

            const html = dash.renderSessionCard(transcodeSessionWithReasons, 1, 'extended', false);
            assert.ok(html.includes('Container not supported'));
            assert.ok(html.includes('Video codec not supported'));
            assert.ok(!html.includes('Reason not reported by server'));
        });

        it('shows the full compact badge priority list uncapped, wrapping via CSS rather than truncating', () => {
            const dash = createMockDashboard();
            const richMediaSession = {
                Id: 's-rich',
                UserName: 'MobileUser',
                Client: 'Jellyfin Mobile',
                DeviceName: 'iPhone 15 Pro',
                PlayMethod: 'DirectPlay',
                NowPlayingItem: {
                    Name: 'Feature Film',
                    Width: 3840,
                    Height: 2160,
                    Container: 'mkv',
                    MediaStreams: [
                        { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'HDR', BitDepth: 10 },
                        { Type: 'Audio', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1' },
                        { Type: 'Subtitle', Index: 2, Language: 'eng' }
                    ]
                }
            };

            // Compact mode: section 11's full priority list renders every time (Resolution,
            // HDR/Dynamic range, Method, Video codec, Bit depth, Audio, Container) -- excess
            // badges wrap onto additional lines via CSS flex-wrap rather than being cut off.
            const compactHtml = dash.renderSessionCard(richMediaSession, 1, 'compact', false);
            const compactPills = (compactHtml.match(/<span class="playback-pill/g) || []).length;
            assert.equal(compactPills, 7, 'Compact mode renders the full priority badge list uncapped, got: ' + compactPills);
            assert.ok(compactHtml.includes('4K'), 'Must include Resolution');
            assert.ok(compactHtml.includes('HDR'), 'Must include HDR/Dynamic range');
            assert.ok(compactHtml.includes('Direct Play'), 'Must include Playback Method');
            assert.ok(compactHtml.includes('HEVC'), 'Must include Video Codec');
            assert.ok(compactHtml.includes('10-bit'), 'Must include Bit depth');
            assert.ok(compactHtml.includes('7.1'), 'Must include Audio Channels');
            assert.ok(compactHtml.includes('MKV'), 'Must include Container');
            assert.ok(compactHtml.includes('class="playback-pill-row"'), 'Pill row uses CSS flex-wrap for overflow, not JS-side capping');

            // Extended mode adds secondary badges (2nd audio format, active subtitle) on top.
            const extendedHtml = dash.renderSessionCard(richMediaSession, 1, 'extended', false);
            const extendedPills = (extendedHtml.match(/<span class="playback-pill/g) || []).length;
            assert.ok(extendedPills > compactPills, 'Extended mode renders additional secondary badges beyond compact');
        });

        it('guarantees non-admin user isolation via PlaybackCard/Self/Sessions', async () => {
            let calledSelfSessions = false;
            let calledAdminSessions = false;

            const mockApiClient = {
                getSessions: async () => {
                    calledAdminSessions = true;
                    const err = new Error('Forbidden');
                    err.status = 403;
                    throw err;
                },
                getUrl: (subpath) => '/' + subpath,
                getJSON: async (url) => {
                    if (url.includes('PlaybackCard/Self/Sessions')) {
                        calledSelfSessions = true;
                        return [
                            {
                                MediaTitle: 'Isolated User Stream',
                                PlayMethod: 'DirectPlay',
                                IsVideoDirect: true,
                                IsAudioDirect: true,
                                PlaybackPercentage: 25
                            }
                        ];
                    }
                    return [];
                }
            };

            let renderedHtml = '';
            const mockContainer = {
                innerHTML: '',
                setAttribute: () => {},
                getAttribute: () => null,
                addEventListener: () => {}
            };

            const mockDoc = {
                getElementById: () => null,
                querySelector: () => ({
                    id: 'activeDevices',
                    parentNode: { insertBefore: () => {} }
                }),
                querySelectorAll: () => [],
                createElement: () => mockContainer,
                addEventListener: () => {}
            };

            const dash = createMockDashboard({
                window: {
                    location: { hash: '#/dashboard', pathname: '/web/index.html' },
                    ApiClient: mockApiClient
                },
                document: mockDoc
            });

            await dash.pollSessions();

            assert.equal(calledSelfSessions, true, 'Must fall back to PlaybackCard/Self/Sessions when non-admin');
            assert.equal(dash.state.isNonAdmin, true, 'Controller flags user as non-admin');
            assert.equal(dash.state.activeSessions.length, 1, 'Contains 1 isolated session');
            assert.equal(dash.state.activeSessions[0].MediaTitle, 'Isolated User Stream');
        });

        it('renders accessible [Info] toggle button with aria-expanded and aria-controls', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-aria',
                UserName: 'AriaUser',
                Client: 'Android',
                DeviceName: 'Pixel 8',
                PlayMethod: 'DirectPlay',
                NowPlayingItem: { Name: 'Accessible Stream' }
            };

            const html = dash.renderSessionCard(session, 1, 'compact', false);
            assert.ok(html.includes('aria-expanded="false"'), 'Info button has initial aria-expanded false');
            assert.ok(html.includes('aria-controls="details-dash-card-2"'), 'Info button points to this card\'s own inline details panel');
            assert.ok(html.includes('data-card-id="dash-card-2"'), 'Info button has deterministic card correlation id');
            assert.ok(html.includes('id="details-dash-card-2"'), 'Inline Show-Details summary panel has matching ID');
            assert.ok(html.includes('role="region"'), 'Inline summary panel has role region');
            assert.ok(html.includes('aria-label="Stream Details"'), 'Inline summary panel has accessible label');
        });
    });

    describe('19. Telemetry Accuracy, Framerate Validation, QSV Suppression, and 21-Field Drawer', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');

        function createMockDashboard(env = {}) {
            const mockModule = { exports: {} };
            const mockWindow = {
                location: { hash: '#/dashboard', pathname: '/web/index.html' },
                addEventListener: () => {},
                removeEventListener: () => {},
                setInterval: () => 123,
                clearInterval: () => {},
                ...env.window
            };
            const mockDocument = {
                getElementById: (id) => null,
                querySelector: (sel) => null,
                querySelectorAll: (sel) => [],
                createElement: (tag) => ({
                    id: '',
                    tagName: tag.toUpperCase(),
                    style: {},
                    classList: { contains: () => false, add: () => {}, remove: () => {} },
                    setAttribute: () => {},
                    getAttribute: () => null,
                    appendChild: () => {},
                    insertBefore: () => {}
                }),
                addEventListener: () => {},
                removeEventListener: () => {},
                readyState: 'complete',
                ...env.document
            };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }

        it('classifies Remux streams accurately and keeps header counts and card badges in strict agreement', () => {
            const dash = createMockDashboard();
            const remuxSession = {
                Id: 's-remux',
                UserName: 'TestUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome Windows',
                PlayMethod: 'Transcode',
                PlayState: { PlayMethod: 'Transcode', IsPaused: false },
                TranscodingInfo: {
                    IsVideoDirect: true,
                    IsAudioDirect: true,
                    Container: 'mp4',
                    HardwareAccelerationType: 'qsv'
                },
                NowPlayingItem: {
                    Name: 'An Action Hero',
                    Container: 'mkv',
                    MediaStreams: [
                        { Type: 'Video', Codec: 'h264', RealFrameRate: 24 }
                    ]
                }
            };

            const classification = dash.classifyPlaybackSession(remuxSession);
            assert.equal(classification.isRemux, true, 'Remux session must have isRemux true');
            assert.equal(classification.method, 'Remux', 'Remux session must have method Remux');
            assert.equal(classification.badgeText, 'Remux', 'Remux session must have badgeText Remux');

            const counts = dash.calculateSessionCounts([remuxSession]);
            assert.equal(counts.total, 1);
            assert.equal(counts.remux, 1, 'Remux count must be 1');
            assert.equal(counts.transcode, 0, 'Transcode count must be 0 for Remux stream');
            assert.equal(counts.directPlay, 0);
            assert.equal(counts.directStream, 0);

            // Verify rendered card badge
            const html = dash.renderSessionCard(remuxSession, 0, 'compact', false);
            assert.ok(html.includes('Remux'), 'Card must display Remux badge');
            assert.ok(!html.includes('pill-transcode'), 'Card must NOT display Transcode pill for Remux');

            // Direct Stream session must also never be counted as Transcode
            const directStreamSession = {
                Id: 's-ds',
                PlayMethod: 'DirectStream',
                PlayState: { PlayMethod: 'DirectStream', IsPaused: false },
                NowPlayingItem: { Name: 'Direct Stream Video' }
            };
            const dsClassification = dash.classifyPlaybackSession(directStreamSession);
            assert.equal(dsClassification.isDirectStream, true);
            assert.equal(dsClassification.badgeText, 'Direct Stream');
            const dsCounts = dash.calculateSessionCounts([directStreamSession]);
            assert.equal(dsCounts.directStream, 1);
            assert.equal(dsCounts.transcode, 0, 'Direct Stream must NEVER be counted as Transcode');
        });

        it('suppresses hardware engine display when video is direct (Remux or Audio-only transcode)', () => {
            const dash = createMockDashboard();

            // Direct video with QSV configured on server
            assert.equal(dash.extractTranscoderEngine('qsv', true), null, 'QSV must be suppressed when video is direct');
            assert.equal(dash.extractTranscoderEngine('nvenc', true), null, 'NVENC must be suppressed when video is direct');
            assert.equal(dash.extractTranscoderEngine('vaapi', true), null, 'VAAPI must be suppressed when video is direct');
            assert.equal(dash.extractTranscoderEngine('amf', true), null, 'AMF must be suppressed when video is direct');
            assert.equal(dash.extractTranscoderEngine('videotoolbox', true), null, 'VideoToolbox must be suppressed when video is direct');

            // When video is actively transcoded, engine should be reported
            assert.equal(dash.extractTranscoderEngine('qsv', false), 'QSV');
            assert.equal(dash.extractTranscoderEngine('nvenc', false), 'NVENC');
            assert.equal(dash.extractTranscoderEngine('vaapi', false), 'VAAPI');

            // Render remux card with QSV in TranscodingInfo
            const remuxSession = {
                Id: 's-remux-hw',
                UserName: 'TestUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome Windows',
                PlayMethod: 'Transcode',
                TranscodingInfo: {
                    IsVideoDirect: true,
                    IsAudioDirect: true,
                    Container: 'mp4',
                    HardwareAccelerationType: 'qsv'
                },
                NowPlayingItem: {
                    Name: 'Remux Title',
                    Container: 'mkv'
                }
            };

            const html = dash.renderSessionCard(remuxSession, 0, 'compact', false);
            assert.ok(!html.includes('Hardware engine: QSV'), 'Card must NOT show Hardware engine: QSV during remux');
            assert.ok(!html.includes('pill-hw'), 'Card must NOT render hardware pill during remux');
            // Check the full inline breakdown grid (built independently of the card's own HTML)
            const gridHtml = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(remuxSession));
            assert.ok(gridHtml.includes('<span class="playback-info-key">Hardware Engine</span><span class="playback-info-val">Not applicable</span>'), 'Full breakdown must report Not applicable for hardware engine during remux');
        });

        it('validates framerate strictly and rejects impossible values like 2191 fps', () => {
            const dash = createMockDashboard();

            // formatFrameRate rejection
            assert.equal(dash.formatFrameRate(2191), null, 'Must reject 2191 fps');
            assert.equal(dash.formatFrameRate(300), null, 'Must reject > 240 fps');
            assert.equal(dash.formatFrameRate(0), null, 'Must reject 0 fps');
            assert.equal(dash.formatFrameRate(-1), null, 'Must reject negative fps');
            assert.equal(dash.formatFrameRate(null), null, 'Must reject null fps');
            assert.equal(dash.formatFrameRate('garbage'), null, 'Must reject non-numeric fps');

            // formatFrameRate valid rates
            assert.equal(dash.formatFrameRate(23.976024), '23.976 fps');
            assert.equal(dash.formatFrameRate(24), '24 fps');
            assert.equal(dash.formatFrameRate(25), '25 fps');
            assert.equal(dash.formatFrameRate(29.97003), '29.97 fps');
            assert.equal(dash.formatFrameRate(30), '30 fps');
            assert.equal(dash.formatFrameRate(50), '50 fps');
            assert.equal(dash.formatFrameRate(59.94006), '59.94 fps');
            assert.equal(dash.formatFrameRate(60), '60 fps');

            // getTruthfulFrameRate prioritizes videoStream and ignores impossible TranscodingInfo.Framerate
            const session = {
                TranscodingInfo: { Framerate: 2191 }
            };
            const item = { Framerate: 23.976 };
            const videoStream = { RealFrameRate: 23.976, AverageFrameRate: 23.976 };

            const truthfulFps = dash.getTruthfulFrameRate(session, item, videoStream);
            assert.equal(truthfulFps, '23.976 fps', 'Must pull media stream framerate and reject TranscodingInfo 2191');

            // Render card with 2191 throughput counter
            const fullSession = {
                Id: 's-fps',
                PlayMethod: 'Transcode',
                TranscodingInfo: { Framerate: 2191, IsVideoDirect: true },
                NowPlayingItem: {
                    Name: 'Framerate Test',
                    MediaStreams: [{ Type: 'Video', RealFrameRate: 23.976 }]
                }
            };
            // Frame rate only surfaces inline in extended mode (or the Show Details/drawer grid).
            const html = dash.renderSessionCard(fullSession, 0, 'extended', false);
            assert.ok(!html.includes('2191 fps'), 'Must NEVER render 2191 fps');
            assert.ok(html.includes('23.976 fps'), 'Must render truthful 23.976 fps');
        });

        it('extracts server-reported transcode reasons without guessing or inferring Container not supported', () => {
            const dash = createMockDashboard();

            // Legitimate server reasons
            const sessionWithReasons = {
                TranscodingInfo: {
                    TranscodeReasons: ['ContainerNotSupported', 'AudioCodecNotSupported']
                }
            };
            const reasons = dash.getTruthfulTranscodeReasons(sessionWithReasons);
            assert.equal(reasons, 'Container not supported, Audio codec not supported');

            // Missing reasons on a genuine Transcode: must NOT infer or guess a reason,
            // but the full grid must still show the honest "not reported" fallback.
            const genuineTranscodeNoReasons = {
                PlayMethod: 'Transcode',
                TranscodingInfo: {
                    IsVideoDirect: false,
                    IsAudioDirect: true,
                    Container: 'mp4'
                },
                NowPlayingItem: { Container: 'mkv' }
            };
            const emptyReasons = dash.getTruthfulTranscodeReasons(genuineTranscodeNoReasons);
            assert.equal(emptyReasons, null, 'Must return null and NOT infer Container not supported when server omits reasons');
            assert.equal(dash.classifyPlaybackSession(genuineTranscodeNoReasons).method, 'Transcode', 'Fixture must be a genuine Transcode');

            const transcodeGridHtml = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(genuineTranscodeNoReasons));
            assert.ok(transcodeGridHtml.includes('Reason not reported by server'), 'Genuine Transcode with no reported reason must show the fallback text');

            // A Remux (video+audio direct, container changed) with no reasons must NEVER show
            // "Reason not reported by server" -- that text implies a transcode is happening.
            const remuxNoReasons = {
                TranscodingInfo: {
                    IsVideoDirect: true,
                    IsAudioDirect: true,
                    Container: 'mp4'
                },
                NowPlayingItem: { Container: 'mkv' }
            };
            assert.equal(dash.classifyPlaybackSession(remuxNoReasons).method, 'Remux', 'Fixture must classify as Remux');
            const remuxGridHtml = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(remuxNoReasons));
            assert.ok(!remuxGridHtml.includes('Reason not reported by server'), 'Remux must never show the Transcode-only fallback reason text');
            assert.ok(remuxGridHtml.includes('<span class="playback-info-key">Transcode Reason</span><span class="playback-info-val">Not applicable</span>'), 'Remux Transcode Reason field must read Not applicable');
        });

        it('resolves artwork with TV series poster fallback and slate SVG placeholder', () => {
            const dash = createMockDashboard();
            const mockApiClient = {
                getUrl: (p, q) => '/jellyfin/' + p + (q ? '?' + new URLSearchParams(q).toString() : ''),
                accessToken: () => 'my-auth-token'
            };

            // TV Episode with Series poster tag
            const tvItem = {
                Id: 'ep-001',
                Type: 'Episode',
                SeriesId: 'series-999',
                SeriesPrimaryImageTag: 'tag-series-art'
            };
            const tvArt = dash.resolveArtworkUrls({}, tvItem, mockApiClient);
            assert.ok(tvArt.posterUrl.includes('series-999'), 'Artwork must fall back to SeriesId for TV episode');
            assert.ok(tvArt.posterUrl.includes('tag-series-art'), 'Artwork must use SeriesPrimaryImageTag');
            assert.ok(tvArt.posterUrl.includes('api_key=my-auth-token'), 'Artwork must include authentication token');

            // Movie with Item primary image tag
            const movieItem = {
                Id: 'movie-111',
                Type: 'Movie',
                PrimaryImageTag: 'tag-movie-art'
            };
            const movieArt = dash.resolveArtworkUrls({}, movieItem, mockApiClient);
            assert.ok(movieArt.posterUrl.includes('movie-111'));
            assert.ok(movieArt.posterUrl.includes('tag-movie-art'));

            // Missing artwork: returns empty string URL, card renders SVG slate placeholder
            const missingArt = dash.resolveArtworkUrls({}, {}, mockApiClient);
            assert.equal(missingArt.posterUrl, '');

            const html = dash.renderSessionCard({ NowPlayingItem: { Name: 'No Artwork Movie' } }, 0, 'compact', false);
            assert.ok(html.includes('playback-poster-fallback'), 'Must render poster fallback element');
            assert.ok(html.includes('<svg'), 'Must render SVG slate icon instead of a black box');
        });

        it('renders the complete non-identity field grid inline, and Info shares it with Show Details', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-grid-26',
                UserName: 'TechUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome',
                ApplicationVersion: '10.9.0',
                PlayMethod: 'DirectPlay',
                PlayState: { SubtitleStreamIndex: 2 },
                NowPlayingItem: {
                    Name: 'Technical Specs Test',
                    Container: 'mkv',
                    MediaStreams: [
                        {
                            Type: 'Video',
                            Codec: 'h264',
                            Profile: 'High',
                            Width: 1920,
                            Height: 1080,
                            AspectRatio: '16:9',
                            RealFrameRate: 24,
                            BitRate: 5000000,
                            ColorSpace: 'bt709',
                            VideoRange: 'SDR'
                        },
                        {
                            Type: 'Audio',
                            Codec: 'aac',
                            Profile: 'LC',
                            Channels: 6,
                            ChannelLayout: '5.1',
                            BitRate: 384000,
                            SampleRate: 48000
                        },
                        { Type: 'Subtitle', Index: 2, Language: 'eng', DisplayTitle: 'English', Codec: 'srt' }
                    ]
                }
            };

            // Built independently of the card, so it agrees with the canonical model
            // regardless of the card's own compact/extended render mode.
            const gridHtml = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(session));

            var requiredKeys = [
                // Video (8)
                'Video Status', 'Source Video Codec', 'Output Video Codec', 'Source Resolution',
                'Output Resolution', 'Frame Rate', 'HDR Status', 'Tone Mapping / HDR Conversion',
                // Audio (5)
                'Audio Status', 'Source Audio Codec', 'Output Audio Codec', 'Audio Channels / Layout', 'Audio Bitrate',
                // Stream (6)
                'Source Container', 'Output Container', 'Video Bitrate', 'Overall Stream Bitrate', 'Hardware Engine', 'Transcode Reason',
                // Subtitles (1)
                'Subtitle Stream / Language',
                // Playback (2 -- User/Client/Client Version/Device are omitted, already in the card header)
                'Playback State', 'Playback Method'
            ];
            assert.equal(requiredKeys.length, 22, 'Test fixture itself must enumerate exactly 22 required non-identity fields');

            for (const key of requiredKeys) {
                assert.ok(gridHtml.includes(`<span class="playback-info-key">${key}</span>`), `Grid must contain row: ${key}`);
            }
            for (const identityKey of ['User', 'Client', 'Client Version', 'Device']) {
                assert.ok(!gridHtml.includes(`<span class="playback-info-key">${identityKey}</span>`), `Grid must omit identity field "${identityKey}" already shown in the card header`);
            }
            assert.ok(gridHtml.includes('English (SRT)'), 'Active subtitle stream reports language and codec');

            // Info and Show Details reveal the exact same grid content -- no separate side panel.
            const showDetailsHtml = dash.renderSessionCard(session, 0, 'compact', true);
            assert.ok(showDetailsHtml.includes(gridHtml), 'Show Details renders the identical grid markup inline on the card');

            // Missing fields show "Not reported" -- and a non-Transcode session never shows
            // the Transcode-only "Reason not reported by server" fallback (section 9/14).
            const sparseSession = { Id: 's-sparse', NowPlayingItem: { Name: 'Sparse Media' } };
            assert.equal(dash.classifyPlaybackSession(sparseSession).method, 'DirectPlay');
            const sparseHtml = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(sparseSession));
            assert.ok(sparseHtml.includes('Not reported'), 'Missing technical fields must display "Not reported"');
            assert.ok(!sparseHtml.includes('Reason not reported by server'), 'DirectPlay must never show the Transcode-only fallback reason text');
            assert.ok(sparseHtml.includes('<span class="playback-info-key">Transcode Reason</span><span class="playback-info-val">Not applicable</span>'), 'DirectPlay Transcode Reason field must read Not applicable');
        });

        it('Info toggles that one card\'s own inline details, and it survives a full re-render (simulated poll) by session ID', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };

            const session = {
                Id: 'poll-persist-1',
                UserName: 'PersistUser',
                Client: 'Jellyfin Web',
                DeviceName: 'Chrome',
                PlayMethod: 'DirectPlay',
                NowPlayingItem: { Name: 'Long Movie' }
            };

            dash.renderDashboardContainer(container, [session], [session]);
            assert.ok(!container.innerHTML.includes('class="playback-details-panel open"'), 'Details panel starts closed');

            // Toggling Info is exactly what the click handler does: flip the session-ID
            // flag, then re-render -- no separate dialog/side panel node involved.
            dash.state.openInfoSessionIds['poll-persist-1'] = true;
            dash.renderDashboardContainer(container, [session], [session]);
            assert.ok(container.innerHTML.includes('class="playback-details-panel open"'), 'Details panel opens inline on the card');
            assert.ok(container.innerHTML.includes('aria-expanded="true"'), 'Info button reflects the open state');

            // Simulate several more poll cycles while the session is still present: the
            // inline panel must stay open without needing to be re-toggled.
            for (let i = 0; i < 4; i++) {
                dash.renderDashboardContainer(container, [session], [session]);
                assert.ok(container.innerHTML.includes('class="playback-details-panel open"'), `Panel must stay open through poll cycle ${i + 1}`);
            }

            // Session disappears (stream ended) -- its Info state is cleaned up, not carried
            // forward forever, so it doesn't silently reopen if the same session ID recurs.
            dash.renderDashboardContainer(container, [], []);
            assert.equal(dash.state.openInfoSessionIds['poll-persist-1'], undefined, 'Stale per-card Info state is dropped once the session is gone');
        });
    });

    describe('20. Client Brand Resolver Matrix', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');

        function createMockDashboard() {
            const mockModule = { exports: {} };
            const mockWindow = { location: { hash: '#/dashboard', pathname: '/web/index.html' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval: () => 123, clearInterval: () => {} };
            const mockDocument = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ id: '', style: {}, classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {}, insertBefore: () => {} }), addEventListener: () => {}, removeEventListener: () => {}, readyState: 'complete' };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }

        const dash = createMockDashboard();

        const cases = [
            { client: 'Jellyfin Web', device: 'Chrome Windows', expectKey: 'chrome' },
            { client: 'Jellyfin Web', device: 'Safari iPhone', expectKey: 'safari' },
            { client: 'Jellyfin Web', device: 'Edge', expectKey: 'edge' },
            { client: 'Jellyfin Web', device: 'Firefox', expectKey: 'firefox' },
            { client: 'Jellyfin Web', device: 'Brave', expectKey: 'brave' },
            { client: 'Jellyfin Web', device: '', expectKey: 'jellyfin-web' },
            { client: 'Jellyfin Media Player', device: 'Windows', expectKey: 'jellyfin-desktop' },
            { client: 'Jellyfin Android', device: 'Pixel 8', expectKey: 'jellyfin-android' },
            { client: 'Jellyfin Android TV', device: 'Shield', expectKey: 'jellyfin-androidtv' },
            { client: 'Jellyfin iOS', device: 'iPhone', expectKey: 'jellyfin-ios' },
            { client: 'Jellyfin tvOS', device: 'Apple TV', expectKey: 'jellyfin-tvos' },
            { client: 'Swiftfin', device: 'iPhone', expectKey: 'swiftfin' },
            { client: 'Finamp', device: 'Pixel', expectKey: 'finamp' },
            { client: 'Findroid', device: 'Pixel', expectKey: 'findroid' },
            { client: 'Streamyfin', device: 'iPhone', expectKey: 'streamyfin' },
            { client: 'Moonfin', device: 'Android TV', expectKey: 'moonfin' },
            { client: 'Infuse', device: 'Apple TV', expectKey: 'infuse' },
            { client: 'Kodi', device: 'HTPC', expectKey: 'kodi' },
            { client: 'DLNA Renderer', device: 'Roku Ultra', expectKey: 'roku' },
            { client: 'Fire TV', device: 'Fire TV Stick', expectKey: 'firetv' },
            { client: 'Chromecast', device: 'Google TV', expectKey: 'chromecast' },
            { client: 'DLNA', device: 'Generic Renderer', expectKey: 'dlna' },
            { client: 'Samsung Smart TV', device: 'Tizen', expectKey: 'tizen' },
            { client: 'LG Smart TV', device: 'webOS', expectKey: 'webos' },
            { client: 'Xbox One', device: 'Xbox', expectKey: 'xbox' },
            { client: 'PlayStation 5', device: 'PS5', expectKey: 'playstation' },
            { client: 'Unknown Client', device: 'Windows 11', expectKey: 'windows' },
            { client: 'Unknown Client', device: 'Android Phone', expectKey: 'android' },
            { client: 'Unknown Client', device: 'Unknown Device', expectKey: 'generic' },
            { client: 'Fladder', device: 'Pixel 8', expectKey: 'fladder' },
            { client: 'jellyfin-mpv-shim', device: 'HTPC', expectKey: 'mpvshim' },
            { client: 'Unknown Client', device: 'MacBook Pro', expectKey: 'apple' },
            { client: 'Jellyfin Web', device: 'Safari macOS', expectKey: 'safari' },
            { client: 'Unknown Client', device: 'Ubuntu Linux Desktop', expectKey: 'linux' },
            { client: 'Unknown Client', device: 'Vizio SmartCast TV', expectKey: 'smarttv' },
            { client: 'Unknown Client', device: 'Hisense VIDAA TV', expectKey: 'smarttv' }
        ];

        for (const c of cases) {
            it(`resolves "${c.client}" / "${c.device}" -> ${c.expectKey}`, () => {
                const brand = dash.resolveClientBrand({ client: c.client, deviceName: c.device });
                assert.equal(brand.key, c.expectKey, `Expected ${c.expectKey} for client="${c.client}" device="${c.device}", got ${brand.key}`);
                assert.ok(brand.svg.startsWith('<svg'), 'Every resolved brand must return real inline SVG markup');
                assert.ok(!/^data:|http:|https:/.test(brand.svg), 'Brand icon must never reference an external URL');
            });
        }

        it('gives exact Jellyfin-application identity priority over generic OS identity', () => {
            const swiftfinOnIos = dash.resolveClientBrand({ client: 'Swiftfin', deviceName: 'iPhone 15' });
            assert.equal(swiftfinOnIos.key, 'swiftfin', 'Swiftfin must not fall back to generic Apple/iOS icon');

            const moonfinOnAndroidTv = dash.resolveClientBrand({ client: 'Moonfin', deviceName: 'Android TV' });
            assert.equal(moonfinOnAndroidTv.key, 'moonfin', 'Moonfin must not fall back to generic Android TV icon');
        });

        it('uses the same resolver for Now Playing cards and Connected Devices', () => {
            const session = { Id: 'brand-parity', UserName: 'U', Client: 'Jellyfin Web', DeviceName: 'Safari iPhone', NowPlayingItem: { Name: 'X' } };
            const cardHtml = dash.renderSessionCard(session, 0, 'compact', false);
            const deviceHtml = dash.renderConnectedDeviceItem(session);
            assert.ok(cardHtml.includes('data-client-brand="safari"'), 'Now Playing card tags the resolved brand key');
            assert.ok(deviceHtml.includes('data-client-brand="safari"'), 'Connected Devices card tags the same resolved brand key');
            assert.ok(deviceHtml.includes('data-connected-device-card="true"'), 'Connected device card carries its diagnostic hook');
            assert.ok(!deviceHtml.includes('brand-parity'), 'Raw session ID must never be written into the DOM');
        });
    });

    describe('21. Redesigned Card Layout (state badge, bit depth, Show Details grid, drawer targeting)', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');

        function createMockDashboard(env = {}) {
            const mockModule = { exports: {} };
            const mockWindow = { location: { hash: '#/dashboard', pathname: '/web/index.html' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval: () => 123, clearInterval: () => {}, ...env.window };
            const mockDocument = { getElementById: (id) => null, querySelector: () => null, querySelectorAll: () => [], createElement: (tag) => ({ id: '', tagName: tag.toUpperCase(), style: {}, classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {}, insertBefore: () => {} }), addEventListener: () => {}, removeEventListener: () => {}, readyState: 'complete', ...env.document };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }

        it('shows a separate Playing/Paused state badge alongside the method badge, both always visible', () => {
            const dash = createMockDashboard();
            const remuxSession = {
                Id: 's-dual-badge', UserName: 'U', Client: 'Jellyfin Web', DeviceName: 'Safari iPhone',
                TranscodingInfo: { IsVideoDirect: true, IsAudioDirect: true, Container: 'mp4' },
                NowPlayingItem: { Name: 'Con City', Container: 'mkv' }
            };

            const playingHtml = dash.renderSessionCard(remuxSession, 0, 'compact', false);
            assert.ok(playingHtml.includes('playback-badge state-badge playing'), 'Playing state badge renders with its own class');
            assert.ok(playingHtml.includes('Playing</span>'), 'Playing label renders');
            assert.ok(playingHtml.includes('playback-badge remux'), 'Method badge renders independently of state');
            assert.ok(playingHtml.includes('>Remux</span>'), 'Method label renders');

            remuxSession.IsPaused = true;
            const pausedHtml = dash.renderSessionCard(remuxSession, 0, 'compact', false);
            assert.ok(pausedHtml.includes('playback-badge state-badge paused'), 'Paused state badge renders with its own class');
            assert.ok(pausedHtml.includes('Paused</span>'), 'Paused label renders');
            assert.ok(pausedHtml.includes('playback-badge remux'), 'Method badge still reads Remux while paused, not overridden');
            assert.ok(pausedHtml.includes('>Remux</span>'), 'Method label is untouched by pause');
        });

        it('includes a bit-depth badge in the compact priority list when reported', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-bitdepth', NowPlayingItem: {
                    Name: 'HDR Movie', Width: 3840, Height: 2160,
                    MediaStreams: [{ Type: 'Video', Codec: 'hevc', VideoRange: 'HDR', BitDepth: 10, Width: 3840, Height: 2160 }]
                }
            };
            const html = dash.renderSessionCard(session, 0, 'compact', false);
            assert.ok(html.includes('10-bit'), 'Bit-depth badge renders when the source reports BitDepth');

            const sdSession = { Id: 's-nodepth', NowPlayingItem: { Name: 'No Depth Info' } };
            const sdHtml = dash.renderSessionCard(sdSession, 1, 'compact', false);
            assert.ok(!sdHtml.includes('-bit<'), 'Bit-depth badge is omitted (never guessed) when not reported');
        });

        it('always shows the Paused header chip, including zero, matching the other method chips', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };
            dash.renderDashboardContainer(container, [], []);
            assert.ok(container.innerHTML.includes('data-count-method="paused" data-count-value="0"'), 'Paused chip renders at zero just like Direct Play/Direct Stream/Remux/Transcode');
        });

        it('Show Details reveals the full non-identity field grid inline on the card and hides it again on toggle-off', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-show-details', UserName: 'DetailUser', Client: 'Jellyfin Web', DeviceName: 'Chrome',
                NowPlayingItem: { Name: 'Show Details Test', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }] }
            };

            const closedHtml = dash.renderSessionCard(session, 0, 'compact', false);
            assert.ok(!closedHtml.includes('<span class="playback-info-key">Source Video Codec</span>'), 'Full field grid is absent when Show Details is off');

            const openHtml = dash.renderSessionCard(session, 0, 'compact', true);
            assert.ok(openHtml.includes('<span class="playback-info-key">Source Video Codec</span>'), 'Full field grid appears when Show Details is on');
            assert.ok(openHtml.includes('<span class="playback-info-key">Playback Method</span>'), 'Grid includes Playback Method');
            assert.ok(!openHtml.includes('<span class="playback-info-key">User</span>'), 'Grid omits identity fields already shown in the card header');
            assert.ok(!openHtml.includes('<span class="playback-info-key">Client</span>'), 'Grid omits Client (already in header)');
            assert.ok(openHtml.includes('class="playback-details-panel open"'), 'Details panel carries the open class when Show Details is on');

            const reclosedHtml = dash.renderSessionCard(session, 0, 'compact', false);
            assert.ok(!reclosedHtml.includes('<span class="playback-info-key">Source Video Codec</span>'), 'Toggling Show Details back off hides the grid again');
        });

        it('highlights the Info button by session identity, not card position, when session order shifts', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };
            const sessionA = { Id: 'session-a', UserName: 'A', NowPlayingItem: { Name: 'Movie A' } };
            const sessionB = { Id: 'session-b', UserName: 'B', NowPlayingItem: { Name: 'Movie B' } };

            // Open Info for session B while it is in the second slot.
            dash.renderDashboardContainer(container, [sessionA, sessionB], [sessionA, sessionB]);
            dash.state.openInfoSessionIds['session-b'] = true;

            // Session order flips (B now renders first, in what used to be A's slot) -- as
            // a real poll re-render would do if one session started/stopped.
            dash.renderDashboardContainer(container, [sessionB, sessionA], [sessionB, sessionA]);
            assert.equal(dash.state.openInfoSessionIds['session-b'], true, 'Open state remains targeted at session B by ID regardless of position');

            const cardChunks = container.innerHTML.split('<div class="playback-card"').slice(1);
            const movieBCard = cardChunks.find((c) => c.includes('Movie B'));
            const movieACard = cardChunks.find((c) => c.includes('Movie A'));
            assert.ok(movieBCard.includes('aria-expanded="true"'), 'Session B\'s Info button is highlighted, since its details are actually open');
            assert.ok(movieACard.includes('aria-expanded="false"'), 'Session A\'s Info button is NOT highlighted, even though it now occupies B\'s old slot');
        });
    });

    describe('22. v0.2.5.3 additions (ETA, Atmos/DTS:X, audio language, subtitle delivery method, avatar)', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');
        function createMockDashboard() {
            const mockModule = { exports: {} };
            const mockWindow = { location: { hash: '#/dashboard', pathname: '/web/index.html' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval: () => 123, clearInterval: () => {} };
            const mockDocument = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ id: '', style: {}, classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {}, insertBefore: () => {} }), addEventListener: () => {}, removeEventListener: () => {}, readyState: 'complete' };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }
        const dash = createMockDashboard();

        it('detects Atmos and DTS:X from real stream profile/title data, never guessed', () => {
            assert.equal(dash.extractAtmosBadge({ Profile: 'Dolby Atmos' }).toLowerCase(), 'atmos');
            assert.equal(dash.extractAtmosBadge({ Title: 'DTS:X' }), 'DTS:X');
            assert.equal(dash.extractAtmosBadge({ Codec: 'truehd' }), '', 'Plain TrueHD with no Atmos marker must not show Atmos');
            assert.equal(dash.extractAtmosBadge(null), '');
        });

        it('extracts a 3-letter audio language code truthfully', () => {
            assert.equal(dash.extractAudioLanguage({ Language: 'eng' }), 'ENG');
            assert.equal(dash.extractAudioLanguage({}), '');
        });

        it('formats a real ETA from remaining ticks, and never fabricates one with zero remaining time', () => {
            const now = new Date(2026, 0, 1, 20, 0, 0).getTime(); // 8:00 PM
            const oneHourTicks = 3600 * 10000000;
            assert.equal(dash.formatEta(oneHourTicks, now), '9:00 PM');
            assert.equal(dash.formatEta(0, now), null);
            assert.equal(dash.formatEta(-5, now), null);
        });

        it('never shows an ETA on a paused session, and shows one on an actively playing session with real remaining time', () => {
            const playing = { Id: 's-eta-1', PlayState: { IsPaused: false }, PositionTicks: 0, RunTimeTicks: 3600 * 10000000, NowPlayingItem: { Name: 'X' } };
            const paused = { Id: 's-eta-2', IsPaused: true, PositionTicks: 0, RunTimeTicks: 3600 * 10000000, NowPlayingItem: { Name: 'X' } };
            assert.ok(dash.renderSessionCard(playing, 0, 'compact', false).includes('playback-eta'), 'Playing session with remaining time shows an ETA');
            assert.ok(!dash.renderSessionCard(paused, 1, 'compact', false).includes('playback-eta'), 'Paused session never shows an ETA');
        });

        it('surfaces the real subtitle delivery method, including burned-in as a genuine transcode cause', () => {
            const burnedIn = {
                Id: 's-sub-burn', PlayState: { SubtitleStreamIndex: 1 },
                NowPlayingItem: { Name: 'X', MediaStreams: [{ Type: 'Video' }, { Type: 'Subtitle', Index: 1, Language: 'eng', Codec: 'srt', DeliveryMethod: 'Encode' }] }
            };
            const grid = dash.buildInlineDetailGridHtml(dash.buildTelemetryModel(burnedIn));
            assert.ok(grid.includes('Burned into video (forces transcode)'), 'Burned-in subtitles are surfaced as a real, factual cause, not inferred');
        });

        it('resolves a user avatar from the session\'s own UserId when the API client supports it, and degrades cleanly otherwise', () => {
            const session = { Id: 's-avatar', UserId: 'user-123', UserPrimaryImageTag: 'tag1' };
            const apiClient = { getUserImageUrl: (id, opts) => '/Users/' + id + '/Images/Primary?tag=' + opts.tag };
            assert.equal(dash.resolveUserAvatarUrl(session, apiClient), '/Users/user-123/Images/Primary?tag=tag1');
            assert.equal(dash.resolveUserAvatarUrl(session, {}), '', 'No getUserImageUrl support -> empty, never throws');
            assert.equal(dash.resolveUserAvatarUrl({}, apiClient), '', 'No UserId -> empty');
        });
    });

    describe('23. v0.2.5.3 additions (summary strip, pill icons, progress-under-title layout)', () => {
        const dashboardJsPath = path.resolve(__dirname, '../Web/dashboard.js');
        const dashboardJsContent = fs.readFileSync(dashboardJsPath, 'utf8');
        function createMockDashboard() {
            const mockModule = { exports: {} };
            const mockWindow = { location: { hash: '#/dashboard', pathname: '/web/index.html' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval: () => 123, clearInterval: () => {} };
            const mockDocument = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ id: '', style: {}, classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {}, insertBefore: () => {} }), addEventListener: () => {}, removeEventListener: () => {}, readyState: 'complete' };
            const runner = new Function('module', 'exports', 'window', 'document', 'globalThis', dashboardJsContent);
            runner(mockModule, mockModule.exports, mockWindow, mockDocument, mockWindow);
            return mockModule.exports;
        }

        it('summary strip shows the real active/direct/transcoding split and is absent when there is nothing playing', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };
            const directSession = { Id: 's-sum-1', NowPlayingItem: { Name: 'Direct Movie' }, PlayMethod: 'DirectPlay' };
            const transcodeSession = { Id: 's-sum-2', NowPlayingItem: { Name: 'Transcode Movie' }, PlayMethod: 'Transcode', TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false } };

            dash.renderDashboardContainer(container, [directSession, transcodeSession], [directSession, transcodeSession]);
            assert.ok(container.innerHTML.includes('playback-summary-strip'), 'Summary strip renders when sessions are active');
            assert.match(container.innerHTML, /playback-summary-value">2<\/span><span class="playback-summary-label">Active Streams/, 'Total reflects both active sessions');
            assert.ok(container.innerHTML.includes('stat-transcode active'), 'Transcoding stat is marked active when at least one session is transcoding');

            const emptyContainer = { innerHTML: '' };
            dash.renderDashboardContainer(emptyContainer, [], []);
            assert.ok(!emptyContainer.innerHTML.includes('playback-summary-strip'), 'Summary strip is omitted entirely when nothing is playing, not shown at zero');
        });

        it('summary strip never marks Transcoding as active when every session is a genuine direct stream', () => {
            const dash = createMockDashboard();
            const container = { innerHTML: '' };
            const session = { Id: 's-sum-3', NowPlayingItem: { Name: 'Direct Movie' }, PlayMethod: 'DirectPlay' };
            dash.renderDashboardContainer(container, [session], [session]);
            assert.ok(container.innerHTML.includes('class="playback-summary-stat stat-transcode">'), 'stat-transcode has no "active" class when transcoding count is zero');
        });

        it('still counts a paused Transcode session as Transcoding, not as neither bucket (Direct + Transcoding must always sum to the total)', () => {
            const dash = createMockDashboard();
            const pausedTranscode = {
                Id: 's-sum-paused-tc', IsPaused: true, NowPlayingItem: { Name: 'Paused Transcode' },
                TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false }
            };
            const html = dash.buildSummaryStripHtml([pausedTranscode]);
            assert.match(html, /playback-summary-value">1<\/span><span class="playback-summary-label">Active Stream</, 'Total is 1');
            assert.match(html, /stat-direct">[\s\S]*?playback-summary-value">0</, 'Direct bucket is 0 -- this session is not direct');
            assert.ok(html.includes('stat-transcode active') && /stat-transcode active">[\s\S]*?playback-summary-value">1</.test(html), 'Transcoding bucket is 1 even though the session is paused, since it is still genuinely transcoding');
        });

        it('high-signal pills (resolution, dynamic range, audio, subtitle) carry a leading icon; codec/bit-depth/container pills stay icon-free', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-pill-icons', NowPlayingItem: {
                    Name: 'Icon Test', Width: 3840, Height: 2160, Container: 'mkv',
                    MediaStreams: [
                        { Type: 'Video', Codec: 'hevc', VideoRange: 'HDR', BitDepth: 10, Width: 3840, Height: 2160 },
                        { Type: 'Audio', Codec: 'eac3', Channels: 6, ChannelLayout: '5.1', Profile: 'Dolby Atmos' }
                    ]
                }
            };
            const html = dash.renderSessionCard(session, 0, 'extended', false);
            assert.ok(/<span class="playback-pill res"><svg class="pill-icon"/.test(html), 'Resolution pill leads with an icon');
            assert.ok(/<span class="playback-pill hdr"><svg class="pill-icon"/.test(html), 'HDR pill leads with an icon');
            assert.ok(/<span class="playback-pill audio"><svg class="pill-icon"/.test(html), 'Audio pill leads with an icon');
            assert.ok(!/<span class="playback-pill "><svg/.test(html), 'Plain codec/bit-depth/container pills stay icon-free');
        });

        it('places the progress bar directly under the title/subtitle, above the technical pill row', () => {
            const dash = createMockDashboard();
            const session = {
                Id: 's-layout', NowPlayingItem: { Name: 'Layout Test', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }] },
                RunTimeTicks: 3600 * 10000000, PositionTicks: 1800 * 10000000
            };
            const html = dash.renderSessionCard(session, 0, 'compact', false);
            const titleIdx = html.indexOf('playback-card-title');
            const progressIdx = html.indexOf('playback-card-progress');
            const pillRowIdx = html.indexOf('playback-pill-row');
            assert.ok(titleIdx > -1 && progressIdx > -1 && pillRowIdx > -1, 'All three sections are present');
            assert.ok(titleIdx < progressIdx, 'Progress bar comes after the title');
            assert.ok(progressIdx < pillRowIdx, 'Progress bar comes before the technical pill row, not after it');
            assert.ok(html.indexOf('playback-card-main') < titleIdx, 'Title still lives inside the poster/body row');
        });
    });

    describe('24. playbackcard.html parity: summary strip, pill icons, progress-under-title layout', () => {
        it('high-signal pills carry a leading icon on the standalone My Playback page too', () => {
            controller.setDisplayMode('extended');
            const session = {
                Id: 's-html-icons', NowPlayingItem: {
                    Name: 'Icon Parity Test', Width: 3840, Height: 2160, Container: 'mkv',
                    MediaStreams: [
                        { Type: 'Video', Codec: 'hevc', VideoRange: 'HDR', Width: 3840, Height: 2160 },
                        { Type: 'Audio', Codec: 'eac3', Channels: 6, ChannelLayout: '5.1' }
                    ]
                }
            };
            const html = controller.renderSessionCard(session, 0);
            assert.ok(/<span class="playback-pill res"><svg class="pill-icon"/.test(html), 'Resolution pill leads with an icon');
            assert.ok(/<span class="playback-pill audio"><svg class="pill-icon"/.test(html), 'Audio pill leads with an icon');
        });

        it('places the progress bar directly under the title/subtitle, above the pill row, on the standalone page', () => {
            controller.setDisplayMode('compact');
            const session = {
                Id: 's-html-layout', NowPlayingItem: { Name: 'Layout Parity Test', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }] },
                RunTimeTicks: 3600 * 10000000, PositionTicks: 1800 * 10000000
            };
            const html = controller.renderSessionCard(session, 0);
            const titleIdx = html.indexOf('playback-card-title');
            const progressIdx = html.indexOf('playback-card-progress');
            const pillRowIdx = html.indexOf('playback-pill-row');
            assert.ok(titleIdx > -1 && progressIdx > -1 && pillRowIdx > -1, 'All three sections are present');
            assert.ok(titleIdx < progressIdx && progressIdx < pillRowIdx, 'Progress bar sits between the title and the technical pill row');
        });

        it('summary strip reflects a real Direct/Transcoding split and hides itself for zero sessions', () => {
            const directSession = { Id: 's-html-sum-1', NowPlayingItem: { Name: 'Direct' }, PlayMethod: 'DirectPlay' };
            const transcodeSession = { Id: 's-html-sum-2', NowPlayingItem: { Name: 'Transcode' }, PlayMethod: 'Transcode', TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false } };
            const html = controller.buildSummaryStripHtml([directSession, transcodeSession]);
            assert.match(html, /playback-summary-value">2<\/span><span class="playback-summary-label">Active Streams/);
            assert.ok(html.includes('stat-transcode active'), 'Transcoding stat is active when at least one session is transcoding');
            assert.equal(controller.buildSummaryStripHtml([]), '', 'No markup at all when there are zero sessions');
        });
    });
});


