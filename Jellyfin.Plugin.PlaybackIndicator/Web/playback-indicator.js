/**
 * Jellyfin Playback Indicator v0.4.0
 *
 * Shows Direct Play / Direct Stream / Transcode badges for episodes and movies.
 *
 *  ✅ Direct Play   — server says container, video, and audio all play natively
 *  ⚠️ Direct Stream — video plays natively, audio gets remuxed
 *  ❌ Transcode     — server has to transcode video and/or audio
 *
 * Accuracy strategy: instead of inventing a synthetic device profile, we
 * intercept the real Jellyfin web client when it actually starts playback,
 * capture the DeviceProfile it sends, and reuse THAT for our prediction
 * calls. This guarantees our prediction matches what playback would do.
 */
(function () {
    'use strict';

    const VERSION = '0.4.0';

    const RESULT_PREFIX = 'jpi_v3_';
    const TYPE_PREFIX = 'jpi_type_';
    const PROFILE_KEY = 'jpi_profile';
    const ALL_PREFIXES = ['jpi_v2_', 'jpi_v3_', 'jpi_type_', 'jpi_profile', 'jpi_real_profile'];

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
     * Hook XMLHttpRequest. When the real Jellyfin web client posts to
     * /Items/{id}/PlaybackInfo with a DeviceProfile, capture that profile and
     * persist it. Skip our own calls (marked via X-JPI-Self header).
     */
    function installProfileSniffer() {
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
                    /\/Items\/[A-Fa-f0-9-]+\/PlaybackInfo/.test(this.__jpiUrl || '')) {
                    try {
                        const parsed = typeof body === 'string' ? JSON.parse(body) : null;
                        const dp = parsed && parsed.DeviceProfile;
                        // Real player profiles are rich (subtitle profiles, codec profiles,
                        // dozens of direct-play entries). Use that as our signal.
                        if (dp && Array.isArray(dp.DirectPlayProfiles) &&
                            dp.DirectPlayProfiles.length >= 3) {
                            try {
                                localStorage.setItem(PROFILE_KEY, JSON.stringify({
                                    profile: dp, captured: Date.now()
                                }));
                            } catch (_) {}
                        }
                    } catch (_) {}
                }
                return origSend.apply(this, arguments);
            };
        } catch (_) {}
    }

    function getDeviceProfile() {
        // Prefer a profile captured from a real play.
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
     * Permissive fallback profile. Used until the real player makes its first
     * call. Errs toward "transcode" rather than falsely promising direct-play.
     */
    function buildSyntheticProfile() {
        const v = document.createElement('video');
        const cp = function (t) { try { return v.canPlayType(t); } catch (_) { return ''; } };

        const has = function (t) { return cp(t) !== ''; };

        const vCodecs = [];
        if (has('video/mp4; codecs="avc1.42E01E"')) vCodecs.push('h264');
        if (has('video/mp4; codecs="hvc1"') || has('video/mp4; codecs="hev1"')) vCodecs.push('hevc', 'h265');
        if (has('video/webm; codecs="vp9"')) vCodecs.push('vp9');
        if (has('video/mp4; codecs="av01.0.01M.08"')) vCodecs.push('av1');

        const aCodecs = ['aac'];
        if (has('audio/mp4; codecs="ac-3"') || has('audio/ac3')) aCodecs.push('ac3', 'eac3');
        if (has('audio/webm; codecs="opus"')) aCodecs.push('opus');
        if (has('audio/mpeg')) aCodecs.push('mp3');
        if (has('audio/flac')) aCodecs.push('flac');

        return {
            Name: 'PlaybackIndicator Synthetic',
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 120000000,
            DirectPlayProfiles: [
                { Container: 'mp4,m4v,mov', Type: 'Video',
                  VideoCodec: vCodecs.join(','), AudioCodec: aCodecs.join(',') },
                { Container: 'webm', Type: 'Video',
                  VideoCodec: 'vp9,vp8', AudioCodec: 'opus,vorbis' }
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

            // Dedupe: keep the most specific (deepest) match per id.
            if (seen.has(id)) {
                const existing = seen.get(id);
                if (el.contains(existing.el)) continue; // existing is deeper
                if (existing.el.contains(el)) {
                    seen.set(id, { el: el, hint: dataType && PLAYABLE_TYPES.has(dataType) ? dataType : null });
                }
                continue;
            }
            seen.set(id, { el: el, hint: dataType && PLAYABLE_TYPES.has(dataType) ? dataType : null });
        }
        return Array.from(seen.values());
    }

    function looksLikeMediaContainer(el) {
        const cls = (typeof el.className === 'string') ? el.className : '';
        if (/(card|listItem|episode|itemCard|portraitCard|landscapeCard|squareCard|backdropCard)/i.test(cls)) {
            return true;
        }
        return !!el.querySelector(
            '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
            '.listItemImage, [class*="listItemImage"]'
        );
    }

    function scan() {
        if (destroyed) return;
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
            if (audio && FRAGILE_AUDIO.has(audio)) {
                return {
                    type: 'transcode',
                    reason: 'remux + ' + audio.toUpperCase() + ' audio (often fails on browsers)'
                };
            }
            return {
                type: 'stream',
                reason: 'video direct, audio remux (' + (audio || '?') + ')'
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

    // ─── Badge DOM ───────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('jpi-styles')) return;
        const css = document.createElement('style');
        css.id = 'jpi-styles';
        css.textContent = [
            '.jpi-badge-overlay {',
            '  position: absolute; top: 4px; right: 4px; z-index: 10;',
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
        if (el.querySelector('[data-jpi="' + itemId + '"]')) return;

        if (isCardElement(el)) {
            const imgContainer = el.querySelector(
                '.cardImageContainer, [class*="cardImage"], [class*="CardImage"], ' +
                '.cardBox, [class*="cardBox"]'
            );
            const target = imgContainer || el;
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
