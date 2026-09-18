using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.PlaybackCard.Notifications;

/// <summary>
/// Native server-side notification delivery background service.
/// Implements destination isolation, priority queueing, progress coalescing,
/// deduplication, and graceful shutdown.
/// </summary>
public sealed class NotificationDeliveryService : BackgroundService, INotificationDeliveryService
{
    private readonly ILogger<NotificationDeliveryService> _logger;
    private readonly IDiscordWebhookSender _discordSender;
    private readonly ITelegramBotApiSender _telegramSender;
    private readonly INotificationSecretStore _secretStore;

    private readonly DestinationQueue _discordQueue;
    private readonly DestinationQueue _telegramQueue;

    // Deduplication state
    private readonly ConcurrentDictionary<string, DateTimeOffset> _startDedupe = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _stopDedupe = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _pauseResumeDedupe = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _progressDedupe = new();

    // Diagnostics state
    private DateTimeOffset? _lastAttemptTimestamp;
    private DateTimeOffset? _lastSuccessTimestamp;
    private string? _lastFailureCategory;
    private string? _lastFailureDescription;
    private int _lastHttpStatus;
    private int _dedupeCount;
    private int _retryCount;
    private int _rateLimitDropCount;
    private int _validationFailureCount;
    private string _workerState = "Idle";
    private string _discordAvailability = "Available";
    private string _telegramAvailability = "Available";

    public NotificationDeliveryService(
        ILogger<NotificationDeliveryService> logger,
        IDiscordWebhookSender discordSender,
        ITelegramBotApiSender telegramSender,
        INotificationSecretStore secretStore)
    {
        _logger = logger;
        _discordSender = discordSender;
        _telegramSender = telegramSender;
        _secretStore = secretStore;

        _discordQueue = new DestinationQueue("Discord", capacity: 100, reservedCritical: 20);
        _telegramQueue = new DestinationQueue("Telegram", capacity: 100, reservedCritical: 20);
    }

    /// <inheritdoc />
    public void Enqueue(PlaybackEventRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);

        var config = Plugin.Instance?.Configuration;
        if (config == null || !config.NotificationsEnabled)
        {
            return;
        }

        // 1. User Filtering
        if (!IsUserAllowed(record, config))
        {
            return;
        }

        // 2. Event Type Enablement Check
        if (!IsEventEnabled(record, config))
        {
            return;
        }

        // 3. Deduplication Check
        if (ShouldDedupe(record, config))
        {
            Interlocked.Increment(ref _dedupeCount);
            return;
        }

        // 4. Enqueue to independent destination queues
        if (config.DiscordEnabled)
        {
            var discordUrl = _secretStore.GetDiscordWebhookUrl();
            if (!string.IsNullOrWhiteSpace(discordUrl))
            {
                _discordQueue.Enqueue(record);
            }
        }

