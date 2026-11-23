(function () {
    // The panel lives on every Roblox page, not only on game pages: joining a
    // player by name works from anywhere, so the box has to be reachable there
    // too. A game page keeps the anchor placement below; every other page gets
    // the floating window.
    const GAME_PATH = /\/games\/\d+(?:\/|$)/;

    const isGamePage = () => GAME_PATH.test(window.location.pathname);

    // Guards against a second injection while the first one is still waiting
    // for the page to render.
    if (window.__ssInjected) return;
    window.__ssInjected = true;

    const PLACEHOLDERS = {
        id_id: 'Nama pengguna',
        de_de: 'Benutzername',
        es_es: 'Nombre de usuario',
        fr_fr: "Nom d'utilisateur",
        it_it: 'Nome utente',
        pl_pl: 'Nazwa użytkownika',
        pt_br: 'Nome de usuário',
        vi_vn: 'Tên người dùng',
        tr_tr: 'Kullanıcı adı',
        th_th: 'ชื่อผู้ใช้',
        zh_cn: '用户名',
        zh_tw: '使用者名稱',
        ja_jp: 'ユーザー名',
        ko_kr: '사용자 이름',
        ar_001: 'اسم المستخدم'
    };

    // Roblox's locale codes, keyed by the two-letter language in <html lang>.
    const LANGUAGE_TO_LOCALE = {
        id: 'id_id', de: 'de_de', es: 'es_es', fr: 'fr_fr', it: 'it_it', pl: 'pl_pl',
        pt: 'pt_br', vi: 'vi_vn', tr: 'tr_tr', th: 'th_th', ja: 'ja_jp', ko: 'ko_kr', ar: 'ar_001'
    };

    // Roblox writes the active language into the page itself, so in the normal
    // case no request is needed at all. <html lang> is a second source in case
    // the meta tag is ever dropped; "en" is not trusted there, because it is
    // also what a page says before it has been localised.
    const readPageLocale = function () {
        const meta = document.querySelector('meta[name="locale-data"]');
        const code = meta && meta.getAttribute('data-language-code');
        if (code) return code.toLowerCase();

        const lang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
        if (lang.startsWith('zh')) return /tw|hk|hant/.test(lang) ? 'zh_tw' : 'zh_cn';
        return LANGUAGE_TO_LOCALE[lang.slice(0, 2)] || null;
    };

    // content.js runs in the same isolated world and needs the same value, so the
    // result is shared through a promise instead of being worked out twice.
    const loadLocale = function () {
        if (window.__ssLocalePromise) return window.__ssLocalePromise;

        const pageLocale = readPageLocale();
        if (pageLocale) {
            window.__ssLocalePromise = Promise.resolve(pageLocale);
            return window.__ssLocalePromise;
        }

        window.__ssLocalePromise = fetch(
            'https://locale.roblox.com/v1/locales/user-localization-locus-supported-locales',
            // A signed-out session must not be bounced to the login page: a
            // redirect comes back as a non-ok response and English is used.
            { credentials: 'include', redirect: 'manual' }
        )
            .then(response => (response.ok ? response.json() : null))
            .then(data => (data && data.generalExperience && data.generalExperience.locale) || 'en_us')
            .catch(() => 'en_us');

        return window.__ssLocalePromise;
    };

    // ---------------------------------------------------------------------
    // Placement
    //
    // Roblox reshuffles the game page every so often, and a panel that only
    // knows one container simply disappears when that container is renamed.
    // Placement therefore works through a ranked list of strategies, keeps
    // watching the page, puts the panel back when Roblox re-renders it away,
    // and moves it up to a better spot as soon as one appears. If nothing on
    // the page is recognisable at all, the panel floats in the corner - it
    // never just fails to show up.
    // ---------------------------------------------------------------------

    // Known spots, best first. "after" places the panel below the element,
    // "before" above it.
    const KNOWN_ANCHORS = [
        { selector: '#game-details-play-button-container', position: 'after' },
        { selector: '.game-calls-to-action', position: 'after' },
        { selector: '#game-detail-page .game-buttons-container', position: 'after' },
        { selector: '.game-buttons-container', position: 'after' },
        { selector: '#running-game-instances-container', position: 'before' }
    ];

    // Page regions that exist on practically any layout. Used only when neither
    // a known spot nor a Play button can be found.
    const GENERIC_REGIONS = ['#game-detail-page', 'main', '[role="main"]'];

    const RANK_PLAY_BUTTON = KNOWN_ANCHORS.length;
    const RANK_GENERIC = RANK_PLAY_BUTTON + 1;
    const RANK_FLOATING = 1000;
    const RANK_NONE = Infinity;

    // How long a detached panel waits for a proper spot before settling for a
    // generic region, and then for floating.
    const GENERIC_AFTER_MS = 4000;
    const FLOAT_AFTER_MS = 10000;
    const CHECK_INTERVAL_MS = 1000;

    // A container must be at least this wide to hold the panel sensibly; a
    // narrower one is a button row and the panel would squeeze in beside it.
    const MIN_CONTAINER_WIDTH = 250;

    const PLAY_BUTTON_SELECTOR =
        '[data-testid*="play" i], [id*="play-button" i], [class*="play-button" i], button[aria-label*="play" i]';

    const isOwnElement = element => Boolean(element && element.closest && element.closest('#ss-panel'));

    const isVisible = element => Boolean(element && element.isConnected && element.getClientRects().length > 0);

    const pageScope = () => document.querySelector(GENERIC_REGIONS.join(', ')) || document.body;

    // Roblox renames containers now and then, but a game page always has a
    // Play button. Anything that looks like one - by test id, id, class or
    // accessible label - is accepted, as long as it is visible and not part of
    // this panel.
    const findPlayButton = function (scope) {
        for (const element of scope.querySelectorAll(PLAY_BUTTON_SELECTOR)) {
            if (!isOwnElement(element) && isVisible(element)) return element;
        }

        return null;
    };

    // Climbs from the button to the first ancestor wide enough to sit above the
    // panel, so the panel lands below the button row rather than inside it.
    const containerAround = function (element, scope) {
        let node = element;

        while (
            node.parentElement &&
            node.parentElement !== scope &&
            node.getBoundingClientRect().width < MIN_CONTAINER_WIDTH
        ) {
            node = node.parentElement;
        }

        return node;
    };

    const locatePlacement = function () {
        for (let rank = 0; rank < KNOWN_ANCHORS.length; rank++) {
            const { selector, position } = KNOWN_ANCHORS[rank];
            const element = document.querySelector(selector);

            if (element && element.parentNode && !isOwnElement(element)) {
                return { element, position, rank, strategy: selector };
            }
        }

        const scope = pageScope();
        const playButton = findPlayButton(scope);
        if (playButton) {
            return {
                element: containerAround(playButton, scope),
                position: 'after',
                rank: RANK_PLAY_BUTTON,
                strategy: 'play button (detected)'
            };
        }

        for (const selector of GENERIC_REGIONS) {
            const element = document.querySelector(selector);
            if (element && !isOwnElement(element)) {
                return { element, position: 'prepend', rank: RANK_GENERIC, strategy: `${selector} (generic)` };
            }
        }

        return null;
    };

    const insertAt = function (panel, placement) {
        const { element, position } = placement;

        if (position === 'prepend') {
            element.insertBefore(panel, element.firstChild);
        } else if (position === 'before') {
            element.parentNode.insertBefore(panel, element);
        } else {
            element.parentNode.insertBefore(panel, element.nextSibling);
        }
    };

    const parseColor = function (value) {
        const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(value || '');
        if (!match) return null;

        return { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] };
    };

    // Roblox marks its dark theme with a class on <body> today, and the
    // stylesheet reacts to that. In case the class changes, the colour actually
    // painted behind the panel is measured as well. Returns null when every
    // ancestor is transparent, which leaves the decision to the stylesheet.
    const backgroundIsDark = function (panel) {
        for (let node = panel.parentElement; node; node = node.parentElement) {
            const color = parseColor(getComputedStyle(node).backgroundColor);
            if (!color || color.a < 0.5) continue;

            const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
            return luminance < 0.45;
        }

        return null;
    };

    const startPlacement = function (panel) {
        let placedRank = RANK_NONE;
        let detachedSince = Date.now();
        let scheduled = false;

        const report = strategy => {
            if (window.__ssPlacement === strategy) return;
            window.__ssPlacement = strategy;
            console.info('[ServerScout] panel placed:', strategy);
        };

        const place = () => {
            const onGamePage = isGamePage();

            // One class tells the stylesheet which panel this is: off a game page
            // it is the floating window, with the games box, the ▶ join button and
            // the drag grip; on a game page it is the original box under Play.
            panel.classList.toggle('ss-away', !onGamePage);

            if (panel.classList.contains('ss-pinned')) {
                if (!onGamePage) {
                    // A panel the user dragged is theirs: leave it where it was
                    // dropped instead of moving it back into the corner.
                    if (!panel.isConnected) document.body.appendChild(panel);

                    const pinnedDark = backgroundIsDark(panel);
                    if (pinnedDark !== null) panel.classList.toggle('dark', pinnedDark);
                    return;
                }

                // Dragging belongs to the floating panel. Coming back to a game
                // page puts a moved panel back under the Play button, so that box
                // keeps the original fixed shape and position it always had.
                panel.classList.remove('ss-pinned', 'is-dragging');
                panel.style.left = '';
                panel.style.top = '';
                panel.style.width = '';
                placedRank = RANK_NONE;
                detachedSince = Date.now();
            }

            // Every other Roblox page - home, a profile, the catalog - has no
            // Play button to sit under, so the panel floats there instead of
            // disappearing. Roblox can also switch pages without a reload; this
            // keeps a search and its results alive through such a detour.
            if (!onGamePage) {
                if (panel.parentNode !== document.body) document.body.appendChild(panel);
                panel.classList.add('ss-floating');
                placedRank = RANK_FLOATING;
                report('floating (not a game page)');

                const floatingDark = backgroundIsDark(panel);
                if (floatingDark !== null) panel.classList.toggle('dark', floatingDark);
                return;
            }

            const attached = panel.isConnected;
            if (!attached && placedRank !== RANK_NONE) {
                // Roblox re-rendered the area and took the panel with it.
                placedRank = RANK_NONE;
                detachedSince = Date.now();
            }

            const waited = Date.now() - detachedSince;
            const placement = locatePlacement();
            const improves = Boolean(placement) && placement.rank < placedRank;

            // Moving a panel the user is typing in would drop the focus.
            const busy = attached && panel.contains(document.activeElement);

            if (improves && !busy && (attached || placement.rank < RANK_GENERIC || waited > GENERIC_AFTER_MS)) {
                insertAt(panel, placement);
                panel.classList.remove('ss-floating');
                placedRank = placement.rank;
                report(placement.strategy);
            } else if (!attached && waited > FLOAT_AFTER_MS) {
                document.body.appendChild(panel);
                panel.classList.add('ss-floating');
                placedRank = RANK_FLOATING;
                report('floating (no known spot on this page)');
            }

            if (panel.isConnected) {
                const dark = backgroundIsDark(panel);
                if (dark !== null) panel.classList.toggle('dark', dark);
            }
        };

        const check = () => {
            scheduled = false;

            // A page this script does not control can throw in surprising ways;
            // one bad check must never stop the ones that follow.
            try {
                place();
            } catch (error) {
                console.warn('[ServerScout] placement check failed:', error);
            }
        };

        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(check, 150);
        };

        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

        // Time-based steps (generic region, floating) must also happen on a page
        // that has stopped changing.
        setInterval(check, CHECK_INTERVAL_MS);
        check();
    };

    const setupInterface = async function () {
        const locale = await loadLocale();

        const panel = document.createElement('div');
        panel.id = 'ss-panel';
        panel.classList.add('is-idle');

        const templateResponse = await fetch(chrome.runtime.getURL('panel.html'));
        panel.innerHTML = await templateResponse.text();

        const inputField = panel.querySelector('#ss-input');
        if (inputField) {
            inputField.placeholder = PLACEHOLDERS[locale] || 'Username';
            // Never carry over a value from an earlier visit.
            inputField.value = '';
        }

        startPlacement(panel);
    };

    setupInterface().catch((error) => {
        window.__ssInjected = false;
        console.error('[ServerScout] panel setup failed:', error);
    });
})();
