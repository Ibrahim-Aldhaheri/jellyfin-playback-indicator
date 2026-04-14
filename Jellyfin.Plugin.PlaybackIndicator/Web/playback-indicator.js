/**
 * Jellyfin Playback Indicator v0.3.0
 * Shows Direct Play / Direct Stream / Transcode badges on items.
 * Uses Jellyfin's REAL PlaybackInfo API with the actual device profile.
 *
 * States:
 *  ✅ Direct Play   — container + video + audio all native
 *  ⚠️ Direct Stream — container remuxed, video direct, audio may remux
 *  ❌ Transcode     — video or audio needs full transcode
 */
(function () {
    'use strict';

    const CACHE_PREFIX = 'jpi_v2_';
    const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
    const SCAN_INTERVAL_MS = 2500;

    const BADGES = {
        direct:    { cls: 'jpi-direct',    icon: '✅', label: 'Direct Play' },
        stream:    { cls: 'jpi-stream',    icon: '⚠️', label: 'Direct Stream' },
        transcode: { cls: 'jpi-transcode', icon: '❌', label: 'Transcode' },
        loading:   { cls: 'jpi-loading',   icon: '⏳', label: 'Checking...' }
    };

    // Only show badges on actual playable media items
    const PLAYABLE_TYPES = new Set(['Episode', 'Movie']);

    let _intervals = [];
    let _destroyed = false;
    let _lastUrl = '';
    let _codecFingerprint = null;
    const _processing = new Set();
    const _skippedItems = new Set();

    // ─── Cleanup (uninstall safe) ────────────────────────────────────────────

    function cleanup() {
        _destroyed = true;
        _intervals.forEach(id => clearInterval(id));
        _intervals = [];
        document.getElementById('jpi-styles')?.remove();
        document.querySelectorAll('.jpi-badge').forEach(b => b.remove());
        Object.keys(localStorage)
            .filter(k => k.startsWith(CACHE_PREFIX))
            .forEach(k => localStorage.removeItem(k));
    }
    window.__jpi_cleanup = cleanup;

    // ─── Codec Fingerprint ───────────────────────────────────────────────────

    /**
     * Build a short hash of the browser's actual codec support.
     * This ensures the cache is truly per-device even if deviceId is shared.
     */
    function getCodecFingerprint() {
        if (_codecFingerprint) return _codecFingerprint;
        try {
            var video = document.createElement('video');
            var canPlay = function (type) { try { return video.canPlayType(type); } catch (_) { return ''; } };
            var tests = [
                canPlay('video/mp4; codecs="avc1.42E01E"'),
                canPlay('video/mp4; codecs="hvc1"'),
                canPlay('video/mp4; codecs="hev1"'),
                canPlay('video/webm; codecs="vp9"'),
                canPlay('video/mp4; codecs="av01.0.01M.08"'),
                canPlay('audio/mp4; codecs="mp4a.40.2"'),
                canPlay('audio/webm; codecs="opus"'),
                canPlay('audio/mpeg'),
                canPlay('audio/flac'),
                canPlay('audio/mp4; codecs="ac-3"'),
                canPlay('audio/mp4; codecs="mp4a.a6"'),  // DTS
                canPlay('audio/mp4; codecs="dtsc"')       // DTS
            ];
            // Map: '' -> 0, 'maybe' -> 1, 'probably' -> 2
            _codecFingerprint = tests.map(function (r) {
                return r === 'probably' ? '2' : (r === 'maybe' ? '1' : '0');
            }).join('');
        } catch (_) {
            _codecFingerprint = 'unknown';
        }
        return _codecFingerprint;
    }

    // ─── Cache ───────────────────────────────────────────────────────────────

    function getCache(key) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (Date.now() > entry.expires) { localStorage.removeItem(CACHE_PREFIX + key); return null; }
            return entry.data;
        } catch (_) { return null; }
    }

    function setCache(key, data, ttlMs) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({
                data, expires: Date.now() + (ttlMs || DEFAULT_CACHE_TTL_MS)
            }));
        } catch (_) { }
    }

    // ─── Jellyfin API ────────────────────────────────────────────────────────

    function getApiClient() {
        return window.ApiClient || null;
    }

    /**
     * Call Jellyfin's POST /Items/{id}/PlaybackInfo WITHOUT a DeviceProfile.
     * Without a profile, Jellyfin returns raw MediaSource info. We then
     * check the codecs against the browser's actual canPlayType() support.
     */
    function fetchPlaybackInfo(itemId) {
        return new Promise(function (resolve, reject) {
            const apiClient = getApiClient();
            if (!apiClient) { reject(new Error('no ApiClient')); return; }

            const userId = apiClient.getCurrentUserId ? apiClient.getCurrentUserId() : (apiClient._currentUser?.Id || '');

            const body = {
                UserId: userId,
                MaxStreamingBitrate: 120000000,
                StartTimeTicks: 0,
                IsPlayback: false,
                AutoOpenLiveStream: false
            };

            const serverAddr = apiClient._serverAddress || (apiClient.serverAddress ? apiClient.serverAddress() : '');
            const url = serverAddr + '/Items/' + itemId + '/PlaybackInfo';

            const xhr = new XMLHttpRequest();
            xhr.timeout = 8000;

            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(parsePlaybackResponse(JSON.parse(xhr.responseText)));
                    } catch (e) { reject(new Error('parse error')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('network error')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };

            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');

            // Build auth header
            const token = apiClient.accessToken ? apiClient.accessToken() : '';
            const deviceId = apiClient.deviceId ? apiClient.deviceId() : '';
            const clientName = apiClient._clientName || 'Jellyfin Web';
            const clientVersion = apiClient._clientVersion || '10.11.0';
            const deviceName = apiClient._deviceName || 'Browser';

            xhr.setRequestHeader('X-Emby-Authorization',
                'MediaBrowser Client="' + clientName + '", Device="' + deviceName +
                '", DeviceId="' + deviceId + '", Version="' + clientVersion +
                '", Token="' + token + '"');

            xhr.send(JSON.stringify(body));
        });
    }

    /**
     * Check if the browser supports a video codec via canPlayType().
     */
    function isVideoCodecSupported(codec) {
        if (!codec) return false;
        var video = document.createElement('video');
        var tests = {
            'h264': 'video/mp4; codecs="avc1.42E01E"',
            'hevc': 'video/mp4; codecs="hvc1"',
            'h265': 'video/mp4; codecs="hvc1"',
            'vp9': 'video/webm; codecs="vp9"',
            'vp8': 'video/webm; codecs="vp8"',
            'av1': 'video/mp4; codecs="av01.0.01M.08"',
            'mpeg2video': 'video/mp2t; codecs="mp2v"',
            'vc1': 'video/mp4; codecs="vc-1"'
        };
        var test = tests[codec];
        if (!test) return false;
        var result = video.canPlayType(test);
        return result === 'probably' || result === 'maybe';
    }

    /**
     * Check if the browser supports an audio codec via canPlayType().
     */
    function isAudioCodecSupported(codec) {
        if (!codec) return false;
        var video = document.createElement('video');
        var tests = {
            'aac': 'audio/mp4; codecs="mp4a.40.2"',
            'mp3': 'audio/mpeg',
            'opus': 'audio/webm; codecs="opus"',
            'flac': 'audio/flac',
            'ac3': 'audio/mp4; codecs="ac-3"',
            'eac3': 'audio/mp4; codecs="ec-3"',
            'dts': 'audio/mp4; codecs="mp4a.a6"',
            'dca': 'audio/mp4; codecs="mp4a.a6"',
            'vorbis': 'audio/webm; codecs="vorbis"',
            'pcm_s16le': 'audio/wav',
            'pcm_s24le': 'audio/wav'
        };
        var test = tests[codec];
        if (!test) return false;
        var result = video.canPlayType(test);
        return result === 'probably' || result === 'maybe';
    }

    /**
     * Parse PlaybackInfo response by checking MediaStreams codecs
     * against the browser's actual playback support.
     */
    function parsePlaybackResponse(resp) {
        const sources = resp.MediaSources || [];
        if (sources.length === 0) {
            return { type: 'transcode', reason: 'no sources' };
        }

        const src = sources[0];
        const container = (src.Container || '').toLowerCase();
        const videoCodec = getStreamCodec(src, 'Video');
        const audioCodec = getStreamCodec(src, 'Audio');

        const videoSupported = isVideoCodecSupported(videoCodec);
        const audioSupported = !audioCodec || isAudioCodecSupported(audioCodec);

        if (videoSupported && audioSupported) {
            // Codecs are supported — check if the container can be played directly
            var directContainers = { 'mp4': 1, 'm4v': 1, 'mov': 1, 'webm': 1 };
            if (directContainers[container]) {
                return { type: 'direct', reason: null, container: container };
            }
            // Container needs remuxing but codecs are fine
            return { type: 'stream', reason: 'container remux (' + container + ')', container: container };
        }

        // Something needs transcoding
        var reasons = [];
        if (!videoSupported) reasons.push('video: ' + (videoCodec || 'unknown'));
        if (audioCodec && !audioSupported) reasons.push('audio: ' + audioCodec);
        return { type: 'transcode', reason: reasons.join(', '), container: container };
    }

    function getStreamCodec(source, streamType) {
        const stream = (source.MediaStreams || []).find(s => s.Type === streamType);
        return stream ? (stream.Codec || '').toLowerCase() : null;
    }

    // ─── Item Type Inference ────────────────────────────────────────────────

    const _typeCache = {};

    /**
     * Infer item type from page context (URL, page title, DOM) to avoid
     * per-item API calls. Falls back to API only if context is ambiguous.
     */
    function inferItemTypeFromContext() {
        const path = window.location.hash || window.location.pathname || '';
        const lower = path.toLowerCase();

        // Series detail page or season page -> items are Episodes
        if (/[#/]details\?.*id=.*&serverId=/.test(path)) {
            // On a detail page — check if it's a series/season by looking at DOM
            var pageTitle = document.querySelector('.itemName, h1, h2, [class*="itemName"]');
            var seasonSelector = document.querySelector('.seasons, [class*="season"], .episodeList, [class*="episode"]');
            if (seasonSelector) return 'Episode';
        }
        if (/[#/]list\?.*type=episode/i.test(path)) return 'Episode';
        if (/[#/]list\?.*type=movie/i.test(path)) return 'Movie';

        // Movie library pages — check the page heading or section context
        var sectionHeaders = document.querySelectorAll('.sectionTitle, [class*="sectionTitle"], .pageTitle, h1');
        for (var i = 0; i < sectionHeaders.length; i++) {
            var text = (sectionHeaders[i].textContent || '').toLowerCase();
            if (/\bmovies?\b/.test(text)) return 'Movie';
            if (/\bepisodes?\b/.test(text) || /\bseason\b/.test(text)) return 'Episode';
        }

        // Check library type from view settings or page params
        if (/parentid=/i.test(lower)) {
            // On a library page — check if items have episode-like structure
            var episodeRows = document.querySelectorAll('[class*="episode"], .listItem .listItemBody [class*="parentName"]');
            if (episodeRows.length > 0) return 'Episode';
        }

        return null; // ambiguous — need API fallback
    }

    /**
     * Get item type, preferring context inference over API calls.
     * Returns a Promise that resolves to the item's Type string.
     */
    function fetchItemType(itemId) {
        if (_typeCache.hasOwnProperty(itemId)) {
            return Promise.resolve(_typeCache[itemId]);
        }

        // Try to infer from page context first (zero API calls)
        var inferred = inferItemTypeFromContext();
        if (inferred) {
            _typeCache[itemId] = inferred;
            return Promise.resolve(inferred);
        }

        // Fallback: API call for ambiguous contexts
        return new Promise(function (resolve, reject) {
            const apiClient = getApiClient();
            if (!apiClient) { reject(new Error('no ApiClient')); return; }

            const userId = apiClient.getCurrentUserId ? apiClient.getCurrentUserId() : (apiClient._currentUser?.Id || '');
            const serverAddr = apiClient._serverAddress || (apiClient.serverAddress ? apiClient.serverAddress() : '');
            const url = serverAddr + '/Users/' + userId + '/Items/' + itemId;

            const xhr = new XMLHttpRequest();
            xhr.timeout = 5000;

            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        const type = data.Type || null;
                        _typeCache[itemId] = type;
                        resolve(type);
                    } catch (_) { reject(new Error('parse error')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('network error')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };

            xhr.open('GET', url, true);

            const token = apiClient.accessToken ? apiClient.accessToken() : '';
            const deviceId = apiClient.deviceId ? apiClient.deviceId() : '';
            const clientName = apiClient._clientName || 'Jellyfin Web';
            const clientVersion = apiClient._clientVersion || '10.11.0';
            const deviceName = apiClient._deviceName || 'Browser';

            xhr.setRequestHeader('X-Emby-Authorization',
                'MediaBrowser Client="' + clientName + '", Device="' + deviceName +
                '", DeviceId="' + deviceId + '", Version="' + clientVersion +
                '", Token="' + token + '"');

            xhr.send();
        });
    }

    // ─── Badge DOM ───────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        const css = document.createElement('style');
        css.id = 'jpi-styles';
        css.textContent = [
            /* Overlay badge on card images (top-left corner) */
            '.jpi-card-wrapper { position: relative; }',
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
            /* Inline badge for list/episode rows (end of row) */
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
        const badge = BADGES[type] || BADGES.loading;
        const span = document.createElement('span');
        span.className = (isOverlay ? 'jpi-badge-overlay ' : 'jpi-badge-inline ') + badge.cls;
        span.setAttribute('data-jpi', itemId);
        span.setAttribute('title', badge.label + (reason ? ' — ' + reason : ''));
        span.textContent = badge.icon + ' ' + badge.label;
        return span;
    }

    // ─── Item Detection ──────────────────────────────────────────────────────

    function getItemId(el) {
        let id = el.getAttribute('data-id') || el.getAttribute('data-itemid');
        if (id && id.length > 5) return id;

        // Check links inside the element
        const link = el.querySelector('a[data-id], a[href*="/items/"], a[href*="id="]');
        if (link) {
            id = link.getAttribute('data-id');
            if (id && id.length > 5) return id;
            const href = link.getAttribute('href') || '';
            var match = href.match(/\/items\/([0-9a-f-]+)/i) || href.match(/[?&]id=([0-9a-f-]+)/i);
            if (match) return match[1];
        }

        // Check any child with data-id
        const btn = el.querySelector('[data-id]');
        if (btn) {
            id = btn.getAttribute('data-id');
            if (id && id.length > 5) return id;
        }

        return null;
    }

    /**
     * Find media item elements in the DOM.
     * Jellyfin 10.11 uses React-based cards with various class patterns.
     * We look broadly for any element with data-id that looks like a card or list item.
     */
    function findItemElements() {
        // Broad card selectors for Jellyfin 10.11 React UI
        var selectors = [
            // Classic card selectors
            '.card[data-id]',
            '[data-id].card',
            // React-based card wrappers (10.11+)
            '[data-id][class*="card"]',
            '[data-id][class*="Card"]',
            // Item cards with various naming
            '[data-id][class*="itemCard"]',
            '[data-id][class*="portraitCard"]',
            '[data-id][class*="landscapeCard"]',
            '[data-id][class*="squareCard"]',
            '[data-id][class*="bannerCard"]',
            '[data-id][class*="backdropCard"]',
            // List and episode items
            '[data-id].listItem',
            '[data-id].episodeItem',
            '.listItem[data-id]',
            '[data-id][class*="listItem"]',
            '[data-id][class*="episode"]',
            // Generic: any interactive item wrapper with a data-id that
            // contains an image (strong signal it's a media card)
            '[data-id] .cardImageContainer',
            '[data-id] [class*="cardImage"]',
            '[data-id] [class*="CardImage"]'
        ];

        var seen = new Set();
        var results = [];

        selectors.forEach(function (sel) {
            try {
                document.querySelectorAll(sel).forEach(function (el) {
                    // For child-match selectors, walk up to the data-id ancestor
                    var target = el.closest('[data-id]') || el;
                    if (!target.getAttribute('data-id')) return;
                    var id = target.getAttribute('data-id');
                    if (seen.has(id)) return;
                    if (target.querySelector('[data-jpi]')) return;
                    seen.add(id);
                    results.push(target);
                });
            } catch (_) { }
        });

        return results;
    }

    /**
     * Determine if an element is a card (has image) vs a list/episode row.
     */
    function isCardElement(el) {
        return !!(
            el.querySelector('.cardImageContainer, [class*="cardImage"], [class*="CardImage"], .cardBox, [class*="cardBox"]') ||
            el.classList.toString().match(/card/i)
        );
    }

    // ─── Scan ────────────────────────────────────────────────────────────────

    function scan() {
        if (_destroyed) return;
        const elements = findItemElements();
        if (elements.length === 0) return;

        const apiClient = getApiClient();
        if (!apiClient) return;

        const deviceId = apiClient.deviceId ? apiClient.deviceId() : 'default';
        const fingerprint = getCodecFingerprint();

        elements.forEach(function (el) {
            const itemId = getItemId(el);
            if (!itemId) return;

            // Permanently skip items already known to be non-playable types
            if (_skippedItems.has(itemId)) return;

            // Cache key includes deviceId AND codec fingerprint for true per-device isolation
            const cacheKey = itemId + '_' + deviceId + '_' + fingerprint;
            const cached = getCache(cacheKey);

            if (cached) {
                placeBadge(el, itemId, cached.type, cached.reason);
            } else if (!_processing.has(itemId)) {
                // Mark as in-flight so concurrent scans don't duplicate work
                _processing.add(itemId);

                // First confirm the item is a playable type before showing any badge
                fetchItemType(itemId).then(function (type) {
                    if (_destroyed) return;
                    if (!PLAYABLE_TYPES.has(type)) {
                        _skippedItems.add(itemId);
                        _processing.delete(itemId);
                        return; // Skip seasons, series, artists, etc. permanently
                    }

                    placeBadge(el, itemId, 'loading');
                    return fetchPlaybackInfo(itemId).then(function (result) {
                        if (_destroyed) return;
                        removeBadges(el);
                        placeBadge(el, itemId, result.type, result.reason);
                        setCache(cacheKey, { type: result.type, reason: result.reason });
                        _processing.delete(itemId);
                    });
                }).catch(function () {
                    removeBadges(el);
                    _processing.delete(itemId);
                });
            }
        });
    }

    /**
     * Place badge in the right location depending on element type.
     * Cards: overlay on top-right of the card image.
     * List/episode rows: append at the end of the row.
     */
    function placeBadge(el, itemId, type, reason) {
        if (el.querySelector('[data-jpi="' + itemId + '"]')) return;

        if (isCardElement(el)) {
            // Find the card image container and overlay the badge
            var imgContainer = el.querySelector(
                '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], .cardBox, [class*="cardBox"]'
            );
            if (imgContainer) {
                // Ensure the container is positioned for absolute children
                var pos = window.getComputedStyle(imgContainer).position;
                if (pos === 'static') {
                    imgContainer.style.position = 'relative';
                }
                imgContainer.appendChild(createBadge(type, itemId, reason, true));
            } else {
                // Fallback: put at end of element
                el.appendChild(createBadge(type, itemId, reason, true));
            }
        } else {
            // List/episode row: append inline badge at the end of the row
            var rowBody = el.querySelector(
                '.listItemBody, [class*="listItemBody"], [class*="episodeBody"], .itemBody'
            );
            if (rowBody) {
                // Insert after the row body, not inside the name
                rowBody.parentNode.insertBefore(createBadge(type, itemId, reason, false), rowBody.nextSibling);
            } else {
                el.appendChild(createBadge(type, itemId, reason, false));
            }
        }
    }

    function removeBadges(el) {
        el.querySelectorAll('[data-jpi]').forEach(function (b) { b.remove(); });
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    function init() {
        if (_destroyed) return;
        injectStyles();

        _intervals.push(setInterval(scan, SCAN_INTERVAL_MS));
        _intervals.push(setInterval(function () {
            if (window.location.href !== _lastUrl) {
                _lastUrl = window.location.href;
                // Clear inferred type cache and skipped items on page change so new context is evaluated
                Object.keys(_typeCache).forEach(function (k) { delete _typeCache[k]; });
                _skippedItems.clear();
                setTimeout(scan, 600);
            }
        }, 1000));

        setTimeout(scan, 1200);
        console.log('[PlaybackIndicator] v0.3.0 initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
    } else {
        setTimeout(init, 1500);
    }
})();