        if (config.TelegramEnabled)
        {
            var token = _secretStore.GetTelegramBotToken();
            if (!string.IsNullOrWhiteSpace(token) && !string.IsNullOrWhiteSpace(config.TelegramChatId))
            {
                _telegramQueue.Enqueue(record);
            }
        }
    }

    private static bool IsUserAllowed(PlaybackEventRecord record, PluginConfiguration config)
    {
        if (config.UserFilterMode == UserFilterMode.AllUsers)
        {
            return true;
        }

        var selected = config.SelectedUserIds;
        var hasUser = (!string.IsNullOrEmpty(record.UserId) && selected.Contains(record.UserId)) ||
                      (!string.IsNullOrEmpty(record.Username) && selected.Contains(record.Username));

        return config.UserFilterMode switch
        {
            UserFilterMode.Whitelist => hasUser,
            UserFilterMode.Blacklist => !hasUser,
            _ => true
        };
    }

    private static bool IsEventEnabled(PlaybackEventRecord record, PluginConfiguration config)
    {
        return record.EventType switch
        {
            NotificationEventType.Start => config.NotifyOnStart,
            NotificationEventType.Stop => config.NotifyOnStop,
            NotificationEventType.Completion => config.NotifyOnCompletion,
            NotificationEventType.Pause => config.NotifyOnPauseResume,
            NotificationEventType.Resume => config.NotifyOnPauseResume,
            NotificationEventType.Progress => config.NotifyOnProgress,
            _ => false
        };
    }

    // Effectively-unbounded dedupe window: used where the original semantics were "dedupe for as
    // long as the entry exists" (no time-based expiry other than explicit removal or TTL pruning),
    // as opposed to a rolling cooldown window.
    private static readonly TimeSpan IndefiniteDedupeWindow = TimeSpan.MaxValue;

    /// <remarks>
    /// Internal (rather than private) so tests in JellyfinPlaybackCard.Tests (see
    /// <c>[InternalsVisibleTo]</c> in Plugin.cs) can drive concurrent calls directly to verify the
    /// atomic dedupe check-and-record behavior below.
    /// </remarks>
    internal bool ShouldDedupe(PlaybackEventRecord record, PluginConfiguration config)
    {
        var now = DateTimeOffset.UtcNow;
        var sessionKey = record.InternalSessionKey;

        // Cleanup dedupe caches periodically if memory grows (bounded TTL)
        if (_startDedupe.Count > 500) PruneCache(_startDedupe, TimeSpan.FromMinutes(2), now);
        if (_stopDedupe.Count > 500) PruneCache(_stopDedupe, TimeSpan.FromMinutes(10), now);
        if (_pauseResumeDedupe.Count > 500) PruneCache(_pauseResumeDedupe, TimeSpan.FromMinutes(1), now);
        if (_progressDedupe.Count > 500) PruneCache(_progressDedupe, TimeSpan.FromMinutes(30), now);

        if (record.EventType == NotificationEventType.Start)
        {
            // A new start event establishes/resets session: clear old dedupe state
            _stopDedupe.TryRemove(sessionKey, out _);
            _pauseResumeDedupe.TryRemove(sessionKey, out _);
            _progressDedupe.TryRemove(sessionKey, out _);

            // Start deduplicated within 10s
            return IsDuplicateAndRecord(_startDedupe, sessionKey, TimeSpan.FromSeconds(10), now);
        }

        if (record.EventType == NotificationEventType.Stop || record.EventType == NotificationEventType.Completion)
        {
            // Primary dedupe: 1 stop per sessionKey (indefinitely, until Start clears it or TTL prunes it)
            if (!string.IsNullOrEmpty(sessionKey))
            {
                return IsDuplicateAndRecord(_stopDedupe, sessionKey, IndefiniteDedupeWindow, now);
            }

            // Fallback dedupe: composite key with 10s cooldown
            var fallbackKey = $"fallback:{record.UserId}:{record.MediaTitle}:{record.ClientName}";
            return IsDuplicateAndRecord(_stopDedupe, fallbackKey, TimeSpan.FromSeconds(10), now);
        }

        if (record.EventType == NotificationEventType.Pause || record.EventType == NotificationEventType.Resume)
        {
            // 5s debounce for pause/resume
            var prKey = $"{sessionKey}:{record.EventType}";
            return IsDuplicateAndRecord(_pauseResumeDedupe, prKey, TimeSpan.FromSeconds(5), now);
        }

        if (record.EventType == NotificationEventType.Progress)
        {
            // Throttled by progress interval
            var intervalMin = Math.Max(5, config.ProgressIntervalMinutes);
            return IsDuplicateAndRecord(_progressDedupe, sessionKey, TimeSpan.FromMinutes(intervalMin), now);
        }

        return false;
    }

    /// <summary>
    /// Atomically checks whether <paramref name="now"/> falls within the dedupe <paramref name="window"/>
    /// of the last recorded timestamp for <paramref name="key"/> and, if not, records <paramref name="now"/>
    /// as the new "last sent" timestamp for that key.
    /// This performs the check-then-write as a single atomic <see cref="ConcurrentDictionary{TKey,TValue}"/>
    /// AddOrUpdate operation so two near-simultaneous calls for the same key cannot both observe "not a duplicate"
    /// and both proceed to send (the classic TOCTOU race of a separate TryGetValue followed by an
    /// indexer write). Whichever invocation's result is the one actually committed by the dictionary
    /// is guaranteed to have been computed from the true current value at the moment it was committed.
    /// </summary>
    private static bool IsDuplicateAndRecord(ConcurrentDictionary<string, DateTimeOffset> cache, string key, TimeSpan window, DateTimeOffset now)
    {
        var duplicate = false;

        cache.AddOrUpdate(
            key,
            addValueFactory: static (_, state) => state,
            updateValueFactory: (_, existing, state) =>
            {
                if (state - existing < window)
                {
                    duplicate = true;
                    return existing; // Not enough time has passed: leave the recorded timestamp untouched.
                }

                duplicate = false;
                return state;
            },
            factoryArgument: now);

        return duplicate;
    }

    private static void PruneCache(ConcurrentDictionary<string, DateTimeOffset> cache, TimeSpan maxAge, DateTimeOffset now)
    {
        foreach (var kvp in cache)
        {
            if (now - kvp.Value > maxAge)
            {
                cache.TryRemove(kvp.Key, out _);
            }
        }
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[Notifications] Playback notification delivery engine started.");
        _workerState = "Running";

        var discordTask = ProcessDiscordQueueAsync(stoppingToken);
        var telegramTask = ProcessTelegramQueueAsync(stoppingToken);

        await Task.WhenAll(discordTask, telegramTask).ConfigureAwait(false);
        _workerState = "Stopped";
    }

    private async Task ProcessDiscordQueueAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var record = await _discordQueue.DequeueAsync(stoppingToken).ConfigureAwait(false);
                if (record == null) continue;

                var config = Plugin.Instance?.Configuration;
                var webhookUrl = _secretStore.GetDiscordWebhookUrl();
                if (config == null || !config.DiscordEnabled || string.IsNullOrWhiteSpace(webhookUrl))
                {
                    continue;
                }

                var payload = record.ToOutboundPayload(config.UsernameDisclosure, config.ClientDeviceDisclosure);

                _lastAttemptTimestamp = DateTimeOffset.UtcNow;
                var result = await _discordSender.SendAsync(payload, webhookUrl, stoppingToken).ConfigureAwait(false);

                _lastHttpStatus = result.StatusCode;

                if (result.Success)
                {
                    _lastSuccessTimestamp = DateTimeOffset.UtcNow;
                    _discordAvailability = "Available";
                }
                else
                {
                    _lastFailureCategory = result.Category;
                    _lastFailureDescription = result.Description;
                    _discordAvailability = result.IsPermanentFailure ? "Unavailable" : "Degraded";

                    if (result.StatusCode == 429)
                    {
                        Interlocked.Increment(ref _rateLimitDropCount);
                    }
                    else if (result.Category.Equals("InvalidConfiguration", StringComparison.OrdinalIgnoreCase))
                    {
                        Interlocked.Increment(ref _validationFailureCount);
                    }

                    if (result.StatusCode >= 500 || result.StatusCode == 408)
                    {
                        Interlocked.Increment(ref _retryCount);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError("[DiscordWorker] Unexpected loop error: {Error}", SecretRedactor.SanitizeExceptionMessage(ex));
            }
        }
    }

    private async Task ProcessTelegramQueueAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var record = await _telegramQueue.DequeueAsync(stoppingToken).ConfigureAwait(false);
                if (record == null) continue;

                var config = Plugin.Instance?.Configuration;
                var botToken = _secretStore.GetTelegramBotToken();
                if (config == null || !config.TelegramEnabled ||
                    string.IsNullOrWhiteSpace(botToken) ||
                    string.IsNullOrWhiteSpace(config.TelegramChatId))
                {
                    continue;
                }

                var payload = record.ToOutboundPayload(config.UsernameDisclosure, config.ClientDeviceDisclosure);

                _lastAttemptTimestamp = DateTimeOffset.UtcNow;
                var result = await _telegramSender.SendAsync(payload, botToken, config.TelegramChatId, stoppingToken).ConfigureAwait(false);

                _lastHttpStatus = result.StatusCode;

                if (result.Success)
                {
                    _lastSuccessTimestamp = DateTimeOffset.UtcNow;
                    _telegramAvailability = "Available";
                }
                else
                {
                    _lastFailureCategory = result.Category;
                    _lastFailureDescription = result.Description;
                    _telegramAvailability = result.IsPermanentFailure ? "Unavailable" : "Degraded";

                    if (result.StatusCode == 429)
                    {
                        Interlocked.Increment(ref _rateLimitDropCount);
                    }
                    else if (result.Category.Equals("InvalidConfiguration", StringComparison.OrdinalIgnoreCase))
                    {
                        Interlocked.Increment(ref _validationFailureCount);
                    }

                    if (result.StatusCode >= 500 || result.StatusCode == 408)
                    {
                        Interlocked.Increment(ref _retryCount);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError("[TelegramWorker] Unexpected loop error: {Error}", SecretRedactor.SanitizeExceptionMessage(ex));
            }
        }
    }

    /// <inheritdoc />
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("[Notifications] Stopping notification service. Initiating 3-second drain budget...");
        _workerState = "Draining";

        using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, drainCts.Token);

        try
        {
            await base.StopAsync(linkedCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("[Notifications] Drain budget expired during server shutdown.");
        }
        finally
        {
            _workerState = "Stopped";
        }
    }

    /// <inheritdoc />
    public async Task<DeliveryResult> SendTestNotificationAsync(string destination, CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration;
        if (config == null)
        {
            return DeliveryResult.Failed("InvalidConfiguration", 500, permanent: true, description: "Plugin configuration is not initialized.");
        }

        if (string.Equals(destination, "discord", StringComparison.OrdinalIgnoreCase))
        {
            var webhookUrl = _secretStore.GetDiscordWebhookUrl();
            if (string.IsNullOrWhiteSpace(webhookUrl))
            {
                return DeliveryResult.Failed("InvalidConfiguration", 400, permanent: true, description: "Discord Webhook URL is not configured. Save a valid Discord Webhook URL first.");
            }
            return await _discordSender.SendTestAsync(webhookUrl, cancellationToken).ConfigureAwait(false);
        }

        if (string.Equals(destination, "telegram", StringComparison.OrdinalIgnoreCase))
        {
            var botToken = _secretStore.GetTelegramBotToken();
            if (string.IsNullOrWhiteSpace(botToken))
            {
                return DeliveryResult.Failed("InvalidConfiguration", 400, permanent: true, description: "Telegram Bot Token is not configured. Save a valid bot token first.");
            }
            if (string.IsNullOrWhiteSpace(config.TelegramChatId))
            {
                return DeliveryResult.Failed("InvalidConfiguration", 400, permanent: true, description: "Telegram Chat ID is not configured. Save a valid Chat ID or @channel username first.");
            }
            return await _telegramSender.SendTestAsync(botToken, config.TelegramChatId, cancellationToken).ConfigureAwait(false);
        }

        return DeliveryResult.Failed("InvalidConfiguration", 400, permanent: true, description: $"Unsupported destination '{destination}'. Supported destinations: 'Discord', 'Telegram'.");
    }

    /// <inheritdoc />
    public NotificationDiagnosticsSnapshot GetDiagnostics()
    {
        var config = Plugin.Instance?.Configuration;
        var discordWebhook = _secretStore.GetDiscordWebhookUrl();
        var discordConfigured = !string.IsNullOrWhiteSpace(discordWebhook) && DiscordWebhookSender.ValidateWebhookUrl(discordWebhook, out _, out _);

        var telegramToken = _secretStore.GetTelegramBotToken();
        var telegramConfigured = !string.IsNullOrWhiteSpace(telegramToken) &&
                                 !string.IsNullOrWhiteSpace(config?.TelegramChatId) &&
                                 TelegramBotApiSender.ValidateEndpoint(telegramToken, config.TelegramChatId, out _, out _);

        var discordState = !discordConfigured ? "Unconfigured" : _discordAvailability;
        var telegramState = !telegramConfigured ? "Unconfigured" : _telegramAvailability;

        return new NotificationDiagnosticsSnapshot
        {
            NotificationsEnabled = config?.NotificationsEnabled ?? false,
            DiscordEnabled = config?.DiscordEnabled ?? false,
            TelegramEnabled = config?.TelegramEnabled ?? false,
            LastAttemptTimestamp = _lastAttemptTimestamp,
            LastSuccessTimestamp = _lastSuccessTimestamp,
            LastSanitizedFailureCategory = _lastFailureCategory,
            LastFailureDescription = _lastFailureDescription,
            LastHttpStatus = _lastHttpStatus,
            QueueCapacity = 100,
            DiscordQueueDepth = _discordQueue.QueueDepth,
            TelegramQueueDepth = _telegramQueue.QueueDepth,
            DroppedProgressCount = _discordQueue.DroppedProgressCount + _telegramQueue.DroppedProgressCount,
            DroppedCriticalCount = _discordQueue.DroppedCriticalCount + _telegramQueue.DroppedCriticalCount,
            CoalescedProgressCount = _discordQueue.CoalescedProgressCount + _telegramQueue.CoalescedProgressCount,
            DedupeCount = _dedupeCount,
            RetryCount = _retryCount,
            RateLimitDropCount = _rateLimitDropCount,
            ValidationFailureCount = _validationFailureCount,
            WorkerState = _workerState,
            DiscordAvailabilityState = discordState,
            TelegramAvailabilityState = telegramState
        };
    }

    public override void Dispose()
    {
        _discordQueue.Dispose();
        _telegramQueue.Dispose();
        base.Dispose();
    }

    /// <summary>
    /// Thread-safe bounded priority queue with progress coalescing and drop-oldest capabilities.
    /// </summary>
    public sealed class DestinationQueue : IDisposable
    {
        private readonly object _lock = new();
        private readonly SemaphoreSlim _signal = new(0);
        private readonly LinkedList<PlaybackEventRecord> _criticalQueue = new();
        private readonly LinkedList<PlaybackEventRecord> _nonCriticalQueue = new();

        private readonly int _capacity;
        private readonly int _nonCriticalLimit;
        private int _droppedProgressCount;
        private int _droppedCriticalCount;
        private int _coalescedProgressCount;

        public DestinationQueue(string name, int capacity = 100, int reservedCritical = 20)
        {
            _capacity = capacity;
            _nonCriticalLimit = Math.Max(1, capacity - reservedCritical);
        }

        public int DroppedProgressCount => Volatile.Read(ref _droppedProgressCount);
        public int DroppedCriticalCount => Volatile.Read(ref _droppedCriticalCount);
        public int CoalescedProgressCount => Volatile.Read(ref _coalescedProgressCount);

        public int QueueDepth
        {
            get
            {
                lock (_lock)
                {
                    return _criticalQueue.Count + _nonCriticalQueue.Count;
                }
            }
        }

        public void Dispose()
        {
            _signal.Dispose();
        }

        public void Enqueue(PlaybackEventRecord record)
        {
            ArgumentNullException.ThrowIfNull(record);

            lock (_lock)
            {
                var isCritical = record.EventType is NotificationEventType.Start
                    or NotificationEventType.Stop
                    or NotificationEventType.Completion;

                if (!isCritical)
                {
                    // Progress / Pause / Resume coalescing check
                    for (var node = _nonCriticalQueue.First; node != null; node = node.Next)
                    {
                        if (node.Value.InternalSessionKey == record.InternalSessionKey)
                        {
                            // Coalesce: replace existing pending non-critical with newer
                            node.Value = record;
                            Interlocked.Increment(ref _coalescedProgressCount);
                            return; // Signal count remains identical
                        }
                    }

                    // Check non-critical capacity limit
                    if (_criticalQueue.Count + _nonCriticalQueue.Count >= _nonCriticalLimit)
                    {
                        Interlocked.Increment(ref _droppedProgressCount);
                        return; // Drop non-critical under queue pressure
                    }

                    _nonCriticalQueue.AddLast(record);
                    _signal.Release();
                    return;
                }

                // Critical event (Start / Stop / Completion)
                if (_criticalQueue.Count + _nonCriticalQueue.Count >= _capacity)
                {
                    // Drop oldest non-critical first to make room for critical
                    if (_nonCriticalQueue.Count > 0)
                    {
                        _nonCriticalQueue.RemoveFirst();
                        Interlocked.Increment(ref _droppedProgressCount);
                        _criticalQueue.AddLast(record);
                        // Net count unchanged, signal count remains valid
                        return;
                    }

                    // If queue is completely filled with critical items, drop oldest critical
                    _criticalQueue.RemoveFirst();
                    Interlocked.Increment(ref _droppedCriticalCount);
                    _criticalQueue.AddLast(record);
                    // Net count unchanged, signal count remains valid
                    return;
                }

                _criticalQueue.AddLast(record);
                _signal.Release();
            }
        }

        public async Task<PlaybackEventRecord?> DequeueAsync(CancellationToken cancellationToken)
        {
            await _signal.WaitAsync(cancellationToken).ConfigureAwait(false);

            lock (_lock)
            {
                if (_criticalQueue.Count > 0)
                {
                    var item = _criticalQueue.First!.Value;
                    _criticalQueue.RemoveFirst();
                    return item;
                }

                if (_nonCriticalQueue.Count > 0)
                {
                    var item = _nonCriticalQueue.First!.Value;
                    _nonCriticalQueue.RemoveFirst();
                    return item;
                }

                return null;
            }
        }
    }
}
