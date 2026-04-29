/**
 * Jellyfin Playback Indicator v0.4.6
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
 *      player would use. This is the same call jellyfin-web itself uses
 *      when starting playback in those shells.
 *   2. Pre-fetch the active session's DeviceProfile via GET /Sessions.
 *      Both top-level `session.DeviceProfile` and
 *      `session.Capabilities.DeviceProfile` are checked since different
 *      clients use different paths; the session matching our DeviceId is
 *      preferred when several are active.
 *   3. Sniff outgoing real player calls (XHR + fetch) to
 *      /Items/{id}/PlaybackInfo and capture any richer profile they send.
 *   4. Synthetic profile as a last resort.
 */
(function () {
    'use strict';

    const VERSION = '0.4.6';

    const RESULT_PREFIX = 'jpi_v5_';
    const TYPE_PREFIX = 'jpi_type_';
    const PROFILE_KEY = 'jpi_profile';
    const ALL_PREFIXES = [
        'jpi_v2_', 'jpi_v3_', 'jpi_v4_', 'jpi_v5_',
        'jpi_type_', 'jpi_profile', 'jpi_real_profile'
    ];

    const RESULT_TTL_MS = 60 * 60 * 1000;
    const TYPE_TTL_MS = 24 * 60 * 60 * 1000;
    const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    const SCAN_DEBOUNCE_MS = 350;
    const URL_POLL_MS = 800;
    const MAX_CONCURRENT_LOOKUPS = 4;

    const PLAYABLE_TYPES = new Set(['Episode', 'Movie']);
    const NON_PLAYABLE_TYPES = new Set([
        'Series', 'Season', 'BoxSet', 'CollectionFolder', 'Folder',
        'MusicArtist', 'MusicAlbum', 'Audio', 'Photo', 'PhotoAlbum',
        'Person', 'Genre', 'Studio', 'Playlist'
    ]);

    // Audio codecs that often claim to remux but actually fail on browsers/TVs.
    const FRAGILE_AUDIO = new Set(['truehd', 'mlp']);

    const BADGES = {
        direct:    { cls: 'jpi-direct',    icon: '✅', label: 'Direct Play' },
        remux:     { cls: 'jpi-remux',     icon: '🔁', label: 'Re-mux' },
        stream:    { cls: 'jpi-stream',    icon: '⚠️', label: 'Direct Stream' },
        transcode: { cls: 'jpi-transcode', icon: '❌', label: 'Transcode' }
    };

    let observer = null;
    let scanTimer = null;
    let urlPollTimer = null;
    let lastUrl = '';
    let destroyed = false;
    let codecFp = null;
    let inflight = new Map();   // itemId -> Promise<{type,reason}|null>
    let activeLookups = 0;
    let lookupQueue = [];

    // Install XHR interception immediately so we never miss the first real
    // play call (which may happen before our init runs).
    installProfileSniffer();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // ─── Boot ────────────────────────────────────────────────────────────────

    function boot() {
        // Wait until ApiClient is ready and the user is signed in.
        waitFor(function () {
            const ac = window.ApiClient;
            return ac && ac.accessToken && ac.accessToken() &&
                ac.getCurrentUserId && ac.getCurrentUserId();
        }, 500, 60).then(start, function () {
            // Never started — user not logged in. Quietly stop.
        });
    }

    function start() {
        if (destroyed) return;
        injectStyles();

        // Race the two reliable profile sources. NativeShell is preferred
        // because in JMP / Android it returns the actual profile the native
        // player would use; the /Sessions fallback covers the browser case.
        getNativeShellProfile().then(function (nsProfile) {
            if (nsProfile) {
                console.info('[PlaybackIndicator] using device profile from NativeShell.AppHost: ' +
                    (nsProfile.Name || '(unnamed)') +
                    ' (' + (nsProfile.DirectPlayProfiles || []).length + ' direct-play entries)');
                persistProfile(nsProfile);
                return;
            }
            return fetchSessionProfile().then(function (profile) {
                if (profile) persistProfile(profile);
            });
        });

        observer = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
                    scheduleScan(SCAN_DEBOUNCE_MS);
                    return;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        urlPollTimer = setInterval(function () {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                inflight.clear(); // page changed, prior in-flight results may be irrelevant
                scheduleScan(SCAN_DEBOUNCE_MS);
            }
        }, URL_POLL_MS);

        scheduleScan(600);
        // eslint-disable-next-line no-console
        console.log('[PlaybackIndicator] v' + VERSION + ' active');
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

    function scheduleScan(delay) {
        if (destroyed) return;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, delay);
    }

    // ─── Cleanup (for uninstall and self-removal) ────────────────────────────

    window.__jpi_cleanup = function () {
        destroyed = true;
        if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
        clearTimeout(scanTimer);
        clearInterval(urlPollTimer);
        const styles = document.getElementById('jpi-styles');
        if (styles) styles.remove();
        document.querySelectorAll('[data-jpi]').forEach(function (b) { b.remove(); });
        try {
            Object.keys(localStorage).forEach(function (k) {
                for (let i = 0; i < ALL_PREFIXES.length; i++) {
                    if (k.indexOf(ALL_PREFIXES[i]) === 0) {
                        localStorage.removeItem(k);
                        return;
                    }
                }
            });
        } catch (_) {}
    };

    // ─── Device profile sniffer ──────────────────────────────────────────────

    /**
     * Hook XMLHttpRequest AND fetch. When the real Jellyfin web client posts
     * to /Items/{id}/PlaybackInfo with a DeviceProfile, capture that profile.
     * Our own calls are marked with the X-JPI-Self header and skipped.
     */
    function installProfileSniffer() {
        const isPlaybackUrl = function (u) {
            return u && /\/Items\/[A-Fa-f0-9-]+\/PlaybackInfo/.test(u);
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
                if (name === 'X-JPI-Self') {
                    this.__jpiSelf = true;
                    return; // don't forward — server doesn't need it
                }
                return origSetHeader.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function (body) {
                if (!this.__jpiSelf && this.__jpiMethod &&
                    this.__jpiMethod.toUpperCase() === 'POST' &&
                    isPlaybackUrl(this.__jpiUrl)) {
                    captureProfileFromBody(body);
                }
                return origSend.apply(this, arguments);
            };
        } catch (_) {}

        if (typeof window.fetch === 'function') {
            try {
                const origFetch = window.fetch.bind(window);
                window.fetch = function (input, init) {
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url) || '';
                        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                        const isSelf = headerLookup(init && init.headers, 'X-JPI-Self') === '1' ||
                                       headerLookup(input && input.headers, 'X-JPI-Self') === '1';
                        if (!isSelf && method === 'POST' && isPlaybackUrl(url)) {
                            captureProfileFromBody(init && init.body);
                        }
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
            // Plain object — case-insensitive lookup
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
            const dp = parsed && parsed.DeviceProfile;
            if (!dp || !Array.isArray(dp.DirectPlayProfiles) || dp.DirectPlayProfiles.length < 1) return;
            // Real player profiles tend to be richer than ours; reject only if
            // it looks suspiciously like our own synthetic.
            if (dp.Name === 'PlaybackIndicator Synthetic') return;
            persistProfile(dp);
        } catch (_) {}
    }

    /**
     * Save profile to localStorage and invalidate result cache if the profile
     * has actually changed (so old wrong predictions don't stick around).
     */
    function persistProfile(profile) {
        try {
            const stored = JSON.stringify({ profile: profile, captured: Date.now() });
            const existing = localStorage.getItem(PROFILE_KEY);
            const existingProfileStr = existing ? JSON.stringify(JSON.parse(existing).profile) : '';
            const newProfileStr = JSON.stringify(profile);
            localStorage.setItem(PROFILE_KEY, stored);
            if (existingProfileStr !== newProfileStr) {
                invalidateResultCache();
                scheduleScan(SCAN_DEBOUNCE_MS);
            }
        } catch (_) {}
    }

    function invalidateResultCache() {
        try {
            const keys = Object.keys(localStorage);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i].indexOf(RESULT_PREFIX) === 0) localStorage.removeItem(keys[i]);
            }
        } catch (_) {}
        // Drop in-flight lookups too — they were issued with the old profile.
        inflight.clear();
        lookupQueue.length = 0;
        document.querySelectorAll('[data-jpi]').forEach(function (b) { b.remove(); });
    }

    /**
     * Ask the native shell directly. JMP and Android inject
     * window.NativeShell.AppHost.getDeviceProfile() which returns the exact
     * DeviceProfile their native player handles — same call jellyfin-web
     * uses when it actually starts playback in those environments.
     *
     * Some implementations return synchronously, others a Promise. Some take
     * an `item` argument for context-dependent decisions; calling without
     * one yields a generic profile that's correct for our prediction use.
     */
    function getNativeShellProfile() {
        return new Promise(function (resolve) {
            try {
                const ns = window.NativeShell;
                const ah = ns && ns.AppHost;
                const fn = ah && typeof ah.getDeviceProfile === 'function'
                    ? ah.getDeviceProfile.bind(ah) : null;
                if (!fn) { resolve(null); return; }
                let result;
                try { result = fn(); }
                catch (_) { try { result = fn(null); } catch (__) { result = null; } }
                if (result && typeof result.then === 'function') {
                    result.then(function (p) { resolve(isUsableProfile(p) ? p : null); },
                                function () { resolve(null); });
                } else {
                    resolve(isUsableProfile(result) ? result : null);
                }
            } catch (_) { resolve(null); }
        });
    }

    function isUsableProfile(p) {
        return p && Array.isArray(p.DirectPlayProfiles) && p.DirectPlayProfiles.length >= 1;
    }

    /**
     * Pre-fetch the device profile from the active session. Jellyfin web /
     * JMP / Android all POST their full DeviceProfile when the session opens,
     * so this gives us an accurate profile right away.
     *
     * Different clients store the profile in different places — we check both
     * `session.DeviceProfile` (JMP, Android) and `session.Capabilities.DeviceProfile`
     * (Jellyfin web, mobile web). We also prefer the session matching our
     * deviceId in case the user has several active.
     */
    function fetchSessionProfile() {
        return new Promise(function (resolve) {
            try {
                const ac = window.ApiClient;
                if (!ac) { resolve(null); return; }
                const myDeviceId = (ac.deviceId && ac.deviceId()) || '';
                const url = serverAddress() + '/Sessions';
                const xhr = new XMLHttpRequest();
                xhr.timeout = 6000;
                xhr.onload = function () {
                    try {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            const sessions = JSON.parse(xhr.responseText);
                            const profile = pickSessionProfile(sessions, myDeviceId);
                            if (profile) {
                                console.info('[PlaybackIndicator] using device profile from session: ' +
                                    (profile.Name || '(unnamed)') +
                                    ' (' + (profile.DirectPlayProfiles || []).length + ' direct-play entries)');
                                resolve(profile);
                                return;
                            }
                        }
                    } catch (_) {}
                    resolve(null);
                };
                xhr.onerror = function () { resolve(null); };
                xhr.ontimeout = function () { resolve(null); };
                xhr.open('GET', url, true);
                xhr.setRequestHeader('X-JPI-Self', '1');
                xhr.setRequestHeader('X-Emby-Authorization', authHeader());
                xhr.send();
            } catch (_) { resolve(null); }
        });
    }

    function pickSessionProfile(sessions, myDeviceId) {
        if (!Array.isArray(sessions)) return null;
        const extract = function (s) {
            if (!s) return null;
            return s.DeviceProfile ||
                (s.Capabilities && s.Capabilities.DeviceProfile) ||
                null;
        };
        const isUsable = function (dp) {
            return dp && Array.isArray(dp.DirectPlayProfiles) &&
                dp.DirectPlayProfiles.length >= 1;
        };

        // Prefer the session whose DeviceId matches ours.
        for (let i = 0; i < sessions.length; i++) {
            if (sessions[i].DeviceId === myDeviceId) {
                const dp = extract(sessions[i]);
                if (isUsable(dp)) return dp;
            }
        }
        // Fall back to any usable profile in the response.
        for (let i = 0; i < sessions.length; i++) {
            const dp = extract(sessions[i]);
            if (isUsable(dp)) return dp;
        }
        return null;
    }

    function getDeviceProfile() {
        try {
            const raw = localStorage.getItem(PROFILE_KEY);
            if (raw) {
                const e = JSON.parse(raw);
                if (e.profile && (Date.now() - (e.captured || 0)) < PROFILE_TTL_MS) {
                    return e.profile;
                }
            }
        } catch (_) {}
        return buildSyntheticProfile();
    }

    /**
     * True if we're running inside a native-shell wrapper (Jellyfin Media
     * Player, Jellyfin Android, etc.) where canPlayType() does NOT reflect
     * actual playback capability — the wrapper hands streams to a native
     * player (mpv, ExoPlayer) that handles far more codecs than the embedded
     * <video> element advertises. Detected via the NativeShell global the
     * shells inject, or via a User-Agent marker.
     */
    function isNativeShell() {
        if (window.NativeShell) return true;
        const ua = (navigator.userAgent || '').toLowerCase();
        if (ua.indexOf('jellyfin-media-player') !== -1 ||
            ua.indexOf('jellyfinmediaplayer') !== -1 ||
            ua.indexOf('jellyfinandroid') !== -1) return true;
        try {
            const ac = window.ApiClient;
            const name = ((ac && ac._clientName) || '').toLowerCase();
            if (/jellyfin\s*media\s*player|jellyfin.?mobile|jellyfin.?android|mpv\s*shim/.test(name)) {
                return true;
            }
        } catch (_) {}
        return false;
    }

    /**
     * Synthetic fallback. Used only if the session profile fetch and the XHR
     * /fetch sniffer have both failed to produce a real profile.
     *
     * For native shells (JMP, Android) we emit a maximal profile because
     * those clients can play essentially anything via mpv/ExoPlayer; gating
     * on canPlayType() would produce empty codec lists since native players
     * bypass the HTML video element entirely.
     *
     * For real browsers we still derive from canPlayType() but seed the lists
     * with codecs every modern browser actually plays (h264 + aac + mp3) so
     * we never fall to "no direct-play possible" by accident.
     */
    function buildSyntheticProfile() {
        if (isNativeShell()) {
            console.info('[PlaybackIndicator] native shell detected; using permissive synthetic profile');
            return {
                Name: 'PlaybackIndicator Synthetic (native shell)',
                MaxStreamingBitrate: 200000000,
                MaxStaticBitrate: 200000000,
                DirectPlayProfiles: [
                    { Container: 'mp4,m4v,mov,mkv,avi,wmv,3gp,3g2,m2ts,mts,ts,mpegts,asf,flv,vob,ogm,ogv,webm',
                      Type: 'Video',
                      VideoCodec: 'h264,h265,hevc,vp8,vp9,av1,mpeg4,mpeg2video,vc1,wmv3',
                      AudioCodec: 'aac,mp3,ac3,eac3,dts,dca,truehd,mlp,flac,opus,vorbis,wma,wmav2,pcm,pcm_s16le,pcm_s24le' }
                ],
                TranscodingProfiles: [
                    { Container: 'ts', Type: 'Video', VideoCodec: 'h264',
                      AudioCodec: 'aac,mp3,ac3', Context: 'Streaming', Protocol: 'hls' }
                ]
            };
        }

        const v = document.createElement('video');
        const cp = function (t) { try { return v.canPlayType(t); } catch (_) { return ''; } };
        const has = function (t) { return cp(t) !== ''; };

        const supportsHevc = has('video/mp4; codecs="hvc1"') || has('video/mp4; codecs="hev1"');
        const supportsVP9 = has('video/webm; codecs="vp9"');
        const supportsAV1 = has('video/mp4; codecs="av01.0.01M.08"');
        const supportsAC3 = has('audio/mp4; codecs="ac-3"') || has('audio/ac3');

        // Seed with codecs every modern browser actually plays so empty
        // canPlayType() responses never strand us on "no codecs supported".
        const videoCodecs = ['h264', 'vp8'];
        if (supportsHevc) videoCodecs.push('hevc', 'h265');
        if (supportsVP9) videoCodecs.push('vp9');
        if (supportsAV1) videoCodecs.push('av1');

        const audioCodecs = ['aac', 'mp3', 'opus', 'flac', 'vorbis'];
        if (supportsAC3) audioCodecs.push('ac3', 'eac3');

        console.info('[PlaybackIndicator] no captured profile, using browser synthetic; codecs: video=' +
            videoCodecs.join('/') + ' audio=' + audioCodecs.join('/'));

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
            TranscodingProfiles: [
                { Container: 'ts', Type: 'Video', VideoCodec: 'h264',
                  AudioCodec: 'aac,mp3', Context: 'Streaming', Protocol: 'hls' }
            ]
        };
    }

    // ─── Cache ───────────────────────────────────────────────────────────────

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

    function makeResultKey(itemId) {
        const ac = window.ApiClient;
        const userId = ac.getCurrentUserId() || 'u';
        const deviceId = (ac.deviceId && ac.deviceId()) || 'd';
        if (!codecFp) codecFp = computeCodecFp();
        return itemId + '_' + userId + '_' + deviceId + '_' + codecFp;
    }

    function computeCodecFp() {
        try {
            const v = document.createElement('video');
            const cp = function (t) { try { return v.canPlayType(t); } catch (_) { return ''; } };
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
            return tests.map(function (t) {
                const r = cp(t);
                return r === 'probably' ? '2' : r === 'maybe' ? '1' : '0';
            }).join('');
        } catch (_) { return 'x'; }
    }

    // ─── DOM scan ────────────────────────────────────────────────────────────

    /**
     * Find candidate elements: any [data-id] node that looks like a media card
     * or list item AND has not been ruled out by data-type/data-itemtype.
     */
    function findCandidates() {
        const seen = new Map();
        const nodes = document.querySelectorAll('[data-id]');

        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const id = el.getAttribute('data-id');
            if (!id || id.length < 5) continue;

            const dataType = el.getAttribute('data-type') || el.getAttribute('data-itemtype');
            if (dataType && NON_PLAYABLE_TYPES.has(dataType)) continue;

            if (!looksLikeMediaContainer(el)) continue;
            if (el.querySelector('[data-jpi]')) continue;

            // Dedupe: keep the OUTERMOST container per id. Action buttons,
            // overlays, and image links inside a card often share the card's
            // data-id; the badge belongs on the card root, not on those.
            if (seen.has(id)) {
                const existing = seen.get(id);
                if (existing.el.contains(el)) continue; // current is deeper, keep outer
                if (el.contains(existing.el)) {
                    seen.set(id, { el: el, hint: dataType && PLAYABLE_TYPES.has(dataType) ? dataType : null });
                }
                continue;
            }
            seen.set(id, { el: el, hint: dataType && PLAYABLE_TYPES.has(dataType) ? dataType : null });
        }
        return Array.from(seen.values());
    }

    function looksLikeMediaContainer(el) {
        // Buttons and form controls are never card roots, even when their
        // class names contain "card" (e.g. cardOverlayButton).
        const tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
            return false;
        }

        const cls = (typeof el.className === 'string') ? el.className : '';

        // Block known action-button / overlay class patterns. These can
        // contain "card" as a substring but they are NOT the card root.
        if (/(cardOverlay|paper-icon-button|btnUserData|btnUserItemRating|btn-)/i.test(cls)) {
            return false;
        }

        // Allowlist actual card / list-item containers. Use word boundaries on
        // "card" so cardOverlay/cardOverlayButton don't slip through.
        if (/(\bcard\b|listItem|episodeItem|itemCard|portraitCard|landscapeCard|squareCard|backdropCard)/i.test(cls)) {
            return true;
        }

        // Last resort: contains a real card image as a descendant.
        return !!el.querySelector(
            '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
            '.listItemImage, [class*="listItemImage"]'
        );
    }

    /**
     * Remove badges that ended up in the wrong place — left over from older
     * builds that placed badges inside action buttons, or stranded inside a
     * DOM node whose data-id has since been recycled by Jellyfin's
     * virtualized scroller for a different item.
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
        if (destroyed) return;
        sweepStaleBadges();
        const candidates = findCandidates();
        for (let i = 0; i < candidates.length; i++) {
            processItem(candidates[i].el, candidates[i].el.getAttribute('data-id'), candidates[i].hint);
        }
    }

    // ─── Per-item processing ─────────────────────────────────────────────────

    function processItem(el, itemId, hint) {
        const cached = readCache(RESULT_PREFIX, makeResultKey(itemId));
        if (cached) {
            placeBadge(el, itemId, cached.type, cached.reason);
            return;
        }

        // Cached "non-playable" shortcut so we don't repeat type lookups.
        const cachedType = readCache(TYPE_PREFIX, itemId);
        if (cachedType && !PLAYABLE_TYPES.has(cachedType.type)) return;

        // Dedupe in-flight by itemId so the same item isn't looked up twice
        // when it appears in multiple grids on the same page.
        let p = inflight.get(itemId);
        if (!p) {
            p = enqueueLookup(itemId, hint || (cachedType && cachedType.type) || null);
            inflight.set(itemId, p);
        }

        p.then(function (result) {
            if (destroyed || !result) return;
            if (!document.body.contains(el)) return;
            placeBadge(el, itemId, result.type, result.reason);
        }).catch(function () { /* silent */ });
    }

    function enqueueLookup(itemId, hint) {
        return new Promise(function (resolve) {
            lookupQueue.push({ itemId: itemId, hint: hint, resolve: resolve });
            drainQueue();
        });
    }

    function drainQueue() {
        while (activeLookups < MAX_CONCURRENT_LOOKUPS && lookupQueue.length > 0) {
            const job = lookupQueue.shift();
            activeLookups++;
            runLookup(job.itemId, job.hint).then(function (result) {
                job.resolve(result);
            }, function () {
                job.resolve(null);
            }).then(function () {
                activeLookups--;
                drainQueue();
            });
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
            if (!PLAYABLE_TYPES.has(type)) return null;
            return fetchPlaybackInfo(itemId).then(function (result) {
                writeCache(RESULT_PREFIX, makeResultKey(itemId), result, RESULT_TTL_MS);
                return result;
            });
        });
    }

    // ─── Jellyfin API calls ─────────────────────────────────────────────────

    function authHeader() {
        const ac = window.ApiClient;
        const token = (ac.accessToken && ac.accessToken()) || '';
        const deviceId = (ac.deviceId && ac.deviceId()) || '';
        const clientName = ac._clientName || 'Jellyfin Web';
        const clientVersion = ac._clientVersion || '10.11.0';
        const deviceName = ac._deviceName || 'Browser';
        return 'MediaBrowser Client="' + clientName + '", Device="' + deviceName +
            '", DeviceId="' + deviceId + '", Version="' + clientVersion +
            '", Token="' + token + '"';
    }

    function serverAddress() {
        const ac = window.ApiClient;
        return ac._serverAddress || (ac.serverAddress ? ac.serverAddress() : '');
    }

    function fetchType(itemId) {
        return new Promise(function (resolve, reject) {
            const ac = window.ApiClient;
            const userId = ac.getCurrentUserId();
            const url = serverAddress() + '/Users/' + userId + '/Items/' + itemId +
                '?Fields=MediaSources';
            const xhr = new XMLHttpRequest();
            xhr.timeout = 6000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        resolve(data.Type || '');
                    } catch (_) { reject(new Error('parse')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('net')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };
            xhr.open('GET', url, true);
            xhr.setRequestHeader('X-JPI-Self', '1');
            xhr.setRequestHeader('X-Emby-Authorization', authHeader());
            xhr.send();
        });
    }

    function fetchPlaybackInfo(itemId) {
        return new Promise(function (resolve, reject) {
            const ac = window.ApiClient;
            const userId = ac.getCurrentUserId();
            const body = JSON.stringify({
                UserId: userId,
                DeviceProfile: getDeviceProfile(),
                MaxStreamingBitrate: 120000000,
                StartTimeTicks: 0,
                IsPlayback: false,
                AutoOpenLiveStream: false
            });
            const url = serverAddress() + '/Items/' + itemId + '/PlaybackInfo';
            const xhr = new XMLHttpRequest();
            xhr.timeout = 9000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        resolve(parsePlaybackResponse(JSON.parse(xhr.responseText)));
                    } catch (_) { reject(new Error('parse')); }
                } else { reject(new Error('http ' + xhr.status)); }
            };
            xhr.onerror = function () { reject(new Error('net')); };
            xhr.ontimeout = function () { reject(new Error('timeout')); };
            xhr.open('POST', url, true);
            xhr.setRequestHeader('X-JPI-Self', '1'); // tell sniffer to skip
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('X-Emby-Authorization', authHeader());
            xhr.send(body);
        });
    }

    /**
     * Pick the best media source and translate the server's decision into a
     * badge. We trust the server's SupportsDirectPlay/Stream/Transcoding
     * flags — they reflect a real evaluation against the device profile.
     */
    function parsePlaybackResponse(resp) {
        const sources = resp.MediaSources || [];
        if (sources.length === 0) return { type: 'transcode', reason: 'no media sources' };

        // Prefer the source the server thinks is most usable.
        const src = sources.find(function (s) { return s.SupportsDirectPlay; }) ||
                    sources.find(function (s) { return s.SupportsDirectStream; }) ||
                    sources[0];

        const container = (src.Container || '').toLowerCase();
        const audio = getStreamCodec(src, 'Audio');
        const video = getStreamCodec(src, 'Video');

        if (src.SupportsDirectPlay) {
            return {
                type: 'direct',
                reason: container + ' / ' + (video || '?') + ' / ' + (audio || '?')
            };
        }

        if (src.SupportsDirectStream) {
            // SupportsDirectStream covers both Re-mux (container repackaged
            // but video AND audio kept native — lossless, cheap) and audio-
            // transcode (video kept native, audio re-encoded). The flag
            // doesn't distinguish them, so we infer by checking whether the
            // source audio codec is in the device profile's audio whitelist.
            const audioNative = audioCodecInProfile(audio, getDeviceProfile());

            if (audioNative) {
                return {
                    type: 'remux',
                    reason: container + ' → playable container; ' +
                        (video || '?') + ' + ' + (audio || '?') + ' kept native'
                };
            }

            if (audio && FRAGILE_AUDIO.has(audio)) {
                return {
                    type: 'transcode',
                    reason: 'remux + ' + audio.toUpperCase() + ' audio (often fails on browsers)'
                };
            }
            return {
                type: 'stream',
                reason: 'video direct, audio transcode (' + (audio || '?') + ')'
            };
        }

        if (src.SupportsTranscoding) {
            const reasons = (src.TranscodeReasons && src.TranscodeReasons.length)
                ? src.TranscodeReasons.join(', ')
                : ('video ' + (video || '?') + ', audio ' + (audio || '?'));
            return { type: 'transcode', reason: reasons };
        }

        return { type: 'transcode', reason: 'not playable on this device' };
    }

    function getStreamCodec(src, type) {
        const s = (src.MediaStreams || []).find(function (m) { return m.Type === type; });
        return s ? (s.Codec || '').toLowerCase() : null;
    }

    /**
     * True if `audio` (lower-case codec name) appears in any DirectPlayProfile
     * audio whitelist of the supplied device profile. Used to distinguish
     * Re-mux (audio native) from Direct Stream (audio gets transcoded).
     */
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

    // ─── Badge DOM ───────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        const css = document.createElement('style');
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
            '.jpi-remux { background: rgba(40,110,180,0.9); color: #fff; }',
            '.jpi-stream { background: rgba(122,95,0,0.9); color: #fff; }',
            '.jpi-transcode { background: rgba(139,26,26,0.9); color: #fff; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(css);
    }

    function createBadge(type, itemId, reason, isOverlay) {
        const badge = BADGES[type];
        if (!badge) return null;
        const span = document.createElement('span');
        span.className = (isOverlay ? 'jpi-badge-overlay ' : 'jpi-badge-inline ') + badge.cls;
        span.setAttribute('data-jpi', itemId);
        span.setAttribute('title', badge.label + (reason ? ' — ' + reason : ''));
        span.textContent = badge.icon + ' ' + badge.label;
        return span;
    }

    function isCardElement(el) {
        if (el.querySelector('.cardImageContainer, [class*="cardImage"], [class*="CardImage"]')) return true;
        const cls = typeof el.className === 'string' ? el.className : '';
        return /card/i.test(cls);
    }

    function placeBadge(el, itemId, type, reason) {
        if (el.tagName === 'BUTTON' || el.closest('button')) return;
        if (el.querySelector('[data-jpi="' + itemId + '"]')) return;

        if (isCardElement(el)) {
            const imgContainer = el.querySelector(
                '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
                '.cardBox, [class*="cardBox"]'
            );
            // Never place inside an overlay button even if it looks like an
            // image container.
            const target = (imgContainer && !imgContainer.closest('button')) ? imgContainer : el;
            const computed = window.getComputedStyle(target);
            if (computed.position === 'static') target.style.position = 'relative';
            const badge = createBadge(type, itemId, reason, true);
            if (badge) target.appendChild(badge);
            return;
        }

        const rowBody = el.querySelector(
            '.listItemBody, [class*="listItemBody"], [class*="episodeBody"], .itemBody'
        );
        const badge = createBadge(type, itemId, reason, false);
        if (!badge) return;
        if (rowBody && rowBody.parentNode) {
            rowBody.parentNode.insertBefore(badge, rowBody.nextSibling);
        } else {
            el.appendChild(badge);
        }
    }
})();
