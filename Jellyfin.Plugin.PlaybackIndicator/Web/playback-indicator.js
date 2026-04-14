/**
 * Jellyfin Playback Indicator v0.4.0
 * Shows Direct Play / Direct Stream / Transcode badges on items.
 * Uses Jellyfin's session-based device profile with PlaybackInfo API.
 *
 * Approach:
 *  1. Get the current client's session via GET /Sessions
 *  2. Extract DeviceProfile from the session
 *  3. POST /Items/{id}/PlaybackInfo with that profile
 *  4. Trust Jellyfin's SupportsDirectPlay / SupportsDirectStream / SupportsTranscoding
 *
 * Badge states:
 *  Direct Play   (green)  — SupportsDirectPlay = true
 *  Direct Stream (yellow) — SupportsDirectStream = true, DirectPlay = false
 *  Transcode     (red)    — only SupportsTranscoding = true
 */
(function () {
    'use strict';

    var VERSION = '0.4.0';
    var CACHE_PREFIX = 'jpi_v3_';
    var DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
    var SCAN_INTERVAL_MS = 2500;

    var BADGES = {
        direct:    { cls: 'jpi-direct',    icon: '\u2705', label: 'Direct Play' },
        stream:    { cls: 'jpi-stream',    icon: '\u26A0\uFE0F', label: 'Direct Stream' },
        transcode: { cls: 'jpi-transcode', icon: '\u274C', label: 'Transcode' },
        loading:   { cls: 'jpi-loading',   icon: '\u23F3', label: 'Checking...' }
    };

    var PLAYABLE_TYPES = { 'Episode': 1, 'Movie': 1 };

    var _intervals = [];
    var _destroyed = false;
    var _lastUrl = '';
    var _processing = {};
    var _skippedItems = {};
    var _typeCache = {};
    var _cachedDeviceProfile = null;

    // ─── Cleanup ─────────────────────────────────────────────────────────────

    function cleanup() {
        _destroyed = true;
        for (var i = 0; i < _intervals.length; i++) clearInterval(_intervals[i]);
        _intervals = [];
        var styles = document.getElementById('jpi-styles');
        if (styles) styles.remove();
        var badges = document.querySelectorAll('.jpi-badge-overlay, .jpi-badge-inline');
        for (var j = 0; j < badges.length; j++) badges[j].remove();
        var keys = Object.keys(localStorage);
        for (var k = 0; k < keys.length; k++) {
            if (keys[k].indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(keys[k]);
        }
    }
    window.__jpi_cleanup = cleanup;

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function getApiClient() {
        return window.ApiClient || null;
    }

    function getServerAddress(apiClient) {
        if (apiClient.serverAddress) return apiClient.serverAddress();
        return apiClient._serverAddress || '';
    }

    function getUserId(apiClient) {
        if (apiClient.getCurrentUserId) return apiClient.getCurrentUserId();
        return (apiClient._currentUser && apiClient._currentUser.Id) || '';
    }

    function getDeviceId(apiClient) {
        if (apiClient.deviceId) return apiClient.deviceId();
        return apiClient._deviceId || 'default';
    }

    function getAuthHeader(apiClient) {
        var token = apiClient.accessToken ? apiClient.accessToken() : '';
        var deviceId = getDeviceId(apiClient);
        var clientName = apiClient._clientName || 'Jellyfin Web';
        var clientVersion = apiClient._clientVersion || '10.11.0';
        var deviceName = apiClient._deviceName || 'Browser';
        return 'MediaBrowser Client="' + clientName + '", Device="' + deviceName +
            '", DeviceId="' + deviceId + '", Version="' + clientVersion +
            '", Token="' + token + '"';
    }

    function apiGet(url, apiClient) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.timeout = 8000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject(new Error('parse error')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('network error')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };
            xhr.open('GET', url, true);
            xhr.setRequestHeader('X-Emby-Authorization', getAuthHeader(apiClient));
            xhr.send();
        });
    }

    function apiPost(url, body, apiClient) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.timeout = 10000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject(new Error('parse error')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('network error')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('X-Emby-Authorization', getAuthHeader(apiClient));
            xhr.send(JSON.stringify(body));
        });
    }

    // ─── Cache ───────────────────────────────────────────────────────────────

    function getCache(key) {
        try {
            var raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() > entry.expires) { localStorage.removeItem(CACHE_PREFIX + key); return null; }
            return entry.data;
        } catch (e) { return null; }
    }

    function setCache(key, data, ttlMs) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({
                data: data, expires: Date.now() + (ttlMs || DEFAULT_CACHE_TTL_MS)
            }));
        } catch (e) { }
    }

    // ─── Device Profile ──────────────────────────────────────────────────────

    /**
     * Get the device profile from the current session.
     * Falls back to apiClient._deviceProfile or a minimal browser profile.
     * Cached for the browser session (cleared on URL change).
     */
    function getDeviceProfile(apiClient) {
        if (_cachedDeviceProfile) return Promise.resolve(_cachedDeviceProfile);

        var server = getServerAddress(apiClient);
        var userId = getUserId(apiClient);
        var deviceId = getDeviceId(apiClient);

        return apiGet(server + '/Sessions?UserId=' + userId + '&DeviceId=' + encodeURIComponent(deviceId), apiClient)
            .then(function (sessions) {
                if (sessions && sessions.length > 0 && sessions[0].DeviceProfile) {
                    _cachedDeviceProfile = sessions[0].DeviceProfile;
                    return _cachedDeviceProfile;
                }
                // Fallback: try apiClient internal profile
                if (apiClient._deviceProfile) {
                    _cachedDeviceProfile = apiClient._deviceProfile;
                    return _cachedDeviceProfile;
                }
                // Fallback: build minimal profile from canPlayType
                _cachedDeviceProfile = buildMinimalDeviceProfile();
                return _cachedDeviceProfile;
            })
            .catch(function () {
                // Session API failed — try fallbacks
                if (apiClient._deviceProfile) {
                    _cachedDeviceProfile = apiClient._deviceProfile;
                    return _cachedDeviceProfile;
                }
                _cachedDeviceProfile = buildMinimalDeviceProfile();
                return _cachedDeviceProfile;
            });
    }

    /**
     * Build a minimal DeviceProfile from the browser's canPlayType().
     * This is a last-resort fallback if session doesn't have a profile.
     */
    function buildMinimalDeviceProfile() {
        var video = document.createElement('video');
        function can(mime) {
            try { var r = video.canPlayType(mime); return r === 'probably' || r === 'maybe'; }
            catch (e) { return false; }
        }

        var directPlayProfiles = [];
        var transcodingProfiles = [];

        // Video profiles
        var videoCodecs = [];
        if (can('video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
        if (can('video/mp4; codecs="hvc1"') || can('video/mp4; codecs="hev1"')) videoCodecs.push('hevc');
        if (can('video/mp4; codecs="av01.0.01M.08"')) videoCodecs.push('av1');
        if (can('video/webm; codecs="vp9"')) videoCodecs.push('vp9');
        if (can('video/webm; codecs="vp8"')) videoCodecs.push('vp8');

        var audioCodecs = [];
        if (can('audio/mp4; codecs="mp4a.40.2"')) audioCodecs.push('aac');
        if (can('audio/mpeg')) audioCodecs.push('mp3');
        if (can('audio/mp4; codecs="ac-3"')) audioCodecs.push('ac3');
        if (can('audio/mp4; codecs="ec-3"')) audioCodecs.push('eac3');
        if (can('audio/flac')) audioCodecs.push('flac');
        if (can('audio/webm; codecs="opus"')) audioCodecs.push('opus');
        if (can('audio/webm; codecs="vorbis"')) audioCodecs.push('vorbis');

        var audioStr = audioCodecs.join(',');
        var mp4VideoStr = videoCodecs.filter(function (c) { return c !== 'vp9' && c !== 'vp8'; }).join(',');
        var webmVideoStr = videoCodecs.filter(function (c) { return c === 'vp9' || c === 'vp8'; }).join(',');

        if (mp4VideoStr) {
            directPlayProfiles.push({
                Container: 'mp4,m4v,mov',
                Type: 'Video',
                VideoCodec: mp4VideoStr,
                AudioCodec: audioStr
            });
        }
        if (webmVideoStr) {
            directPlayProfiles.push({
                Container: 'webm',
                Type: 'Video',
                VideoCodec: webmVideoStr,
                AudioCodec: audioCodecs.filter(function (c) { return c === 'opus' || c === 'vorbis'; }).join(',')
            });
        }

        // Audio-only direct play
        if (audioCodecs.length > 0) {
            directPlayProfiles.push({
                Container: 'mp3,mp4,m4a,flac,webm,ogg,wav',
                Type: 'Audio'
            });
        }

        // Transcoding profile — always offer mp4/h264/aac as fallback
        transcodingProfiles.push({
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            Context: 'Streaming',
            Protocol: 'http',
            MaxAudioChannels: '2'
        });

        return {
            DirectPlayProfiles: directPlayProfiles,
            TranscodingProfiles: transcodingProfiles,
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: [
                { Format: 'srt', Method: 'External' },
                { Format: 'ass', Method: 'External' },
                { Format: 'ssa', Method: 'External' },
                { Format: 'vtt', Method: 'External' },
                { Format: 'sub', Method: 'External' },
                { Format: 'subrip', Method: 'External' },
                { Format: 'pgssub', Method: 'Embed' }
            ]
        };
    }

    // ─── PlaybackInfo API ────────────────────────────────────────────────────

    /**
     * Call POST /Items/{id}/PlaybackInfo with the device profile.
     * Returns { type: 'direct'|'stream'|'transcode', reason: string|null }
     */
    function fetchPlaybackInfo(itemId, deviceProfile, apiClient) {
        var server = getServerAddress(apiClient);
        var userId = getUserId(apiClient);
        var deviceId = getDeviceId(apiClient);

        var body = {
            UserId: userId,
            DeviceProfile: deviceProfile,
            MaxStreamingBitrate: 120000000,
            StartTimeTicks: 0,
            IsPlayback: false,
            AutoOpenLiveStream: false,
            MediaSourceId: null
        };

        var url = server + '/Items/' + itemId + '/PlaybackInfo?UserId=' + userId +
            '&DeviceId=' + encodeURIComponent(deviceId);

        return apiPost(url, body, apiClient).then(function (resp) {
            return parsePlaybackResponse(resp);
        });
    }

    /**
     * Parse PlaybackInfo response — trust Jellyfin's decisions.
     */
    function parsePlaybackResponse(resp) {
        var sources = resp.MediaSources;
        if (!sources || sources.length === 0) {
            return { type: 'transcode', reason: 'no sources' };
        }

        var src = sources[0];

        // Trust Jellyfin's flags directly
        if (src.SupportsDirectPlay) {
            return { type: 'direct', reason: null };
        }
        if (src.SupportsDirectStream) {
            return { type: 'stream', reason: buildReason(src) };
        }
        if (src.SupportsTranscoding) {
            return { type: 'transcode', reason: buildReason(src) };
        }

        return { type: 'transcode', reason: 'no supported playback method' };
    }

    function buildReason(src) {
        var parts = [];
        if (src.TranscodingContainer) parts.push('container: ' + src.TranscodingContainer);
        if (src.TranscodingVideoCodec) parts.push('video: ' + src.TranscodingVideoCodec);
        if (src.TranscodingAudioCodec) parts.push('audio: ' + src.TranscodingAudioCodec);
        // Also check MediaStreams for original codec info
        if (parts.length === 0 && src.MediaStreams) {
            for (var i = 0; i < src.MediaStreams.length; i++) {
                var s = src.MediaStreams[i];
                if (s.Type === 'Video' && s.Codec) parts.push('video: ' + s.Codec);
                if (s.Type === 'Audio' && s.Codec) parts.push('audio: ' + s.Codec);
            }
        }
        return parts.join(', ') || null;
    }

    // ─── Item Type ───────────────────────────────────────────────────────────

    function fetchItemType(itemId, apiClient) {
        if (_typeCache.hasOwnProperty(itemId)) {
            return Promise.resolve(_typeCache[itemId]);
        }

        // Try context inference first (zero API calls)
        var inferred = inferItemTypeFromContext();
        if (inferred) {
            _typeCache[itemId] = inferred;
            return Promise.resolve(inferred);
        }

        // Fallback: API call
        var server = getServerAddress(apiClient);
        var userId = getUserId(apiClient);
        var url = server + '/Users/' + userId + '/Items/' + itemId;

        return apiGet(url, apiClient).then(function (data) {
            var type = data.Type || null;
            _typeCache[itemId] = type;
            return type;
        });
    }

    function inferItemTypeFromContext() {
        var path = window.location.hash || window.location.pathname || '';

        if (/[#/]details\?.*id=.*&serverId=/.test(path)) {
            var seasonSelector = document.querySelector('.seasons, [class*="season"], .episodeList, [class*="episode"]');
            if (seasonSelector) return 'Episode';
        }
        if (/[#/]list\?.*type=episode/i.test(path)) return 'Episode';
        if (/[#/]list\?.*type=movie/i.test(path)) return 'Movie';

        var headers = document.querySelectorAll('.sectionTitle, [class*="sectionTitle"], .pageTitle, h1');
        for (var i = 0; i < headers.length; i++) {
            var text = (headers[i].textContent || '').toLowerCase();
            if (/\bmovies?\b/.test(text)) return 'Movie';
            if (/\bepisodes?\b/.test(text) || /\bseason\b/.test(text)) return 'Episode';
        }

        if (/parentid=/i.test(path.toLowerCase())) {
            var epRows = document.querySelectorAll('[class*="episode"], .listItem .listItemBody [class*="parentName"]');
            if (epRows.length > 0) return 'Episode';
        }

        return null;
    }

    // ─── Badge DOM ───────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        var css = document.createElement('style');
        css.id = 'jpi-styles';
        css.textContent = [
            '.jpi-badge-overlay {',
            '  position: absolute; top: 4px; left: 4px; z-index: 10;',
            '  display: inline-flex; align-items: center; gap: 3px;',
            '  padding: 2px 6px; border-radius: 4px;',
            '  font-size: 10px; font-weight: 700; line-height: 1.3;',
            '  white-space: nowrap; cursor: default;',
            '  text-shadow: 0 1px 2px rgba(0,0,0,0.6);',
            '  font-family: inherit !important;',
            '  pointer-events: none !important;',
            '  box-shadow: 0 1px 3px rgba(0,0,0,0.4);',
            '}',
            '.jpi-badge-inline {',
            '  display: inline-flex; align-items: center; gap: 3px;',
            '  margin-left: auto; padding: 1px 6px; border-radius: 4px;',
            '  font-size: 10px; font-weight: 600; line-height: 1.4;',
            '  white-space: nowrap; cursor: default; flex-shrink: 0;',
            '  text-shadow: none; font-family: inherit !important;',
            '  pointer-events: none !important;',
            '}',
            '.jpi-direct { background: rgba(26,107,42,0.9); color: #fff; }',
            '.jpi-stream { background: rgba(122,95,0,0.9); color: #fff; }',
            '.jpi-transcode { background: rgba(139,26,26,0.9); color: #fff; }',
            '.jpi-loading { background: rgba(68,68,68,0.9); color: #ccc; animation: jpi-pulse 1.5s ease-in-out infinite; }',
            '@keyframes jpi-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(css);
    }

    function createBadge(type, itemId, reason, isOverlay) {
        var badge = BADGES[type] || BADGES.loading;
        var span = document.createElement('span');
        span.className = (isOverlay ? 'jpi-badge-overlay ' : 'jpi-badge-inline ') + badge.cls;
        span.setAttribute('data-jpi', itemId);
        span.setAttribute('title', badge.label + (reason ? ' \u2014 ' + reason : ''));
        span.textContent = badge.icon + ' ' + badge.label;
        return span;
    }

    // ─── Item Detection ──────────────────────────────────────────────────────

    function isInsideMediaContainer(el) {
        // Only badge items inside actual media card/row containers
        // Exclude sidebar, header, navigation
        var parent = el.closest('.mainDrawer, .skinHeader, [class*="sidebar"], nav, [role="navigation"]');
        return !parent;
    }

    function getItemId(el) {
        var id = el.getAttribute('data-id') || el.getAttribute('data-itemid');
        if (id && id.length > 5) return id;

        var link = el.querySelector('a[data-id], a[href*="/items/"], a[href*="id="]');
        if (link) {
            id = link.getAttribute('data-id');
            if (id && id.length > 5) return id;
            var href = link.getAttribute('href') || '';
            var match = href.match(/\/items\/([0-9a-f-]+)/i) || href.match(/[?&]id=([0-9a-f-]+)/i);
            if (match) return match[1];
        }

        var btn = el.querySelector('[data-id]');
        if (btn) {
            id = btn.getAttribute('data-id');
            if (id && id.length > 5) return id;
        }

        return null;
    }

    function findItemElements() {
        var selectors = [
            '.card[data-id]',
            '[data-id].card',
            '[data-id][class*="card"]',
            '[data-id][class*="Card"]',
            '[data-id][class*="itemCard"]',
            '[data-id][class*="portraitCard"]',
            '[data-id][class*="landscapeCard"]',
            '[data-id][class*="squareCard"]',
            '[data-id][class*="bannerCard"]',
            '[data-id][class*="backdropCard"]',
            '[data-id].listItem',
            '[data-id].episodeItem',
            '.listItem[data-id]',
            '[data-id][class*="listItem"]',
            '[data-id][class*="episode"]',
            '[data-id] .cardImageContainer',
            '[data-id] [class*="cardImage"]',
            '[data-id] [class*="CardImage"]'
        ];

        var seen = {};
        var results = [];

        for (var s = 0; s < selectors.length; s++) {
            try {
                var els = document.querySelectorAll(selectors[s]);
                for (var i = 0; i < els.length; i++) {
                    var target = els[i].closest('[data-id]') || els[i];
                    if (!target.getAttribute('data-id')) continue;
                    var id = target.getAttribute('data-id');
                    if (seen[id]) continue;
                    if (target.querySelector('[data-jpi]')) continue;
                    if (!isInsideMediaContainer(target)) continue;
                    seen[id] = true;
                    results.push(target);
                }
            } catch (e) { }
        }

        return results;
    }

    function isCardElement(el) {
        return !!(
            el.querySelector('.cardImageContainer, [class*="cardImage"], [class*="CardImage"], .cardBox, [class*="cardBox"]') ||
            (el.className && el.className.toString().match(/card/i))
        );
    }

    // ─── Badge Placement ─────────────────────────────────────────────────────

    function placeBadge(el, itemId, type, reason) {
        if (el.querySelector('[data-jpi="' + itemId + '"]')) return;

        if (isCardElement(el)) {
            var imgContainer = el.querySelector(
                '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], .cardBox, [class*="cardBox"]'
            );
            if (imgContainer) {
                var pos = window.getComputedStyle(imgContainer).position;
                if (pos === 'static') imgContainer.style.position = 'relative';
                imgContainer.appendChild(createBadge(type, itemId, reason, true));
            } else {
                el.appendChild(createBadge(type, itemId, reason, true));
            }
        } else {
            var rowBody = el.querySelector(
                '.listItemBody, [class*="listItemBody"], [class*="episodeBody"], .itemBody'
            );
            if (rowBody) {
                rowBody.parentNode.insertBefore(createBadge(type, itemId, reason, false), rowBody.nextSibling);
            } else {
                el.appendChild(createBadge(type, itemId, reason, false));
            }
        }
    }

    function removeBadges(el) {
        var badges = el.querySelectorAll('[data-jpi]');
        for (var i = 0; i < badges.length; i++) badges[i].remove();
    }

    // ─── Scan ────────────────────────────────────────────────────────────────

    function scan() {
        if (_destroyed) return;
        var elements = findItemElements();
        if (elements.length === 0) return;

        var apiClient = getApiClient();
        if (!apiClient) return;

        var deviceId = getDeviceId(apiClient);

        for (var i = 0; i < elements.length; i++) {
            (function (el) {
                var itemId = getItemId(el);
                if (!itemId) return;

                // Permanently skip confirmed non-playable types
                if (_skippedItems[itemId]) return;

                var cacheKey = itemId + '_' + deviceId;
                var cached = getCache(cacheKey);

                if (cached) {
                    placeBadge(el, itemId, cached.type, cached.reason);
                    return;
                }

                if (_processing[itemId]) return;
                _processing[itemId] = true;

                // First check item type — do NOT show any badge until confirmed playable
                fetchItemType(itemId, apiClient).then(function (type) {
                    if (_destroyed) return;
                    if (!PLAYABLE_TYPES[type]) {
                        _skippedItems[itemId] = true;
                        delete _processing[itemId];
                        return;
                    }

                    // Now show loading badge and fetch playback info
                    placeBadge(el, itemId, 'loading');

                    return getDeviceProfile(apiClient).then(function (profile) {
                        return fetchPlaybackInfo(itemId, profile, apiClient);
                    }).then(function (result) {
                        if (_destroyed) return;
                        removeBadges(el);
                        placeBadge(el, itemId, result.type, result.reason);
                        setCache(cacheKey, { type: result.type, reason: result.reason });
                        delete _processing[itemId];
                    });
                }).catch(function () {
                    removeBadges(el);
                    delete _processing[itemId];
                });
            })(elements[i]);
        }
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    function init() {
        if (_destroyed) return;
        injectStyles();

        _intervals.push(setInterval(scan, SCAN_INTERVAL_MS));
        _intervals.push(setInterval(function () {
            if (window.location.href !== _lastUrl) {
                _lastUrl = window.location.href;
                // Clear caches on navigation — new context
                _typeCache = {};
                _skippedItems = {};
                _cachedDeviceProfile = null;
                setTimeout(scan, 600);
            }
        }, 1000));

        setTimeout(scan, 1200);
        console.log('[PlaybackIndicator] v' + VERSION + ' initialized (session-based profile)');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
    } else {
        setTimeout(init, 1500);
    }
})();
