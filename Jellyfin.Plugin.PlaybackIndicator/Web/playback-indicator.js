/**
 * Jellyfin Playback Indicator
 * Injects direct-play / transcode badges on episode and movie rows.
 * Works by calling Jellyfin's GetPostedPlaybackInfo API with the current device profile.
 */
(function () {
    'use strict';

    const PLUGIN_ID = 'playback-indicator';
    const CACHE_PREFIX = 'jpi_cache_';
    const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

    // Badge states
    const BADGE_DIRECT = { cls: 'jpi-badge-direct', icon: '&#x2705;', label: 'Direct Play' };
    const BADGE_TRANSCODE = { cls: 'jpi-badge-transcode', icon: '&#x26A0;', label: 'Will Transcode' };
    const BADGE_LOADING = { cls: 'jpi-badge-loading', icon: '&#x1F504;', label: 'Checking...' };
    const BADGE_ERROR = { cls: 'jpi-badge-error', icon: '&#x274C;', label: 'Error' };

    // ─── Utility ────────────────────────────────────────────────────────────────

    function getCache(key) {
        try {
            var raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() > entry.expires) {
                localStorage.removeItem(CACHE_PREFIX + key);
                return null;
            }
            return entry.data;
        } catch (_) {
            return null;
        }
    }

    function setCache(key, data, ttlMs) {
        try {
            var entry = { data: data, expires: Date.now() + (ttlMs || DEFAULT_CACHE_TTL_MS) };
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
        } catch (_) { }
    }

    function getDeviceId() {
        // Use Jellyfin's stored device ID from the API client
        if (window.ConnectionManager) {
            var servers = window.ConnectionManager._servers || [];
            for (var i = 0; i < servers.length; i++) {
                var server = servers[i];
                if (server.deviceId) return server.deviceId;
            }
        }
        return 'unknown';
    }

    function getCurrentServerInfo() {
        if (window.ConnectionManager) {
            var servers = window.ConnectionManager._servers || [];
            for (var i = 0; i < servers.length; i++) {
                var server = servers[i];
                if (server.accessToken) return server;
            }
        }
        return null;
    }

    function buildAuthHeader(serverInfo) {
        if (!serverInfo) return '';
        var userId = serverInfo.userId || '';
        var deviceId = serverInfo.deviceId || '';
        var tokenType = window.ApiClient ? 'MediaBrowser' : 'Emby';
        return 'MediaBrowser UserId="' + userId + '", DeviceId="' + deviceId + '", Token="' + serverInfo.accessToken + '"';
    }

    // ─── API Calls ───────────────────────────────────────────────────────────────

    /**
     * Fetch device profile from Jellyfin's API client.
     * We read the active profile from the session's playback profile.
     */
    function getCurrentDeviceProfile() {
        // The Jellyfin web client stores the device profile in AppStorage
        // or in the active user session. We try window.AppHost first.
        var profile = null;

        if (window.AppHost) {
            try {
                profile = window.AppHost.profile;
            } catch (_) { }
        }

        if (!profile && window.SessionManager) {
            try {
                var sessions = window.SessionManager.sessionModel ? [window.SessionManager.sessionModel] : [];
                for (var i = 0; i < sessions.length; i++) {
                    if (sessions[i].playbackProfile) {
                        profile = sessions[i].playbackProfile;
                        break;
                    }
                }
            } catch (_) { }
        }

        if (!profile) {
            // Fallback to a sensible default profile for modern browsers
            profile = {
                Name: 'Jellyfin Web',
                Id: null,
                Type: 'Browser',
                IsLocalPlayback: false,
                SupportsExternalDisplay: false,
                SupportsAV1: true,
                SupportsVP9: true,
                SupportsVP8: true,
                SupportsH264: true,
                SupportsH265: true,
                SupportsH263: false,
                SupportsMPEG4Part2: false,
                SupportsMPEG1Video: true,
                SupportsMPEG2Video: true,
                SupportsMPEG1Audio: true,
                SupportsAAC: true,
                SupportsMP3: true,
                SupportsFLAC: true,
                SupportsALAC: true,
                SupportsOpus: true,
                SupportsVorbis: true,
                SupportsWMAPro: false,
                SupportsWMA: true,
                SupportsDTS: true,
                SupportsDTSHD: true,
                SupportsTrueHD: true,
                SupportsEAC3: true,
                SupportsEAC3Atmos: true,
                SupportsDTSAtmos: true,
                SupportsTrueHDAtmos: true,
                SupportsAACLatm: false,
                SupportsAc3: true,
                SupportsAsf: false,
                SupportsFMP4: true,
                SupportsWebS Subtitles: true,
                SupportsBandwidthLimitedDirectPlay: true,
                RequiresVideoTranscoding: false,
                RequiresAudioTranscoding: false,
                RequiresLossyAudioTranscoding: false,
                RequiresNoColorSpaceConversion: false,
                RequiresNoVideoDepthConversion: false,
                RequiresVideoBitrateMatches: false,
                RequiresVideoBitrateLessThan: false,
                RequiresAudioBitrateMatches: false,
                RequiresAudioBitrateLessThan: false,
                RequiresVideoResolutionLessThan: false,
                RequiresVideoResolutionMatches: false,
                RequiresVideoCodecSelection: false,
                RequiresAudioCodecSelection: false,
                CodecProfiles: [],
                ResponseProfiles: [],
                DirectPlayProfiles: [
                    {
                        Protocol: 'hls',
                        Container: 'mp4,m4v',
                        AudioCodec: 'aac,mp3,ac3',
                        VideoCodec: 'h264,h265,av1'
                    },
                    {
                        Protocol: 'http',
                        Container: 'mkv,mp4,m4v,mov,mpegts,mpeg,mpeg2video',
                        AudioCodec: 'aac,mp3,ac3,eac3,opus,flac,alac,pcm',
                        VideoCodec: 'h264,h265,av1,mpeg1video,mpeg2video,vp8,vp9'
                    },
                    {
                        Protocol: 'file',
                        Container: 'mkv,mp4,m4v,mov,avi,mpeg,mpg,ts,webm',
                        AudioCodec: 'aac,mp3,ac3,eac3,opus,flac,alac,pcm',
                        VideoCodec: 'h264,h265,av1,mpeg1video,mpeg2video,vp8,vp9'
                    }
                ]
            };
        }

        return profile;
    }

    /**
     * Call Jellyfin's GetPostedPlaybackInfo endpoint for an item.
     * Returns a promise resolving to { isEligibleForDirectPlay, transcodingReasons }.
     */
    function fetchPlaybackInfo(itemId) {
        return new Promise(function (resolve, reject) {
            var serverInfo = getCurrentServerInfo();
            if (!serverInfo || !serverInfo.accessToken) {
                // Not logged in — skip silently
                reject(new Error('not authenticated'));
                return;
            }

            var profile = getCurrentDeviceProfile();
            var deviceId = serverInfo.deviceId || getDeviceId();

            var requestBody = {
                UserId: serverInfo.userId || '',
                DeviceProfile: profile,
                DeviceId: deviceId,
                MediaSourceId: null,
                PlaybackMediaSourceUrl: null,
                AutoOpenLiveStream: false,
                MaxStreamingBitrate: null,
                MaxAudioChannels: null,
                StartTimeTicks: null,
                LiveStreamId: null,
                IsPlayback: false,
                AutoCorrect文史: false,
                EnableMsProstituting: false,
                AllowAudioLiveStreams: false,
                CurrentRuntimeTicks: null,
                ControllerData: null
            };

            var url = serverInfo.serverUrl + '/Items/' + itemId + '/PlaybackInfo';

            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('X-Emby-Authorization', buildAuthHeader(serverInfo));
            xhr.setRequestHeader('X-Media-Browser-Client', 'Jellyfin Web');
            xhr.setRequestHeader('X-Media-Browser-Client-Version', window.EmbyServerVersion || '10.11.0');

            xhr.onload = function () {
                if (xhr.status === 200 || xhr.status === 201) {
                    try {
                        var response = JSON.parse(xhr.responseText);
                        var eligible = response.IsEligibleForDirectPlay !== false;
                        var reasons = response.TranscodingReasons || [];
                        resolve({
                            isEligibleForDirectPlay: eligible && reasons.length === 0,
                            transcodingReasons: reasons,
                            playbackSources: response.PlaybackSources || []
                        });
                    } catch (e) {
                        reject(new Error('parse error'));
                    }
                } else {
                    reject(new Error('http ' + xhr.status));
                }
            };

            xhr.onerror = function () { reject(new Error('network error')); };

            try {
                xhr.send(JSON.stringify(requestBody));
            } catch (e) {
                reject(e);
            }
        });
    }

    // ─── DOM Injection ──────────────────────────────────────────────────────────

    function createBadgeElement(state, itemId) {
        var span = document.createElement('span');
        span.className = 'jpi-badge ' + state.cls;
        span.setAttribute('title', state.label + ' — ' + itemId);
        span.setAttribute('data-item-id', itemId);
        span.innerHTML = '<span class="jpi-badge-icon">' + state.icon + '</span>';
        return span;
    }

    function injectBadge(row, itemId, state) {
        // Avoid double-injection
        if (row.querySelector('.jpi-badge')) return;

        var badge = createBadgeElement(state, itemId);

        // Try to find the name element within the row
        var nameEl = row.querySelector('.予-seriesEpisodeName, .media-name, [class*="name"], .cardName, a[data-id]');
        if (nameEl) {
            nameEl.insertAdjacentElement('afterend', badge);
        } else {
            // Fallback: prepend to the row
            row.insertAdjacentElement('afterbegin', badge);
        }
    }

    function getItemIdFromRow(row) {
        return row.getAttribute('data-id')
            || row.getAttribute('data-seriesid')
            || (row.querySelector('a[data-id]') || row.querySelector('a[href*="/libraries/items/"]') || {}).getAttribute('href', '').split('/').pop()
            || null;
    }

    // ─── Page Scanning ──────────────────────────────────────────────────────────

    function scanAndAnnotate() {
        var rows = [];

        // Series/Season episode list: rows with .episodeItem or .listItem
        var episodeRows = document.querySelectorAll(
            '.episodeItem, .listItem, paper-item[data-id], [data-id].episode, [data-id].listItem'
        );

        // Movie cards
        var movieCards = document.querySelectorAll(
            '.card, .metadata-section, [data-id].movie, [data-type="Movie"] .card'
        );

        // Prefer pages with visible items
        var targetRows = [];
        if (episodeRows.length > 0) {
            targetRows = Array.prototype.slice.call(episodeRows);
        } else if (movieCards.length > 0) {
            targetRows = Array.prototype.slice.call(movieCards);
        }

        if (targetRows.length === 0) return;

        var cfg = getPluginConfig();
        var ttl = (cfg.cacheTtlMinutes || 60) * 60 * 1000;
        var deviceKey = getDeviceId();

        for (var i = 0; i < targetRows.length; i++) {
            var row = targetRows[i];
            var itemId = getItemIdFromRow(row);
            if (!itemId || itemId.length < 5) continue;

            // Skip already-processed
            if (row.querySelector('.jpi-badge')) continue;

            var cacheKey = itemId + '_' + deviceKey;
            var cached = getCache(cacheKey);

            if (cached) {
                var state = cached.isEligible ? BADGE_DIRECT : BADGE_TRANSCODE;
                injectBadge(row, itemId, state);
            } else {
                // Show loading badge
                injectBadge(row, itemId, BADGE_LOADING);

                // Fetch live
                (function (row, itemId, cacheKey, ttl) {
                    fetchPlaybackInfo(itemId).then(function (result) {
                        var state = result.isEligibleForDirectPlay ? BADGE_DIRECT : BADGE_TRANSCODE;
                        injectBadge(row, itemId, state);
                        setCache(cacheKey, { isEligible: result.isEligibleForDirectPlay }, ttl);

                        // Invalidate when user plays the item
                        window.addEventListener('beforeunload', function onPlay() {
                            localStorage.removeItem(CACHE_PREFIX + cacheKey);
                            window.removeEventListener('beforeunload', onPlay);
                        }, { once: true });
                    }).catch(function (err) {
                        // Silently remove loading badge on error rather than showing error badge
                        var badge = row.querySelector('.jpi-badge-loading');
                        if (badge) badge.remove();
                        // Also remove any existing jpi badge
                        var existing = row.querySelector('.jpi-badge');
                        if (existing && existing.classList.contains('jpi-badge-loading')) existing.remove();
                    });
                })(row, itemId, cacheKey, ttl);
            }
        }
    }

    // ─── Plugin Config ─────────────────────────────────────────────────────────

    function getPluginConfig() {
        // Try reading from Jellyfin plugin config store
        if (window.PluginManager) {
            try {
                var plugin = window.PluginManager.getPlugin('playback-indicator');
                if (plugin && plugin.configuration) return plugin.configuration;
            } catch (_) { }
        }
        return {
            cacheTtlMinutes: 60,
            showBadgeOnMovies: true,
            showBadgeOnEpisodes: true
        };
    }

    // ─── SPA Router Hook ────────────────────────────────────────────────────────

    var lastUrl = '';

    function onRouteChanged() {
        var currentUrl = window.location.href;
        if (currentUrl === lastUrl) return;
        lastUrl = currentUrl;

        // Only process library/item pages — skip other routes
        var isLibraryPage =
            /\/libraries\/items\//.test(currentUrl) ||
            /\/series\//.test(currentUrl) ||
            /\/movies\//.test(currentUrl) ||
            /\/tv\//.test(currentUrl) ||
            /\/homev1\/items\//.test(currentUrl) ||
            /page\(/.test(currentUrl) && !/search/.test(currentUrl);

        if (!isLibraryPage) return;

        // Allow DOM to settle before scanning
        setTimeout(scanAndAnnotate, 800);
    }

    function init() {
        // Inject the badge stylesheet once
        if (!document.getElementById('jpi-styles')) {
            var style = document.createElement('style');
            style.id = 'jpi-styles';
            style.textContent = [
                '.jpi-badge {',
                '  display: inline-flex;',
                '  align-items: center;',
                '  gap: 3px;',
                '  margin-left: 6px;',
                '  padding: 1px 5px;',
                '  border-radius: 4px;',
                '  font-size: 11px;',
                '  font-weight: 600;',
                '  line-height: 1.4;',
                '  vertical-align: middle;',
                '  white-space: nowrap;',
                '}',
                '.jpi-badge-icon { font-size: 10px; }',
                '.jpi-badge-direct { background: #1a6b2a; color: #ffffff; }',
                '.jpi-badge-transcode { background: #7a5f00; color: #ffffff; }',
                '.jpi-badge-loading { background: #333333; color: #cccccc; }',
                '.jpi-badge-error { background: #6b1a1a; color: #ffffff; }',
                // Jellyfin dark-theme compatible text
                '.jpi-badge { text-shadow: none; }'
            ].join('\n');
            (document.head || document.documentElement).appendChild(style);
        }

        // Jellyfin SPA router events — listen for route changes
        if (window.embyRouter) {
            window.embyRouter.on('routechanged', onRouteChanged);
        }

        if (window.AppEvents) {
            window.AppEvents.on('viewstackchange', function (stack) {
                // viewstack change typically means a page was pushed onto the nav stack
                setTimeout(onRouteChanged, 500);
            });
        }

        // Fallback: poll for URL changes
        setInterval(function () {
            if (window.location.href !== lastUrl) onRouteChanged();
        }, 1500);

        // Run immediately for current page
        onRouteChanged();

        console.log('[PlaybackIndicator] Initialized');
    }

    // Wait for Jellyfin to be fully loaded before initializing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(init, 1000);
        });
    } else {
        setTimeout(init, 1000);
    }
})();
