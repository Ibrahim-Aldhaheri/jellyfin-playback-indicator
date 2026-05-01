/**
 * Jellyfin Playback Indicator v0.5.4
 *
 * Shows Direct Play / Re-mux / Direct Stream / Transcode badges for items.
 *
 *  ✅ Direct Play   — file sent as-is; container, video, audio all native
 *  🔁 Re-mux        — container repackaged but video AND audio kept native
 *                     (lossless, very low CPU on the server)
 *  ⚠️ Direct Stream — container repackaged, video kept native, audio transcoded
 *  ❌ Transcode     — video re-encoded (and possibly audio too); expensive
 *
 * Accuracy strategy (in order of preference):
 *   1. Native shell. JMP and Android inject window.NativeShell.AppHost
 *      whose getDeviceProfile() returns the *exact* profile the native
 *      player uses. Same call jellyfin-web makes when starting playback.
 *   2. Pre-fetch the active session's DeviceProfile via GET /Sessions.
 *   3. Sniff outgoing real player calls (XHR + fetch) to /Items/{id}/PlaybackInfo
 *      and capture any richer profile they send.
 *   4. Synthetic profile as last resort.
 */
(function () {
    'use strict';

    const VERSION = '0.5.4';
    const PLUGIN_ID = 'b6f3e2a1-d4c5-4e7a-8b3f-9e2d1c0a8b5e';

    const RESULT_PREFIX = 'jpi_v8_';
    const TYPE_PREFIX = 'jpi_type_';
    const PROFILE_KEY = 'jpi_profile';
    const BITRATE_KEY = 'jpi_max_bitrate';
    const DEFAULT_MAX_BITRATE = 120000000; // 120 Mbps when nothing else known
    // Past prefixes are listed so uninstall + manual cache-clear sweep them.
    const ALL_PREFIXES = [
        'jpi_v2_', 'jpi_v3_', 'jpi_v4_', 'jpi_v5_', 'jpi_v6_', 'jpi_v7_', RESULT_PREFIX,
        TYPE_PREFIX, PROFILE_KEY, BITRATE_KEY, 'jpi_real_profile'
    ];

    const TYPE_TTL_MS = 24 * 60 * 60 * 1000;
    const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const SCAN_DEBOUNCE_MS = 350;
    const TYPE_BATCH_WINDOW_MS = 80;
    const MAX_CONCURRENT_LOOKUPS = 4;

    const TYPE = Object.freeze({
        DIRECT: 'direct', REMUX: 'remux', STREAM: 'stream', TRANSCODE: 'transcode'
    });

    const BADGES = {
        [TYPE.DIRECT]:    { cls: 'jpi-direct',    icon: '✅', label: 'Direct Play' },
        [TYPE.REMUX]:     { cls: 'jpi-remux',     icon: '🔁', label: 'Re-mux' },
        [TYPE.STREAM]:    { cls: 'jpi-stream',    icon: '⚠️', label: 'Direct Stream' },
        [TYPE.TRANSCODE]: { cls: 'jpi-transcode', icon: '❌', label: 'Transcode' }
    };

    const NON_PLAYABLE_TYPES = new Set([
        'Series', 'Season', 'BoxSet', 'CollectionFolder', 'Folder',
        'MusicArtist', 'MusicAlbum', 'Audio', 'Photo', 'PhotoAlbum',
        'Person', 'Genre', 'Studio', 'Playlist'
    ]);

    // Audio codecs that often claim to remux but actually fail on browsers/TVs.
    const FRAGILE_AUDIO = new Set(['truehd', 'mlp']);

    const CARD_IMAGE_SELECTOR =
        '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
        '.listItemImage, [class*="listItemImage"]';
    const PLACE_TARGET_SELECTOR =
        '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
        '.cardBox, [class*="cardBox"]';
    const LIST_BODY_SELECTOR =
        '.listItemBody, [class*="listItemBody"], [class*="episodeBody"], .itemBody';
    const DETAIL_TARGET_SELECTOR =
        '.itemMiscInfo-primary, .itemMiscInfo, [class*="itemMiscInfo"], ' +
        '.mainDetailButtons, [class*="mainDetailButtons"]';

    // Runtime config (overridable by server-side PluginConfiguration).
    const config = {
        resultTtlMs: 60 * 60 * 1000,
        showOnMovies: true,
        showOnEpisodes: true
    };

    // Module state.
    const state = {
        observer: null,
        scanTimer: null,
        destroyed: false,
        keySuffix: null,           // userId + deviceId + codecFp, computed once
        cachedProfile: null,       // parsed device profile, mirrored from localStorage
        cachedProfileFp: null,     // cheap fingerprint for change detection
        maxBitrate: DEFAULT_MAX_BITRATE, // user's actual MaxStreamingBitrate
        inflight: new Map(),       // itemId -> Promise<{type,reason}|null>
        activeLookups: 0,
        lookupQueue: [],
        typeBatch: null,           // { ids:[], waiters:Map, timer }
        sweepNeeded: false         // set when DOM nodes were removed
    };

    // ─── Boot ───────────────────────────────────────────────────────────────

    installProfileSniffer();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    function boot() {
        waitFor(function () {
            const ac = window.ApiClient;
            return ac && ac.accessToken && ac.accessToken() &&
                ac.getCurrentUserId && ac.getCurrentUserId();
        }, 500, 60).then(start, function () { /* user not logged in */ });
    }

    function waitFor(predicate, intervalMs, maxTries) {
        return new Promise(function (resolve, reject) {
            let tries = 0;
            const tick = function () {
                if (predicate()) return resolve();
                if (++tries > maxTries) return reject(new Error('timeout'));
                setTimeout(tick, intervalMs);
            };
            tick();
        });
    }

    function start() {
        if (state.destroyed) return;
        injectStyles();

        loadPersistedBitrate();
        loadServerConfig();
        primeDeviceProfile();
        attachObservers();

        scheduleScan(600);
        // eslint-disable-next-line no-console
        console.log('[PlaybackIndicator] v' + VERSION + ' active');
    }

    function loadServerConfig() {
        apiCall('GET', '/web/ConfigurationPages')
            .catch(function () { /* unavailable, that's fine */ });

        apiCall('GET', '/Plugins/' + PLUGIN_ID + '/Configuration')
            .then(function (cfg) {
                if (!cfg) return;
                if (typeof cfg.CacheTtlMinutes === 'number' && cfg.CacheTtlMinutes > 0) {
                    config.resultTtlMs = cfg.CacheTtlMinutes * 60 * 1000;
                }
                if (typeof cfg.ShowBadgeOnMovies === 'boolean') {
                    config.showOnMovies = cfg.ShowBadgeOnMovies;
                }
                if (typeof cfg.ShowBadgeOnEpisodes === 'boolean') {
                    config.showOnEpisodes = cfg.ShowBadgeOnEpisodes;
                }
            })
            .catch(function () { /* fall back to defaults */ });
    }

    function primeDeviceProfile() {
        getNativeShellProfile().then(function (nsProfile) {
            if (nsProfile) {
                logProfileSource('NativeShell.AppHost', nsProfile);
                persistProfile(nsProfile);
                return;
            }
            return fetchSessionProfile().then(function (profile) {
                if (profile) {
                    logProfileSource('session', profile);
                    persistProfile(profile);
                }
            });
        });
    }

    function logProfileSource(source, profile) {
        console.info('[PlaybackIndicator] using device profile from ' + source + ': ' +
            (profile.Name || '(unnamed)') +
            ' (' + (profile.DirectPlayProfiles || []).length + ' direct-play entries)');
    }

    function attachObservers() {
        state.observer = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m.removedNodes && m.removedNodes.length) state.sweepNeeded = true;
                if (mutationTouchesItems(m)) {
                    scheduleScan(SCAN_DEBOUNCE_MS);
                    return;
                }
            }
        });
        state.observer.observe(document.body, { childList: true, subtree: true });

        // SPA navigation in jellyfin-web fires popstate/hashchange — no need
        // for an interval poll on top of the MutationObserver.
        const onNav = function () {
            state.inflight.clear();
            state.lookupQueue.length = 0;
            scheduleScan(SCAN_DEBOUNCE_MS);
        };
        window.addEventListener('popstate', onNav);
        window.addEventListener('hashchange', onNav);
    }

    function mutationTouchesItems(m) {
        const added = m.addedNodes;
        if (!added || !added.length) return false;
        for (let i = 0; i < added.length; i++) {
            const n = added[i];
            if (n.nodeType !== 1) continue;
            if (n.hasAttribute && n.hasAttribute('data-id')) return true;
            if (n.querySelector && n.querySelector('[data-id]')) return true;
        }
        return false;
    }

    function scheduleScan(delay) {
        if (state.destroyed) return;
        clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(scan, delay);
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────

    window.__jpi_cleanup = function () {
        state.destroyed = true;
        if (state.observer) { try { state.observer.disconnect(); } catch (_) {} state.observer = null; }
        clearTimeout(state.scanTimer);
        const styles = document.getElementById('jpi-styles');
        if (styles) styles.remove();
        document.querySelectorAll('[data-jpi], [data-jpi-detail]').forEach(function (b) { b.remove(); });
        removeKeysWithPrefixes(ALL_PREFIXES);
    };

    function removeKeysWithPrefixes(prefixes) {
        try {
            const keys = Object.keys(localStorage);
            for (let i = 0; i < keys.length; i++) {
                for (let j = 0; j < prefixes.length; j++) {
                    if (keys[i].indexOf(prefixes[j]) === 0) {
                        localStorage.removeItem(keys[i]);
                        break;
                    }
                }
            }
        } catch (_) {}
    }

    // ─── Device profile sources ─────────────────────────────────────────────

    /**
     * Hook XMLHttpRequest AND fetch. When the real Jellyfin web client posts
     * to /Items/{id}/PlaybackInfo with a DeviceProfile, capture it. Our own
     * calls are marked with X-JPI-Self and skipped.
     */
    function installProfileSniffer() {
        const isPlaybackUrl = function (u) {
            return u && /\/Items\/[A-Fa-f0-9-]+\/PlaybackInfo/.test(u);
        };
        // jellyfin-web posts its full profile here right after connect.
        // Catching it gives us the authoritative profile without waiting
        // for the user to hit play — important on Android Mobile, where
        // the NativeShell API path is fragile.
        const isCapabilitiesUrl = function (u) {
            return u && /\/Sessions\/Capabilities(\/Full)?(\?|$)/.test(u);
        };

        const inspect = function (method, url, body) {
            const m = (method || '').toUpperCase();
            if (m !== 'POST') return;
            if (isPlaybackUrl(url) || isCapabilitiesUrl(url)) {
                captureProfileFromBody(body);
            }
        };

        try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

            XMLHttpRequest.prototype.open = function (method, url) {
                this.__jpiUrl = url;
                this.__jpiMethod = method;
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.setRequestHeader = function (name) {
                if (name === 'X-JPI-Self') { this.__jpiSelf = true; return; }
                return origSetHeader.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function (body) {
                if (!this.__jpiSelf) inspect(this.__jpiMethod, this.__jpiUrl, body);
                return origSend.apply(this, arguments);
            };
        } catch (_) {}

        if (typeof window.fetch === 'function') {
            try {
                const origFetch = window.fetch.bind(window);
                window.fetch = function (input, init) {
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url) || '';
                        const method = ((init && init.method) || (input && input.method) || 'GET');
                        const isSelf = headerLookup(init && init.headers, 'X-JPI-Self') === '1' ||
                                       headerLookup(input && input.headers, 'X-JPI-Self') === '1';
                        if (!isSelf) inspect(method, url, init && init.body);
                    } catch (_) {}
                    return origFetch(input, init);
                };
            } catch (_) {}
        }
    }

    function headerLookup(h, name) {
        if (!h) return null;
        try {
            if (typeof h.get === 'function') return h.get(name);
            const lower = name.toLowerCase();
            const keys = Object.keys(h);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i].toLowerCase() === lower) return h[keys[i]];
            }
        } catch (_) {}
        return null;
    }

    function captureProfileFromBody(body) {
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : null;
            if (!parsed) return;

            const dp = parsed.DeviceProfile;
            if (isUsableProfile(dp) && !isOurSyntheticName(dp.Name)) {
                persistProfile(dp);
            }

            // PlaybackInfo bodies also carry MaxStreamingBitrate (respects
            // the Display → Quality slider). Capabilities bodies don't.
            const bitrate = parsed.MaxStreamingBitrate;
            if (typeof bitrate === 'number' && bitrate > 0 && bitrate !== state.maxBitrate) {
                state.maxBitrate = bitrate;
                try { localStorage.setItem(BITRATE_KEY, String(bitrate)); } catch (_) {}
                invalidateResultCache();
                scheduleScan(SCAN_DEBOUNCE_MS);
            }
        } catch (_) {}
    }

    function isOurSyntheticName(n) {
        return n === 'PlaybackIndicator Synthetic' ||
            n === 'PlaybackIndicator Synthetic (browser)' ||
            n === 'PlaybackIndicator Synthetic (native shell)';
    }

    function loadPersistedBitrate() {
        try {
            const stored = localStorage.getItem(BITRATE_KEY);
            if (stored) {
                const n = parseInt(stored, 10);
                if (n > 0) state.maxBitrate = n;
            }
        } catch (_) {}
    }

    function isUsableProfile(p) {
        return p && Array.isArray(p.DirectPlayProfiles) && p.DirectPlayProfiles.length >= 1;
    }

    /**
     * Cheap fingerprint for change-detection: count + name + first profile's
     * containers. ~30 chars instead of stringifying a 10KB+ profile.
     */
    function profileFingerprint(p) {
        if (!p) return '';
        const dp = p.DirectPlayProfiles || [];
        const first = dp[0] || {};
        return (p.Name || '') + '|' + dp.length + '|' + (first.Container || '') + '|' + (first.AudioCodec || '');
    }

    function persistProfile(profile) {
        const fp = profileFingerprint(profile);
        if (fp === state.cachedProfileFp) return; // no change
        state.cachedProfile = profile;
        state.cachedProfileFp = fp;
        try {
            localStorage.setItem(PROFILE_KEY, JSON.stringify({
                profile: profile, captured: Date.now()
            }));
        } catch (_) {}
        invalidateResultCache();
        scheduleScan(SCAN_DEBOUNCE_MS);
    }

    function invalidateResultCache() {
        removeKeysWithPrefixes([RESULT_PREFIX]);
        state.inflight.clear();
        state.lookupQueue.length = 0;
        document.querySelectorAll('[data-jpi], [data-jpi-detail]').forEach(function (b) { b.remove(); });
    }

    /**
     * Ask the native shell. Different shells have different signatures:
     *  - JMP / desktop: getDeviceProfile() — returns the profile directly,
     *    extra args are ignored.
     *  - Android Mobile: getDeviceProfile(profileBuilder, version) — REQUIRES
     *    a profileBuilder callback that produces a base browser profile;
     *    the shell then layers its codec restrictions on top. Calling with
     *    no args throws inside profileBuilder({...}).
     *
     * Strategy: pass a real profileBuilder (returns our browser-style
     * synthetic) plus a version string. JMP ignores both; Android uses them
     * and we get its real profile.
     */
    function getNativeShellProfile() {
        return new Promise(function (resolve) {
            const ah = window.NativeShell && window.NativeShell.AppHost;
            const fn = ah && typeof ah.getDeviceProfile === 'function'
                ? ah.getDeviceProfile.bind(ah) : null;
            if (!fn) { resolve(null); return; }

            const builder = function () { return buildBrowserSyntheticProfile(); };
            const accept = function (p) { resolve(isUsableProfile(p) ? p : null); };

            const tryArgs = function (args) {
                try {
                    const r = fn.apply(null, args);
                    if (r && typeof r.then === 'function') {
                        return r.then(function (v) { return v; });
                    }
                    return Promise.resolve(r);
                } catch (e) { return Promise.reject(e); }
            };

            // With-builder first (covers Android Mobile); no-args second
            // (covers JMP and any shell that returns the profile directly).
            tryArgs([builder, '1.0.0'])
                .then(function (p) {
                    if (isUsableProfile(p)) accept(p);
                    else tryArgs([]).then(accept).catch(function () { resolve(null); });
                })
                .catch(function () {
                    tryArgs([]).then(accept).catch(function () { resolve(null); });
                });
        });
    }

    /**
     * Pre-fetch the device profile from the active session. Different clients
     * store it in different paths (top-level session.DeviceProfile vs
     * session.Capabilities.DeviceProfile); the session matching our DeviceId
     * is preferred when several are active.
     */
    function fetchSessionProfile() {
        return apiCall('GET', '/Sessions')
            .then(function (sessions) {
                return pickSessionProfile(sessions, getDeviceId());
            })
            .catch(function () { return null; });
    }

    function pickSessionProfile(sessions, myDeviceId) {
        if (!Array.isArray(sessions)) return null;
        const extract = function (s) {
            return (s && s.DeviceProfile) ||
                (s && s.Capabilities && s.Capabilities.DeviceProfile) || null;
        };
        for (let i = 0; i < sessions.length; i++) {
            if (sessions[i].DeviceId === myDeviceId) {
                const dp = extract(sessions[i]);
                if (isUsableProfile(dp)) return dp;
            }
        }
        for (let i = 0; i < sessions.length; i++) {
            const dp = extract(sessions[i]);
            if (isUsableProfile(dp)) return dp;
        }
        return null;
    }

    function getDeviceProfile() {
        if (state.cachedProfile) return state.cachedProfile;
        try {
            const raw = localStorage.getItem(PROFILE_KEY);
            if (raw) {
                const e = JSON.parse(raw);
                if (e.profile && (Date.now() - (e.captured || 0)) < PROFILE_TTL_MS) {
                    state.cachedProfile = e.profile;
                    state.cachedProfileFp = profileFingerprint(e.profile);
                    return state.cachedProfile;
                }
            }
        } catch (_) {}
        const synthetic = buildSyntheticProfile();
        state.cachedProfile = synthetic;
        state.cachedProfileFp = profileFingerprint(synthetic);
        return synthetic;
    }

    /**
     * True if running inside a native-shell wrapper (JMP, Android) where
     * canPlayType() doesn't reflect actual playback capability.
     */
    function isNativeShell() {
        if (window.NativeShell) return true;
        const ua = (navigator.userAgent || '').toLowerCase();
        if (/jellyfin-?media-?player|jellyfinandroid/.test(ua)) return true;
        try {
            const name = ((window.ApiClient && window.ApiClient._clientName) || '').toLowerCase();
            return /jellyfin\s*media\s*player|jellyfin.?mobile|jellyfin.?android|mpv\s*shim/.test(name);
        } catch (_) {}
        return false;
    }

    function buildSyntheticProfile() {
        return isNativeShell()
            ? buildNativeShellSyntheticProfile()
            : buildBrowserSyntheticProfile();
    }

    function buildNativeShellSyntheticProfile() {
        console.info('[PlaybackIndicator] native shell detected; using permissive synthetic profile');
        return {
            Name: 'PlaybackIndicator Synthetic (native shell)',
            MaxStreamingBitrate: 200000000,
            MaxStaticBitrate: 200000000,
            DirectPlayProfiles: [{
                Container: 'mp4,m4v,mov,mkv,avi,wmv,3gp,3g2,m2ts,mts,ts,mpegts,asf,flv,vob,ogm,ogv,webm',
                Type: 'Video',
                VideoCodec: 'h264,h265,hevc,vp8,vp9,av1,mpeg4,mpeg2video,vc1,wmv3',
                AudioCodec: 'aac,mp3,ac3,eac3,dts,dca,truehd,mlp,flac,opus,vorbis,wma,wmav2,pcm,pcm_s16le,pcm_s24le'
            }],
            TranscodingProfiles: [{
                Container: 'ts', Type: 'Video', VideoCodec: 'h264',
                AudioCodec: 'aac,mp3,ac3', Context: 'Streaming', Protocol: 'hls'
            }],
            CodecProfiles: [],
            ContainerProfiles: [],
            SubtitleProfiles: []
        };
    }

    function buildBrowserSyntheticProfile() {
        const probe = canPlayProbe();
        const supportsHevc = probe('video/mp4; codecs="hvc1"') || probe('video/mp4; codecs="hev1"');
        const supportsVP9 = probe('video/webm; codecs="vp9"');
        const supportsAV1 = probe('video/mp4; codecs="av01.0.01M.08"');
        const supportsAC3 = probe('audio/mp4; codecs="ac-3"') || probe('audio/ac3');

        // Seed with codecs every modern browser plays so empty canPlayType()
        // never strands us on "no codecs supported".
        const videoCodecs = ['h264', 'vp8'];
        if (supportsHevc) videoCodecs.push('hevc', 'h265');
        if (supportsVP9) videoCodecs.push('vp9');
        if (supportsAV1) videoCodecs.push('av1');

        const audioCodecs = ['aac', 'mp3', 'opus', 'flac', 'vorbis'];
        if (supportsAC3) audioCodecs.push('ac3', 'eac3');

        return {
            Name: 'PlaybackIndicator Synthetic (browser)',
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 120000000,
            DirectPlayProfiles: [
                { Container: 'mp4,m4v,mov,mkv', Type: 'Video',
                  VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') },
                { Container: 'webm', Type: 'Video',
                  VideoCodec: 'vp8,vp9' + (supportsAV1 ? ',av1' : ''),
                  AudioCodec: 'opus,vorbis' },
                { Container: 'ts,mpegts,m2ts', Type: 'Video',
                  VideoCodec: 'h264' + (supportsHevc ? ',hevc,h265' : ''),
                  AudioCodec: audioCodecs.join(',') }
            ],
            TranscodingProfiles: [{
                Container: 'ts', Type: 'Video', VideoCodec: 'h264',
                AudioCodec: 'aac,mp3', Context: 'Streaming', Protocol: 'hls'
            }],
            CodecProfiles: [],
            ContainerProfiles: [],
            SubtitleProfiles: []
        };
    }

    let _video;
    function canPlayProbe() {
        if (!_video) _video = document.createElement('video');
        return function (mime) {
            try { return _video.canPlayType(mime) !== ''; } catch (_) { return false; }
        };
    }

    // ─── Cache + key derivation ─────────────────────────────────────────────

    function readCache(prefix, key) {
        try {
            const raw = localStorage.getItem(prefix + key);
            if (!raw) return null;
            const e = JSON.parse(raw);
            if (Date.now() > e.expires) {
                localStorage.removeItem(prefix + key);
                return null;
            }
            return e.data;
        } catch (_) { return null; }
    }

    function writeCache(prefix, key, data, ttlMs) {
        try {
            localStorage.setItem(prefix + key, JSON.stringify({
                data: data, expires: Date.now() + ttlMs
            }));
        } catch (_) {}
    }

    function getKeySuffix() {
        if (!state.keySuffix) {
            const ac = window.ApiClient;
            const userId = (ac && ac.getCurrentUserId && ac.getCurrentUserId()) || 'u';
            const deviceId = (ac && ac.deviceId && ac.deviceId()) || 'd';
            state.keySuffix = '_' + userId + '_' + deviceId + '_' + computeCodecFp();
        }
        return state.keySuffix;
    }

    function makeResultKey(itemId) {
        return itemId + getKeySuffix();
    }

    function computeCodecFp() {
        try {
            const probe = canPlayProbe();
            const tests = [
                'video/mp4; codecs="avc1.42E01E"',
                'video/mp4; codecs="hvc1"',
                'video/webm; codecs="vp9"',
                'video/mp4; codecs="av01.0.01M.08"',
                'audio/mp4; codecs="mp4a.40.2"',
                'audio/mp4; codecs="ac-3"',
                'audio/webm; codecs="opus"',
                'audio/flac'
            ];
            return tests.map(function (t) { return probe(t) ? '1' : '0'; }).join('');
        } catch (_) { return 'x'; }
    }

    // ─── DOM scan ───────────────────────────────────────────────────────────

    function findCandidates() {
        const seen = new Map();
        const nodes = document.querySelectorAll('[data-id]');

        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const id = el.getAttribute('data-id');
            if (!id || id.length < 5) continue;

            const dataType = el.getAttribute('data-type') || el.getAttribute('data-itemtype');
            if (dataType && NON_PLAYABLE_TYPES.has(dataType)) continue;
            if (!isPlayableTypeAllowed(dataType)) continue;
            if (!looksLikeMediaContainer(el)) continue;
            if (el.querySelector('[data-jpi]')) continue;

            // Dedupe: keep the OUTERMOST container per id (action buttons and
            // inner overlays that share the card's data-id should not win).
            const existing = seen.get(id);
            if (existing) {
                if (existing.el.contains(el)) continue;
                if (el.contains(existing.el)) {
                    seen.set(id, candidateEntry(el, dataType));
                }
                continue;
            }
            seen.set(id, candidateEntry(el, dataType));
        }
        return Array.from(seen.values());
    }

    function candidateEntry(el, dataType) {
        const hint = (dataType === 'Episode' || dataType === 'Movie') ? dataType : null;
        return { el: el, hint: hint };
    }

    /**
     * Filter at scan time per server config. Episodes and movies that the
     * user disabled in the plugin settings are skipped before any lookup.
     */
    function isPlayableTypeAllowed(hint) {
        if (hint === 'Movie') return config.showOnMovies;
        if (hint === 'Episode') return config.showOnEpisodes;
        return true; // unknown — let the lookup decide
    }

    function looksLikeMediaContainer(el) {
        const tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;

        const cls = (typeof el.className === 'string') ? el.className : '';
        // Action-button / overlay class patterns can contain "card" but are
        // not the card root.
        if (/(cardOverlay|paper-icon-button|btnUserData|btnUserItemRating|btn-)/i.test(cls)) return false;
        if (/(\bcard\b|listItem|episodeItem|itemCard|portraitCard|landscapeCard|squareCard|backdropCard)/i.test(cls)) return true;
        return !!el.querySelector(CARD_IMAGE_SELECTOR);
    }

    /**
     * Remove badges left behind in the wrong place by older builds (inside
     * buttons) or stranded after Jellyfin's virtualized scroller recycled a
     * DOM node for a different item. Only runs when the observer reports a
     * removal, since that's the only signal recycling produces.
     */
    function sweepStaleBadges() {
        const badges = document.querySelectorAll('[data-jpi]');
        for (let i = 0; i < badges.length; i++) {
            const b = badges[i];
            if (b.closest('button')) { b.remove(); continue; }
            const owner = b.closest('[data-id]');
            if (owner && owner.getAttribute('data-id') !== b.getAttribute('data-jpi')) {
                b.remove();
            }
        }
    }

    function scan() {
        if (state.destroyed) return;
        if (state.sweepNeeded) {
            sweepStaleBadges();
            state.sweepNeeded = false;
        }
        const candidates = findCandidates();
        for (let i = 0; i < candidates.length; i++) {
            processItem(candidates[i].el, candidates[i].el.getAttribute('data-id'), candidates[i].hint);
        }
        processDetailPage();
    }

    // ─── Per-item / detail-page processing ──────────────────────────────────

    function processItem(el, itemId, hint) {
        getOrLookup(itemId, hint, function () {
            return document.body.contains(el);
        }).then(function (result) {
            if (state.destroyed || !result) return;
            placeBadge(el, itemId, result.type, result.reason, /*isDetail*/ false);
        });
    }

    function processDetailPage() {
        const itemId = extractDetailItemId();
        if (!itemId) return;
        if (document.querySelector('[data-jpi-detail="' + itemId + '"]')) return;

        // Stale detail badges from a prior detail page should be removed.
        document.querySelectorAll('[data-jpi-detail]').forEach(function (el) {
            if (el.getAttribute('data-jpi-detail') !== itemId) el.remove();
        });

        getOrLookup(itemId, null, function () {
            return extractDetailItemId() === itemId;
        }).then(function (result) {
            if (state.destroyed || !result) return;
            placeBadge(null, itemId, result.type, result.reason, /*isDetail*/ true);
        });
    }

    function extractDetailItemId() {
        const url = (window.location.hash || '') + ' ' +
                    (window.location.pathname || '') + ' ' +
                    (window.location.search || '');
        if (!/[#/]details/i.test(url)) return null;
        const m = url.match(/[?&]id=([0-9a-fA-F-]{16,})/);
        return m ? m[1] : null;
    }

    /**
     * Returns a Promise<{type,reason}|null>. Reads result cache first; on
     * miss, dedupes via the in-flight map and queues a lookup. The
     * `stillRelevant` callback is invoked just before resolving; if it
     * returns false (DOM gone, user navigated), resolves to null instead.
     */
    function getOrLookup(itemId, hint, stillRelevant) {
        const cached = readCache(RESULT_PREFIX, makeResultKey(itemId));
        if (cached) return Promise.resolve(stillRelevant() ? cached : null);

        const cachedType = readCache(TYPE_PREFIX, itemId);
        if (cachedType && (cachedType.type === '' || NON_PLAYABLE_TYPES.has(cachedType.type))) {
            return Promise.resolve(null);
        }

        let p = state.inflight.get(itemId);
        if (!p) {
            p = enqueueLookup(itemId, hint || (cachedType && cachedType.type) || null);
            state.inflight.set(itemId, p);
            p.then(function () { state.inflight.delete(itemId); },
                   function () { state.inflight.delete(itemId); });
        }
        return p.then(function (r) { return stillRelevant() ? r : null; },
                      function () { return null; });
    }

    function enqueueLookup(itemId, hint) {
        return new Promise(function (resolve) {
            state.lookupQueue.push({ itemId: itemId, hint: hint, resolve: resolve });
            drainQueue();
        });
    }

    function drainQueue() {
        while (state.activeLookups < MAX_CONCURRENT_LOOKUPS && state.lookupQueue.length > 0) {
            const job = state.lookupQueue.shift();
            state.activeLookups++;
            runLookup(job.itemId, job.hint).then(job.resolve, function () { job.resolve(null); })
                .then(function () { state.activeLookups--; drainQueue(); });
        }
    }

    function runLookup(itemId, hint) {
        const typePromise = hint
            ? Promise.resolve(hint)
            : fetchType(itemId).then(function (t) {
                writeCache(TYPE_PREFIX, itemId, { type: t }, TYPE_TTL_MS);
                return t;
            });

        return typePromise.then(function (type) {
            if (type !== 'Movie' && type !== 'Episode') return null;
            if (!isPlayableTypeAllowed(type)) return null;
            return fetchPlaybackInfo(itemId).then(function (result) {
                writeCache(RESULT_PREFIX, makeResultKey(itemId), result, config.resultTtlMs);
                return result;
            });
        });
    }

    // ─── Type batching ──────────────────────────────────────────────────────

    /**
     * Coalesce per-item type lookups into a single GET /Users/{u}/Items?Ids=
     * call. Library pages with 50 cards used to issue 50 type requests; now
     * we batch them inside an 80ms window.
     */
    function fetchType(itemId) {
        return new Promise(function (resolve, reject) {
            if (!state.typeBatch) {
                state.typeBatch = { ids: [], waiters: new Map(), timer: null };
            }
            const batch = state.typeBatch;
            const existing = batch.waiters.get(itemId);
            if (existing) {
                existing.push({ resolve: resolve, reject: reject });
                return;
            }
            batch.waiters.set(itemId, [{ resolve: resolve, reject: reject }]);
            batch.ids.push(itemId);
            if (!batch.timer) batch.timer = setTimeout(flushTypeBatch, TYPE_BATCH_WINDOW_MS);
        });
    }

    function flushTypeBatch() {
        const batch = state.typeBatch;
        state.typeBatch = null;
        if (!batch || batch.ids.length === 0) return;

        const userId = (window.ApiClient && window.ApiClient.getCurrentUserId()) || '';
        const path = '/Users/' + userId + '/Items?Limit=' + batch.ids.length +
            '&Ids=' + batch.ids.join(',') + '&Fields=';

        apiCall('GET', path).then(function (resp) {
            const byId = new Map();
            const items = (resp && resp.Items) || [];
            for (let i = 0; i < items.length; i++) byId.set(items[i].Id, items[i].Type || '');
            batch.ids.forEach(function (id) {
                const type = byId.get(id) || '';
                (batch.waiters.get(id) || []).forEach(function (w) { w.resolve(type); });
            });
        }, function (err) {
            batch.ids.forEach(function (id) {
                (batch.waiters.get(id) || []).forEach(function (w) { w.reject(err); });
            });
        });
    }

    // ─── Playback info + parsing ────────────────────────────────────────────

    function fetchPlaybackInfo(itemId) {
        const userId = window.ApiClient.getCurrentUserId();
        const profile = getDeviceProfile();
        const body = {
            UserId: userId,
            DeviceProfile: profile,
            MaxStreamingBitrate: state.maxBitrate,
            StartTimeTicks: 0,
            IsPlayback: false,
            AutoOpenLiveStream: false
        };
        return apiCall('POST', '/Items/' + itemId + '/PlaybackInfo', { body: body, timeoutMs: 9000 })
            .then(function (resp) { return parsePlaybackResponse(resp, profile); });
    }

    /**
     * Translate the server's flags into a badge. We trust SupportsDirectPlay
     * / SupportsDirectStream / SupportsTranscoding — they reflect a real
     * evaluation against the device profile we just sent.
     */
    function parsePlaybackResponse(resp, profile) {
        const sources = resp.MediaSources || [];
        if (sources.length === 0) return { type: TYPE.TRANSCODE, reason: 'no media sources' };

        const src = sources.find(function (s) { return s.SupportsDirectPlay; }) ||
                    sources.find(function (s) { return s.SupportsDirectStream; }) ||
                    sources[0];

        const container = (src.Container || '').toLowerCase();
        const audio = getStreamCodec(src, 'Audio');
        const video = getStreamCodec(src, 'Video');

        if (src.SupportsDirectPlay) {
            const base = container + ' / ' + (video || '?') + ' / ' + (audio || '?');
            const risk = browserDirectPlayStallRisk(container, video);
            return {
                type: TYPE.DIRECT,
                reason: risk ? base + ' — ⚠ ' + risk : base
            };
        }

        // For Re-mux / Direct Stream / Transcode the server populates
        // TranscodeReasons explaining what blocked Direct Play. Surface that
        // in every non-DirectPlay tooltip.
        const why = humanizeTranscodeReasons(src.TranscodeReasons, src);
        const because = why ? ' — direct play blocked: ' + why : '';

        if (src.SupportsDirectStream) {
            // SupportsDirectStream covers Re-mux (audio also kept native) and
            // audio-transcode. The flag doesn't distinguish; we infer from the
            // audio whitelist on the device profile.
            if (audioCodecInProfile(audio, profile)) {
                return {
                    type: TYPE.REMUX,
                    reason: 'container repackaged, ' +
                        (video || '?') + ' + ' + (audio || '?') + ' kept native' + because
                };
            }
            if (audio && FRAGILE_AUDIO.has(audio)) {
                return {
                    type: TYPE.TRANSCODE,
                    reason: 'remux + ' + audio.toUpperCase() + ' audio (often fails on browsers)' + because
                };
            }
            return {
                type: TYPE.STREAM,
                reason: 'video direct, audio transcode (' + (audio || '?') + ')' + because +
                    ' — note: audio re-encode with -c:v copy can stall on long-GOP sources or multichannel audio; full transcode is sometimes faster on a fast CPU'
            };
        }

        if (src.SupportsTranscoding) {
            return {
                type: TYPE.TRANSCODE,
                reason: why || ('video ' + (video || '?') + ', audio ' + (audio || '?'))
            };
        }

        return { type: TYPE.TRANSCODE, reason: 'not playable on this device' + because };
    }

    function getStreamCodec(src, type) {
        const s = (src.MediaStreams || []).find(function (m) { return m.Type === type; });
        return s ? (s.Codec || '').toLowerCase() : null;
    }

    /**
     * Detect "Direct Play will probably stall in your browser" cases that
     * canPlayType lies about. Native-shell environments (JMP, Android) handle
     * these fine — only flag for browsers.
     *
     * Returns a short warning string, or null if the combo is safe.
     */
    function browserDirectPlayStallRisk(container, video) {
        if (isNativeShell()) return null;
        const c = (container || '').toLowerCase();
        const v = (video || '').toLowerCase();
        const isMkv = c === 'mkv' || c === 'matroska';

        if (isMkv && (v === 'hevc' || v === 'h265')) {
            return 'browser MKV demux of HEVC frequently stalls — try Jellyfin Media Player';
        }
        if (isMkv && v === 'av1') {
            return 'browser MKV+AV1 direct play is unreliable — try Jellyfin Media Player';
        }
        if (c === 'avi') {
            return 'browser AVI direct play is often broken — try Jellyfin Media Player';
        }
        return null;
    }

    function audioCodecInProfile(audio, profile) {
        if (!audio || !profile) return false;
        const target = audio.toLowerCase();
        const profiles = profile.DirectPlayProfiles || [];
        for (let i = 0; i < profiles.length; i++) {
            const list = (profiles[i].AudioCodec || '').toLowerCase();
            if (!list) continue;
            const codecs = list.split(',');
            for (let j = 0; j < codecs.length; j++) {
                if (codecs[j].trim() === target) return true;
            }
        }
        return false;
    }

    // ─── TranscodeReason → human strings ────────────────────────────────────

    const TRANSCODE_REASON_LABELS = {
        ContainerNotSupported:        'container {container} not supported',
        VideoCodecNotSupported:       'video codec {videoCodec} not supported',
        VideoBitrateNotSupported:     'video bitrate {videoBitrate} exceeds device limit',
        VideoBitrate:                 'video bitrate exceeds limit',
        VideoFramerateNotSupported:   'video framerate {videoFps} fps not supported',
        VideoLevelNotSupported:       'video level {videoLevel} not supported',
        VideoProfileNotSupported:     'video profile {videoProfile} not supported',
        VideoResolutionNotSupported:  'video resolution {videoSize} not supported',
        VideoBitDepthNotSupported:    'video bit depth {videoBitDepth} not supported',
        VideoRangeNotSupported:       'HDR / Dolby Vision not supported',
        VideoRangeTypeNotSupported:   'HDR variant {videoRangeType} not supported',
        VideoCodecTagNotSupported:    'video codec tag not supported',
        RefFramesNotSupported:        'too many video reference frames',
        AnamorphicVideoNotSupported:  'anamorphic video not supported',
        InterlacedVideoNotSupported:  'interlaced video not supported',
        AudioCodecNotSupported:       'audio codec {audioCodec} not supported',
        AudioBitrateNotSupported:     'audio bitrate exceeds device limit',
        AudioChannelsNotSupported:    'audio channel count {audioChannels} not supported',
        AudioProfileNotSupported:     'audio profile not supported',
        AudioSampleRateNotSupported:  'audio sample rate not supported',
        AudioIsExternal:              'external audio track must be muxed in',
        SecondaryAudioNotSupported:   'secondary audio track not supported',
        SubtitleCodecNotSupported:    'subtitle format needs burn-in',
        ContainerBitrateExceedsLimit: 'total bitrate exceeds device limit',
        DirectPlayError:              'server reported a direct-play error',
        UnknownVideoStreamInfo:       'video stream metadata unknown',
        UnknownAudioStreamInfo:       'audio stream metadata unknown'
    };

    function humanizeTranscodeReasons(reasons, src) {
        if (!Array.isArray(reasons) || reasons.length === 0) return '';

        const audioStream = (src.MediaStreams || []).find(function (s) { return s.Type === 'Audio'; }) || {};
        const videoStream = (src.MediaStreams || []).find(function (s) { return s.Type === 'Video'; }) || {};

        const ctx = {
            container:      (src.Container || '').toLowerCase(),
            videoCodec:     (videoStream.Codec || '').toLowerCase(),
            videoProfile:   videoStream.Profile || '',
            videoLevel:     videoStream.Level || '',
            videoBitrate:   formatBitrate(videoStream.BitRate),
            videoFps:       videoStream.AverageFrameRate || videoStream.RealFrameRate || '',
            videoSize:      (videoStream.Width && videoStream.Height) ? videoStream.Width + 'x' + videoStream.Height : '',
            videoBitDepth:  videoStream.BitDepth ? videoStream.BitDepth + '-bit' : '',
            videoRangeType: videoStream.VideoRangeType || videoStream.VideoRange || '',
            audioCodec:     (audioStream.Codec || '').toLowerCase(),
            audioChannels:  audioStream.Channels ? audioStream.Channels + 'ch' : ''
        };

        const seen = {};
        const out = [];
        for (let i = 0; i < reasons.length; i++) {
            const tmpl = TRANSCODE_REASON_LABELS[reasons[i]] || reasons[i];
            const text = tmpl.replace(/\{(\w+)\}/g, function (_, k) { return ctx[k] || '?'; });
            if (!seen[text]) { seen[text] = true; out.push(text); }
        }
        return out.join('; ');
    }

    function formatBitrate(b) {
        if (!b || typeof b !== 'number') return '';
        if (b >= 1000000) return (b / 1000000).toFixed(1) + ' Mbps';
        if (b >= 1000)    return Math.round(b / 1000) + ' kbps';
        return b + ' bps';
    }

    // ─── API helpers ────────────────────────────────────────────────────────

    function getDeviceId() {
        const ac = window.ApiClient;
        return (ac && ac.deviceId && ac.deviceId()) || '';
    }

    function authHeader() {
        const ac = window.ApiClient;
        const token = (ac.accessToken && ac.accessToken()) || '';
        const clientName = ac._clientName || 'Jellyfin Web';
        const clientVersion = ac._clientVersion || '10.11.0';
        const deviceName = ac._deviceName || 'Browser';
        return 'MediaBrowser Client="' + clientName + '", Device="' + deviceName +
            '", DeviceId="' + getDeviceId() + '", Version="' + clientVersion +
            '", Token="' + token + '"';
    }

    function serverAddress() {
        const ac = window.ApiClient;
        return ac._serverAddress || (ac.serverAddress ? ac.serverAddress() : '');
    }

    /**
     * Single XHR helper for every API call we make. opts: { body, timeoutMs }.
     */
    function apiCall(method, path, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            const xhr = new XMLHttpRequest();
            xhr.timeout = opts.timeoutMs || 6000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    if (!xhr.responseText) return resolve(null);
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (_) { reject(new Error('parse')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('net')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };
            xhr.open(method, serverAddress() + path, true);
            xhr.setRequestHeader('X-JPI-Self', '1'); // tell sniffer to skip
            xhr.setRequestHeader('X-Emby-Authorization', authHeader());
            if (opts.body !== undefined) {
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
            } else {
                xhr.send();
            }
        });
    }

    // ─── Badge DOM ──────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        const css = document.createElement('style');
        css.id = 'jpi-styles';
        css.textContent = [
            // pointer-events stays enabled so the native `title` tooltip
            // fires on hover. Clicks still bubble to the card for
            // navigation; we only set cursor:help so the user can see the
            // hover target is meaningful.
            '.jpi-badge-overlay {',
            '  position: absolute; top: 4px; left: 4px; z-index: 10;',
            '  display: inline-flex; align-items: center; gap: 3px;',
            '  padding: 2px 6px; border-radius: 4px;',
            '  font-size: 10px; font-weight: 700; line-height: 1.3;',
            '  white-space: nowrap; cursor: help;',
            '  text-shadow: 0 1px 2px rgba(0,0,0,0.6);',
            '  font-family: inherit !important;',
            '  box-shadow: 0 1px 3px rgba(0,0,0,0.4);',
            '}',
            '.jpi-badge-inline {',
            '  display: inline-flex; align-items: center; gap: 3px;',
            '  margin-left: auto; padding: 1px 6px; border-radius: 4px;',
            '  font-size: 10px; font-weight: 600; line-height: 1.4;',
            '  white-space: nowrap; cursor: help; flex-shrink: 0;',
            '  text-shadow: none; font-family: inherit !important;',
            '}',
            '.jpi-badge-detail {',
            '  display: inline-flex; align-items: center; gap: 4px;',
            '  margin: 0 0 0 12px; padding: 3px 9px; border-radius: 4px;',
            '  font-size: 12px; font-weight: 600; line-height: 1.4;',
            '  white-space: nowrap; vertical-align: middle;',
            '  cursor: help;',
            '  font-family: inherit !important;',
            '}',
            '.jpi-direct { background: rgba(26,107,42,0.9); color: #fff; }',
            '.jpi-remux { background: rgba(40,110,180,0.9); color: #fff; }',
            '.jpi-stream { background: rgba(122,95,0,0.9); color: #fff; }',
            '.jpi-transcode { background: rgba(139,26,26,0.9); color: #fff; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(css);
    }

    /**
     * Build a badge span. `mode` is 'overlay' (card image), 'inline' (list
     * row), or 'detail' (item details page misc-info row).
     */
    function createBadge(type, itemId, reason, mode) {
        const badge = BADGES[type];
        if (!badge) return null;
        const span = document.createElement('span');
        const classByMode = {
            overlay: 'jpi-badge-overlay',
            inline:  'jpi-badge-inline',
            detail:  'jpi-badge-detail'
        };
        span.className = (classByMode[mode] || classByMode.inline) + ' ' + badge.cls;
        span.setAttribute(mode === 'detail' ? 'data-jpi-detail' : 'data-jpi', itemId);
        span.setAttribute('title', badge.label + (reason ? ' — ' + reason : ''));
        span.textContent = badge.icon + ' ' + badge.label;
        return span;
    }

    function isCardElement(el) {
        if (el.querySelector(CARD_IMAGE_SELECTOR)) return true;
        const cls = typeof el.className === 'string' ? el.className : '';
        return /\bcard\b/i.test(cls);
    }

    /**
     * Place a badge for a card / list row / detail page. When isDetail is
     * true, `el` is ignored and the badge is inserted into the detail page's
     * misc-info row.
     */
    function placeBadge(el, itemId, type, reason, isDetail) {
        if (isDetail) {
            const target = document.querySelector(DETAIL_TARGET_SELECTOR);
            if (!target) return;
            if (target.querySelector('[data-jpi-detail="' + itemId + '"]')) return;
            const badge = createBadge(type, itemId, reason, 'detail');
            if (badge) target.appendChild(badge);
            return;
        }

        if (!el || el.tagName === 'BUTTON' || el.closest('button')) return;
        if (el.querySelector('[data-jpi="' + itemId + '"]')) return;

        if (isCardElement(el)) {
            const imgContainer = el.querySelector(PLACE_TARGET_SELECTOR);
            const target = (imgContainer && !imgContainer.closest('button')) ? imgContainer : el;
            if (window.getComputedStyle(target).position === 'static') {
                target.style.position = 'relative';
            }
            const badge = createBadge(type, itemId, reason, 'overlay');
            if (badge) target.appendChild(badge);
            return;
        }

        const rowBody = el.querySelector(LIST_BODY_SELECTOR);
        const badge = createBadge(type, itemId, reason, 'inline');
        if (!badge) return;
        if (rowBody && rowBody.parentNode) {
            rowBody.parentNode.insertBefore(badge, rowBody.nextSibling);
        } else {
            el.appendChild(badge);
        }
    }
})();
