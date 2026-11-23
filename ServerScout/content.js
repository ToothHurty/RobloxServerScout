async function startServerScout() {
	(() => {
		if (window.__ssEngineActive) return;
		window.__ssEngineActive = true;

		const CONFIG = Object.freeze({
			SEARCH: {
				// How many thumbnail batches may be in flight at once. Every batch is
				// one network round trip and a busy game needs thousands of them, so
				// this is the single biggest lever on search time. The limit adapts:
				// it ramps up while requests succeed and halves on a rate-limit, so a
				// fast connection goes wide without hammering a throttled endpoint.
				START_CONCURRENCY: 8,
				MIN_CONCURRENCY: 2,
				MAX_CONCURRENCY: 14,
				// Clean batches in a row before the limit is raised by one.
				SUCCESSES_BEFORE_RAMP: 6,
				// 100 is the maximum the batch endpoint accepts.
				BATCH_SIZE: 100,
				// How long a worker waits when the queue is empty but the server scan
				// is still running.
				IDLE_POLL_SECONDS: 0.05,
				// A failed batch goes back in the queue this many times before it is
				// written off. Dropping it outright can hide the target.
				MAX_BATCH_RETRIES: 3,
				// When one worker is rate-limited, the others hold off too instead of
				// piling onto an endpoint that is already saying no. Deliberately
				// short: makeRequest has already retried this batch several times
				// with its own backoff before the error reaches the worker.
				RATE_LIMIT_COOLDOWN_MS: 1500,
				// A result row only has to show the server was found, not all 50
				// players in it.
				MAX_RESULT_AVATARS: 12
			},
			SCAN: {
				// Roblox does not return a server's full roster. Each call yields a
				// small RANDOM SAMPLE of its players (measured: ~5 per server), so a
				// single pass structurally cannot see everyone - which is exactly how
				// players end up being missed.
				//
				// Re-querying returns a different sample, so unseen tokens accumulate
				// across passes. Coverage is measured against the player counts the
				// API itself reports, and the sweep stops as soon as it is high
				// enough or a pass stops yielding anyone new.
				MAX_PASSES: 6,
				COVERAGE_TARGET: 0.97,
				MIN_NEW_TOKENS_PER_PASS: 5,
				// Bounded lookup used to attach player count and ping to a server
				// that presence found without any sweep. It runs once per result and
				// no longer blocks rendering, so the budget can be generous - at 12
				// pages a server past the first 1200 simply never got its numbers.
				INFO_LOOKUP_MAX_PAGES: 40,
				// The readout used to fetch a single page, so it always reported
				// "100 servers" no matter how big the game was - that was the query's
				// page size, not a fact about the game. It now pages, bounded, and
				// says "+" when there is more beyond what it read.
				PROBE_MAX_PAGES: 5
			},
			REFRESH: {
				// While idle the token readout is re-probed on this interval so the
				// panel always reflects the current state of the game rather than
				// whatever was true when the page loaded. Paused while the tab is
				// hidden and while a search is running (the search reports its own
				// live progress into the same row). Paced for the multi-page probe:
				// one readout now costs up to PROBE_MAX_PAGES requests.
				INTERVAL_MS: 30000,
				// How often the address bar is checked for a switch to another game
				// that Roblox made without reloading the page.
				PLACE_CHECK_MS: 1000
			},
			REPEAT: {
				// Gap between automatic retries of "repeat until found".
				DELAY_MS: 2000,
				// A failed attempt waits longer before trying again, so a broken
				// connection does not turn into a request flood.
				ERROR_DELAY_MS: 5000
			},
			SOUND: {
				// Where older versions saved the mute toggle. Deleted on start-up.
				LEGACY_STORAGE_KEY: 'sbxSoundEnabled',
				// Deliberately quiet - this fires while the user is on a game page.
				VOLUME: 0.07
			},
			STORAGE: {
				// Earlier versions saved the last searched name under this key and put
				// it back into the box on every visit. That no longer happens, and
				// whatever an old version left behind is deleted on start-up.
				LEGACY_LAST_QUERY_KEY: 'sbxLastQuery'
			},
			HTTP: {
				// A request that never answered used to hang the search forever.
				TIMEOUT_MS: 15000,
				MAX_RETRIES: 3
			},
			// Every Roblox endpoint the extension uses, in one place. When Roblox
			// moves something, this table is the only thing that has to change.
			// "{name}" placeholders are filled in, URL-encoded, by RobloxApi.
			API: {
				// Tried in order until one answers with a recognisable server list;
				// the one that worked is remembered for the rest of the page's life.
				// Both forms were measured to return the same response.
				SERVER_LIST: [
					'games.roblox.com/v1/games/{placeId}/servers/Public?limit=100&cursor={cursor}',
					'games.roblox.com/v1/games/{placeId}/servers/0?limit=100&cursor={cursor}'
				],
				PRESENCE: 'presence.roblox.com/v1/presence/users',
				UNIVERSE: 'games.roblox.com/v1/games?universeIds={universeId}',
				// Undocumented endpoint the website's own search box uses. Its results
				// carry the root place id, which is the game a join needs.
				GAME_SEARCH: 'apis.roblox.com/search-api/omni-search?searchQuery={query}&pageType=all&sessionId={session}',
				USERNAMES: 'users.roblox.com/v1/usernames/users',
				USER_BY_ID: 'users.roblox.com/v1/users/{userId}',
				THUMBNAIL_BATCH: 'thumbnails.roblox.com/v1/batch',
				AVATAR_HEADSHOT: 'thumbnails.roblox.com/v1/users/avatar-headshot?userIds={userId}&size=150x150&format=Png&isCircular=false'
			}
		});

		const createLanguageMap = () => {
			const translations = new Map();
			
			translations.set('en_us', {
				repeatUntilFound: 'Repeat Search Until Found',
				attemptCounter: 'Attempts:',
				serverJoin: 'Join',
				repeatIndicator: '(repeating)',
				systemError: 'Error occurred',
				userNotValid: 'Invalid Username',
				activeSearch: 'Searching...',
				searchAborted: 'Canceled search',
				userNotLocated: 'Target not found',
				userLocated: 'Found target',
				reviewPrompt: `Did this help? Give us a review!`,
				gamesPlaceholder: 'Games to search (names, IDs or links)'
			});

			translations.set('id_id', {
				repeatUntilFound: 'Ulangi Pencarian Hingga Ditemukan',
				attemptCounter: 'Percobaan:',
				serverJoin: 'Bergabung',
				repeatIndicator: '(berulang)',
				systemError: 'Terjadi kesalahan',
				userNotValid: 'Nama Pengguna Tidak Valid',
				activeSearch: 'Mencari...',
				searchAborted: 'Pencarian dibatalkan',
				userNotLocated: 'Target tidak ditemukan',
				userLocated: 'Target ditemukan',
				reviewPrompt: `Apakah ini membantu? Beri kami ulasan!`
			});

			translations.set('de_de', {
				repeatUntilFound: 'Suche wiederholen, bis gefunden',
				attemptCounter: 'Versuche:',
				serverJoin: 'Beitreten',
				repeatIndicator: '(Wiederholt)',
				systemError: 'Fehler aufgetreten',
				userNotValid: 'Ungültiger Benutzername',
				activeSearch: 'Suche...',
				searchAborted: 'Suche abgebrochen',
				userNotLocated: 'Ziel nicht gefunden',
				userLocated: 'Ziel gefunden',
				reviewPrompt: `Gib uns eine Bewertung!`
			});

			translations.set('es_es', {
				repeatUntilFound: 'Repetir búsqueda hasta encontrarla',
				attemptCounter: 'Intentos:',
				serverJoin: 'Unirse',
				repeatIndicator: '(repitiendo)',
				systemError: 'Error',
				userNotValid: 'Nombre de usuario no válido',
				activeSearch: 'Buscando...',
				searchAborted: 'Búsqueda cancelada',
				userNotLocated: 'Objetivo no encontrado',
				userLocated: 'Objetivo encontrado',
				reviewPrompt: `¿Te resultó útil? ¡Danos una reseña!`
			});

			translations.set('fr_fr', {
				repeatUntilFound: "Répétez la recherche jusqu'à ce que l'utilisateur soit trouvé.",
				attemptCounter: 'Tentatives:',
				serverJoin: 'Rejoindre',
				repeatIndicator: '(répétition)',
				systemError: "Une erreur s'est produite",
				userNotValid: "Nom d'utilisateur invalide",
				activeSearch: 'Recherche en cours...',
				searchAborted: 'Recherche annulée',
				userNotLocated: 'Cible non trouvée',
				userLocated: 'Cible trouvée',
				reviewPrompt: `Donnez-nous votre avis !`
			});

			translations.set('it_it', {
				repeatUntilFound: 'Ripeti la ricerca finché non viene trovato',
				attemptCounter: 'Tentativi:',
				serverJoin: 'Unisciti',
				repeatIndicator: '(ripetuto)',
				systemError: 'Si è verificato un errore',
				userNotValid: 'Nome utente non valido',
				activeSearch: 'Ricerca in corso...',
				searchAborted: 'Ricerca annullata',
				userNotLocated: 'Destinazione non trovata',
				userLocated: 'Destinazione trovata',
				reviewPrompt: `Ti è stato utile? Lasciaci una recensione!`
			});

			translations.set('pl_pl', {
				repeatUntilFound: 'Powtarzaj wyszukiwanie, aż zostanie znalezione',
				attemptCounter: 'Próby:',
				serverJoin: 'Dołącz',
				repeatIndicator: '(powtarzane)',
				systemError: 'Wystąpił błąd',
				userNotValid: 'Nieprawidłowa nazwa użytkownika',
				activeSearch: 'Wyszukiwanie...',
				searchAborted: 'Anulowane wyszukiwanie',
				userNotLocated: 'Nie znaleziono celu',
				userLocated: 'Znaleziono cel',
				reviewPrompt: `Czy to pomogło? Oceń nas!`
			});

			translations.set('pt_br', {
				repeatUntilFound: 'Repetir busca até encontrar',
				attemptCounter: 'Tentativas:',
				serverJoin: 'Entrar',
				repeatIndicator: '(repetindo)',
				systemError: 'Ocorreu um erro',
				userNotValid: 'Nome de usuário inválido',
				activeSearch: 'Pesquisando...',
				searchAborted: 'Pesquisa cancelada',
				userNotLocated: 'Alvo não encontrado',
				userLocated: 'Alvo encontrado',
				reviewPrompt: `Isso ajudou? Dê-nos uma avaliação!`
			});

			translations.set('vi_vn', {
				repeatUntilFound: 'Lặp lại tìm kiếm cho đến khi tìm thấy',
				attemptCounter: 'Số lần thử:',
				serverJoin: 'Tham gia',
				repeatIndicator: '(lặp lại)',
				systemError: 'Đã xảy ra lỗi',
				userNotValid: 'Tên người dùng không hợp lệ',
				activeSearch: 'Đang tìm kiếm...',
				searchAborted: 'Đã hủy tìm kiếm',
				userNotLocated: 'Không tìm thấy mục tiêu',
				userLocated: 'Đã tìm thấy mục tiêu',
				reviewPrompt: `Hãy cho chúng tôi một đánh giá!`
			});

			translations.set('tr_tr', {
				repeatUntilFound: 'Bulunana Kadar Aramayı Tekrarla',
				attemptCounter: 'Denemeler:',
				serverJoin: 'Katıl',
				repeatIndicator: '(tekrarlayan)',
				systemError: 'Hata oluştu',
				userNotValid: 'Geçersiz Kullanıcı Adı',
				activeSearch: 'Aranıyor...',
				searchAborted: 'İptal edilen arama',
				userNotLocated: 'Hedef bulunamadı',
				userLocated: 'Hedef bulundu',
				reviewPrompt: `Bu yardımcı oldu mu? Bize bir yorum yap!`
			});

			translations.set('th_th', {
				repeatUntilFound: 'ค้นหาซ้ำจนกว่าจะพบ',
				attemptCounter: 'จำนวนครั้งที่พยายาม:',
				serverJoin: 'เข้าร่วม',
				repeatIndicator: '(ซ้ำ)',
				systemError: 'เกิดข้อผิดพลาด',
				userNotValid: 'ชื่อผู้ใช้ไม่ถูกต้อง',
				activeSearch: 'กำลังค้นหา...',
				searchAborted: 'ยกเลิกการค้นหา',
				userNotLocated: 'ไม่พบเป้าหมาย',
				userLocated: 'พบเป้าหมายแล้ว',
				reviewPrompt: `สิ่งนี้มีประโยชน์หรือไม่ แสดงความคิดเห็นกับเรา!`
			});

			translations.set('zh_cn', {
				repeatUntilFound: '重复搜索直至找到',
				attemptCounter: '尝试次数：',
				serverJoin: '加入',
				repeatIndicator: '（重复）',
				systemError: '发生错误',
				userNotValid: '用户名无效',
				activeSearch: '正在搜索...',
				searchAborted: '取消搜索',
				userNotLocated: '未找到目标',
				userLocated: '找到目标',
				reviewPrompt: `这有帮助吗？给我们评论！`
			});

			translations.set('zh_tw', {
				repeatUntilFound: '重複搜尋直至找到',
				attemptCounter: '嘗試：',
				serverJoin: '加入',
				repeatIndicator: '（重複）',
				systemError: '發生錯誤',
				userNotValid: '使用者名稱無效',
				activeSearch: '正在搜尋...',
				searchAborted: '已取消搜尋',
				userNotLocated: '未找到目標',
				userLocated: '找到目標',
				reviewPrompt: `這樣有幫助嗎？給我們一個評論！`
			});

			translations.set('ja_jp', {
				repeatUntilFound: '見つかるまで検索を繰り返す',
				attemptCounter: '試行回数:',
				serverJoin: '参加',
				repeatIndicator: '(繰り返し)',
				systemError: 'エラーが発生しました',
				userNotValid: 'ユーザー名が無効です',
				activeSearch: '検索中...',
				searchAborted: '検索をキャンセルしました',
				userNotLocated: 'ターゲットが見つかりません',
				userLocated: 'ターゲットが見つかりました',
				reviewPrompt: `役に立ちましたか? レビューを投稿してください!`
			});

			translations.set('ko_kr', {
				repeatUntilFound: '찾을 때까지 반복 검색',
				attemptCounter: '시도 횟수:',
				serverJoin: '참여',
				repeatIndicator: '(반복)',
				systemError: '오류 발생',
				userNotValid: '잘못된 사용자 이름',
				activeSearch: '검색 중...',
				searchAborted: '검색 취소',
				userNotLocated: '대상을 찾을 수 없음',
				userLocated: '대상을 찾았습니다.',
				reviewPrompt: `도움이 되었나요? 리뷰를 남겨주세요!`
			});

			translations.set('ar_001', {
				repeatUntilFound: 'كرر البحث حتى يتم العثور عليه',
				attemptCounter: 'المحاولات:',
				serverJoin: 'انضمام',
				repeatIndicator: '(متكرر)',
				systemError: 'حدث خطأ',
				userNotValid: 'اسم المستخدم غير صالح',
				activeSearch: 'جاري البحث...',
				searchAborted: 'تم إلغاء البحث',
				userNotLocated: 'لم يتم العثور على الهدف',
				userLocated: 'تم العثور على الهدف',
				reviewPrompt: `هل ساعدك هذا؟ أرسل لنا تقييمًا!`
			});

			// Strings added later, kept in one block so a missing language is easy to
			// spot. LanguageManager.getText falls back to English per string.
			const additions = {
				en_us: { userElsewhere: 'Player is not in this game', linkCopied: 'Join link copied' },
				id_id: { userElsewhere: 'Pemain tidak ada di game ini', linkCopied: 'Tautan bergabung disalin' },
				de_de: { userElsewhere: 'Spieler ist nicht in diesem Spiel', linkCopied: 'Join-Link kopiert' },
				es_es: { userElsewhere: 'El jugador no está en este juego', linkCopied: 'Enlace para unirse copiado' },
				fr_fr: { userElsewhere: "Le joueur n'est pas dans ce jeu", linkCopied: 'Lien pour rejoindre copié' },
				it_it: { userElsewhere: 'Il giocatore non è in questo gioco', linkCopied: 'Link per unirsi copiato' },
				pl_pl: { userElsewhere: 'Gracz nie jest w tej grze', linkCopied: 'Skopiowano link do dołączenia' },
				pt_br: { userElsewhere: 'O jogador não está neste jogo', linkCopied: 'Link para entrar copiado' },
				vi_vn: { userElsewhere: 'Người chơi không ở trong trò chơi này', linkCopied: 'Đã sao chép liên kết tham gia' },
				tr_tr: { userElsewhere: 'Oyuncu bu oyunda değil', linkCopied: 'Katılma bağlantısı kopyalandı' },
				th_th: { userElsewhere: 'ผู้เล่นไม่ได้อยู่ในเกมนี้', linkCopied: 'คัดลอกลิงก์เข้าร่วมแล้ว' },
				zh_cn: { userElsewhere: '玩家不在此游戏中', linkCopied: '已复制加入链接' },
				zh_tw: { userElsewhere: '玩家不在此遊戲中', linkCopied: '已複製加入連結' },
				ja_jp: { userElsewhere: 'プレイヤーはこのゲームにいません', linkCopied: '参加リンクをコピーしました' },
				ko_kr: { userElsewhere: '플레이어가 이 게임에 없습니다', linkCopied: '참여 링크를 복사했습니다' },
				ar_001: { userElsewhere: 'اللاعب ليس في هذه اللعبة', linkCopied: 'تم نسخ رابط الانضمام' }
			};

			Object.keys(additions).forEach(locale => {
				const existing = translations.get(locale);
				if (existing) Object.assign(existing, additions[locale]);
			});

			// Strings for joining a player by username. Kept in their own block so a
			// translation can be added without touching the strings above.
			const joinStrings = {
				en_us: {
					joinPlayer: 'Join player',
					joinLocating: 'Finding player…',
					joinNotInGame: 'Player is not in a game right now',
					joinPrivate: "Roblox isn't sharing which game they are in",
					joinSignIn: 'Sign in to Roblox to find players',
					joinOpening: 'Opening Roblox…',
					joinFailed: 'Could not join that player'
				},
				id_id: {
					joinPlayer: 'Bergabung dengan pemain',
					joinLocating: 'Mencari pemain…',
					joinNotInGame: 'Pemain tidak sedang berada di game mana pun',
					joinPrivate: 'Roblox tidak membagikan game yang dimainkan',
					joinSignIn: 'Masuk ke Roblox untuk menemukan pemain',
					joinOpening: 'Membuka Roblox…',
					joinFailed: 'Tidak dapat bergabung dengan pemain tersebut'
				},
				de_de: {
					joinPlayer: 'Spieler beitreten',
					joinLocating: 'Spieler wird gesucht…',
					joinNotInGame: 'Spieler ist gerade in keinem Spiel',
					joinPrivate: 'Roblox teilt nicht mit, in welchem Spiel er ist',
					joinSignIn: 'Bei Roblox anmelden, um Spieler zu finden',
					joinOpening: 'Roblox wird geöffnet…',
					joinFailed: 'Konnte dem Spieler nicht beitreten'
				},
				es_es: {
					joinPlayer: 'Unirse al jugador',
					joinLocating: 'Buscando jugador…',
					joinNotInGame: 'El jugador no está en ningún juego ahora',
					joinPrivate: 'Roblox no comparte en qué juego está',
					joinSignIn: 'Inicia sesión en Roblox para encontrar jugadores',
					joinOpening: 'Abriendo Roblox…',
					joinFailed: 'No se pudo unir a ese jugador'
				},
				fr_fr: {
					joinPlayer: 'Rejoindre le joueur',
					joinLocating: 'Recherche du joueur…',
					joinNotInGame: "Le joueur n'est dans aucun jeu en ce moment",
					joinPrivate: 'Roblox ne partage pas le jeu dans lequel il est',
					joinSignIn: 'Connectez-vous à Roblox pour trouver des joueurs',
					joinOpening: 'Ouverture de Roblox…',
					joinFailed: 'Impossible de rejoindre ce joueur'
				},
				it_it: {
					joinPlayer: 'Unisciti al giocatore',
					joinLocating: 'Ricerca del giocatore…',
					joinNotInGame: 'Il giocatore non è in nessun gioco al momento',
					joinPrivate: 'Roblox non condivide in quale gioco si trova',
					joinSignIn: 'Accedi a Roblox per trovare i giocatori',
					joinOpening: 'Apertura di Roblox…',
					joinFailed: 'Impossibile unirsi a quel giocatore'
				},
				pl_pl: {
					joinPlayer: 'Dołącz do gracza',
					joinLocating: 'Wyszukiwanie gracza…',
					joinNotInGame: 'Gracz nie jest teraz w żadnej grze',
					joinPrivate: 'Roblox nie udostępnia, w której grze jest',
					joinSignIn: 'Zaloguj się w Roblox, aby znajdować graczy',
					joinOpening: 'Otwieranie Roblox…',
					joinFailed: 'Nie udało się dołączyć do tego gracza'
				},
				pt_br: {
					joinPlayer: 'Entrar com o jogador',
					joinLocating: 'Procurando jogador…',
					joinNotInGame: 'O jogador não está em nenhum jogo agora',
					joinPrivate: 'O Roblox não compartilha em qual jogo ele está',
					joinSignIn: 'Entre no Roblox para encontrar jogadores',
					joinOpening: 'Abrindo o Roblox…',
					joinFailed: 'Não foi possível entrar com esse jogador'
				},
				vi_vn: {
					joinPlayer: 'Tham gia cùng người chơi',
					joinLocating: 'Đang tìm người chơi…',
					joinNotInGame: 'Người chơi hiện không ở trong trò chơi nào',
					joinPrivate: 'Roblox không chia sẻ người chơi đang ở trò chơi nào',
					joinSignIn: 'Đăng nhập Roblox để tìm người chơi',
					joinOpening: 'Đang mở Roblox…',
					joinFailed: 'Không thể tham gia cùng người chơi này'
				},
				tr_tr: {
					joinPlayer: 'Oyuncuya katıl',
					joinLocating: 'Oyuncu aranıyor…',
					joinNotInGame: 'Oyuncu şu anda hiçbir oyunda değil',
					joinPrivate: 'Roblox hangi oyunda olduğunu paylaşmıyor',
					joinSignIn: 'Oyuncuları bulmak için Roblox\'a giriş yapın',
					joinOpening: 'Roblox açılıyor…',
					joinFailed: 'Bu oyuncuya katılınamadı'
				},
				th_th: {
					joinPlayer: 'เข้าร่วมผู้เล่น',
					joinLocating: 'กำลังค้นหาผู้เล่น…',
					joinNotInGame: 'ผู้เล่นไม่ได้อยู่ในเกมใดในขณะนี้',
					joinPrivate: 'Roblox ไม่ได้แชร์ว่าอยู่ในเกมใด',
					joinSignIn: 'เข้าสู่ระบบ Roblox เพื่อค้นหาผู้เล่น',
					joinOpening: 'กำลังเปิด Roblox…',
					joinFailed: 'ไม่สามารถเข้าร่วมผู้เล่นนี้ได้'
				},
				zh_cn: {
					joinPlayer: '加入该玩家',
					joinLocating: '正在查找玩家…',
					joinNotInGame: '该玩家当前不在任何游戏中',
					joinPrivate: 'Roblox 未公开该玩家所在的游戏',
					joinSignIn: '登录 Roblox 才能查找玩家',
					joinOpening: '正在打开 Roblox…',
					joinFailed: '无法加入该玩家'
				},
				zh_tw: {
					joinPlayer: '加入該玩家',
					joinLocating: '正在尋找玩家…',
					joinNotInGame: '該玩家目前不在任何遊戲中',
					joinPrivate: 'Roblox 未公開該玩家所在的遊戲',
					joinSignIn: '登入 Roblox 才能尋找玩家',
					joinOpening: '正在開啟 Roblox…',
					joinFailed: '無法加入該玩家'
				},
				ja_jp: {
					joinPlayer: 'プレイヤーに参加',
					joinLocating: 'プレイヤーを検索中…',
					joinNotInGame: 'プレイヤーは現在どのゲームにもいません',
					joinPrivate: 'Roblox がプレイ中のゲームを公開していません',
					joinSignIn: 'プレイヤーを探すには Roblox にサインインしてください',
					joinOpening: 'Roblox を起動しています…',
					joinFailed: 'このプレイヤーに参加できませんでした'
				},
				ko_kr: {
					joinPlayer: '플레이어와 함께하기',
					joinLocating: '플레이어를 찾는 중…',
					joinNotInGame: '플레이어가 현재 어떤 게임에도 없습니다',
					joinPrivate: 'Roblox가 플레이 중인 게임을 공개하지 않았습니다',
					joinSignIn: '플레이어를 찾으려면 Roblox에 로그인하세요',
					joinOpening: 'Roblox를 여는 중…',
					joinFailed: '해당 플레이어와 함께할 수 없습니다'
				},
				ar_001: {
					joinPlayer: 'الانضمام إلى اللاعب',
					joinLocating: 'جارٍ البحث عن اللاعب…',
					joinNotInGame: 'اللاعب ليس في أي لعبة الآن',
					joinPrivate: 'Roblox لا يشارك اللعبة التي يلعبها',
					joinSignIn: 'سجّل الدخول إلى Roblox للعثور على اللاعبين',
					joinOpening: 'جارٍ فتح Roblox…',
					joinFailed: 'تعذّر الانضمام إلى هذا اللاعب'
				}
			};

			Object.keys(joinStrings).forEach(locale => {
				const existing = translations.get(locale);
				if (existing) Object.assign(existing, joinStrings[locale]);
			});

			return translations;
		};

		const Utils = {
			// Named for its unit: the old signature was `delay(ms)` but multiplied
			// its argument by 1000, which read as a bug at every call site.
			delay: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),

			randomDelayMs: (min, max) => new Promise(resolve =>
				setTimeout(resolve, Math.random() * (max - min) + min)
			),

			validateUsername: input => /(^(?=^[^_]+_?[^_]+$)\w{3,20}$|^\d+$)/.test(input),

			isUserId: input => /^\d+$/.test(String(input).trim()),

			// People paste names the way Roblox shows them (@name) or copy a whole
			// profile link. Both are reduced to something the lookup understands.
			normalizeQuery: input => {
				const value = String(input || '').trim();

				const profile = value.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?users\/(\d+)/i);
				if (profile) return profile[1];

				return value.replace(/^@/, '');
			},

			isValidQuery: input => Utils.validateUsername(Utils.normalizeQuery(input)),

			// "1.5K" instead of "1,500", so the readout fits on one short line. The
			// exact figures stay available in the row's tooltip.
			compactNumber: value => new Intl.NumberFormat('en-US', {
				notation: 'compact',
				maximumFractionDigits: 1
			}).format(value),

			// Fills the "{name}" placeholders of an endpoint template. Every value is
			// URL-encoded: server list cursors can contain characters such as "+"
			// that would otherwise be misread in a query string.
			fillTemplate: (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => {
				const value = values[key];
				return encodeURIComponent(value === undefined || value === null ? '' : String(value));
			}),

			// The first of several field names that is actually present. Roblox has
			// named the same fact differently across its APIs and API versions.
			pick: (source, keys) => {
				if (!source || typeof source !== 'object') return undefined;

				for (const key of keys) {
					if (source[key] !== undefined && source[key] !== null) return source[key];
				}

				return undefined;
			},

			toNumber: (value, fallback = 0) => {
				const number = Number(value);
				return value !== undefined && value !== null && Number.isFinite(number) ? number : fallback;
			},

			// Roblox serves thumbnails from rotating CDN hosts (tr / t0-t7.rbxcdn.com)
			// and the same avatar can come back from a different host on each call, so
			// the full URL is NOT a stable identity - comparing it literally makes the
			// match succeed or fail at random. The first path segment carries the
			// content hash, which is what actually identifies the image.
			thumbnailIdentity: url => {
				if (!url) return '';

				try {
					const segments = new URL(url).pathname.split('/').filter(Boolean);
					return (segments[0] || '').toLowerCase();
				} catch (error) {
					return String(url).toLowerCase();
				}
			},

			// An avatar that has not finished rendering comes back as a placeholder
			// image that every pending player shares. Comparing against one of those
			// would match an arbitrary stranger, so they are never usable as an
			// identity. Some responses omit `state` entirely - those are fine.
			isUsableThumbnail: entry =>
				Boolean(entry && entry.imageUrl && (!entry.state || entry.state === 'Completed')),

			// Icons are built through DOM calls like everything else here. The markup
			// is constant, so innerHTML would be harmless today - but keeping one rule
			// for element construction means a variable can never quietly slip in.
			svgIcon: (paths, options = {}) => {
				const NS = 'http://www.w3.org/2000/svg';
				const svg = document.createElementNS(NS, 'svg');

				svg.setAttribute('viewBox', '0 0 24 24');
				svg.setAttribute('aria-hidden', 'true');
				svg.setAttribute('fill', options.fill || 'none');

				if (options.stroke) {
					svg.setAttribute('stroke', 'currentColor');
					svg.setAttribute('stroke-width', String(options.stroke));
					svg.setAttribute('stroke-linecap', 'round');
					svg.setAttribute('stroke-linejoin', 'round');
				}

				paths.forEach(definition => {
					const path = document.createElementNS(NS, 'path');
					path.setAttribute('d', definition);
					svg.appendChild(path);
				});

				return svg;
			},

			// The panel can be torn down by Roblox's own re-renders at any time, so
			// every lookup has to tolerate a missing element.
			setDisplay: (id, value) => {
				const element = document.getElementById(id);
				if (element) element.style.display = value;
			},

			setText: (id, value) => {
				const element = document.getElementById(id);
				if (element) element.textContent = value;
			},

			isChecked: id => {
				const element = document.getElementById(id);
				return Boolean(element && element.checked);
			}
		};

		class HTTPClient {
			constructor() {
				this.baseHeaders = {};
			}

			// Credentialed requests are restricted to Roblox hosts so that session
			// cookies can never be sent to a third-party origin.
			static assertRobloxEndpoint(endpoint) {
				const url = new URL(`https://${endpoint}`);
				const host = url.hostname.toLowerCase();

				if (host !== 'roblox.com' && !host.endsWith('.roblox.com')) {
					throw new Error(`Blocked request to non-Roblox host: ${host}`);
				}

				return url.href;
			}

			static authError() {
				const error = new Error('Not signed in to Roblox');
				error.status = 401;
				error.authRequired = true;
				return error;
			}

			// Requests go out WITHOUT the Roblox session by default. Only the calls
			// that Roblox refuses to answer for a signed-out visitor pass
			// `{ session: true }`: presence (which server a player is in) and the
			// server list's player tokens - both measured to come back empty
			// without it. User lookups and avatars are public and never carry it.
			//
			// Even then the extension never sees the cookie: the browser attaches
			// it, it is HttpOnly, and the manifest has no "cookies" permission.
			async makeRequest(endpoint, options = {}) {
				const requestUrl = HTTPClient.assertRobloxEndpoint(endpoint);
				const { session = false, ...fetchOptions } = options;
				let attempt = 0;

				while (attempt < CONFIG.HTTP.MAX_RETRIES) {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), CONFIG.HTTP.TIMEOUT_MS);

					try {
						const response = await fetch(requestUrl, {
							...fetchOptions,
							headers: { ...this.baseHeaders, ...fetchOptions.headers },
							credentials: session ? 'include' : 'omit',
							// Redirects are never followed. With a missing or expired
							// session Roblox can answer an API call with a redirect to
							// its login page, and following it made the browser fetch
							// roblox.com/login in the background - which is what showed
							// up in the error log.
							redirect: 'manual',
							signal: controller.signal
						});

						if (response.type === 'opaqueredirect' || response.status === 401) {
							throw HTTPClient.authError();
						}

						if (!response.ok) {
							const httpError = new Error(`HTTP ${response.status}`);
							httpError.status = response.status;
							throw httpError;
						}

						return await response.json();
					} catch (error) {
						// A 4xx is a definite answer ("no such user"), not a hiccup.
						// Retrying it just burned ~7s and three requests per lookup.
						const isClientError = error.status >= 400 && error.status < 500 && error.status !== 429;
						if (isClientError) throw error;

						attempt++;
						if (attempt >= CONFIG.HTTP.MAX_RETRIES) {
							if (error.name === 'AbortError') {
								throw new Error(`Request timed out: ${endpoint.split('?')[0]}`);
							}
							throw error;
						}
						await Utils.randomDelayMs(2300, 3300);
					} finally {
						clearTimeout(timeoutId);
					}
				}
			}

			async getData(endpoint, options = {}) {
				return this.makeRequest(endpoint, options);
			}

			async postData(endpoint, payload, options = {}) {
				return this.makeRequest(endpoint, {
					...options,
					method: 'POST',
					body: payload,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}

		// The only layer that knows what Roblox's API responses look like. Every
		// response is reduced to a small, fixed shape here, so nothing else in the
		// extension reads a raw Roblox field. If Roblox renames a field, wraps a
		// list differently or retires an endpoint, the normalisers below already
		// accept the alternative names in use across Roblox's APIs, and the
		// server list falls back to its second endpoint - instead of the search
		// quietly reporting "not found".
		class RobloxApi {
			constructor(httpClient) {
				this.http = httpClient;
				this.serverListVariant = 0;
			}

			// { id, playing, maxPlayers, ping, fps, tokens } or null.
			static normalizeServer(raw) {
				const id = Utils.pick(raw, ['id', 'jobId', 'gameId', 'serverId', 'instanceId']);
				if (!id) return null;

				const players = Array.isArray(raw.players) ? raw.players : [];
				const tokens = Array.isArray(raw.playerTokens)
					? raw.playerTokens
					: players.map(player => player && (player.playerToken || player.token));

				const ping = Utils.pick(raw, ['ping', 'serverPing']);
				const fps = Utils.pick(raw, ['fps', 'serverFps']);

				return {
					id: String(id),
					playing: Utils.toNumber(Utils.pick(raw, ['playing', 'playerCount', 'currentPlayers']), players.length),
					maxPlayers: Utils.toNumber(Utils.pick(raw, ['maxPlayers', 'maxPlayerCount', 'capacity'])),
					ping: typeof ping === 'number' ? ping : null,
					fps: typeof fps === 'number' ? fps : null,
					tokens: tokens.filter(token => typeof token === 'string' && token.length > 0)
				};
			}

			// { servers, nextCursor }, or null when the response is not a server
			// list at all (which is treated like a failed request).
			static normalizeServerPage(raw) {
				const list = Array.isArray(raw) ? raw : Utils.pick(raw, ['data', 'servers', 'gameInstances', 'items']);
				if (!Array.isArray(list)) return null;

				return {
					servers: list.map(RobloxApi.normalizeServer).filter(Boolean),
					nextCursor: Utils.pick(raw, ['nextPageCursor', 'nextCursor', 'next_page_cursor']) || null
				};
			}

			// 0 offline, 1 website, 2 in a game, 3 in Studio. Accepts the numbers
			// Roblox sends today and the names some of its other APIs use.
			static normalizePresenceType(value) {
				if (typeof value === 'number') return value;

				const named = { offline: 0, invisible: 0, online: 1, website: 1, ingame: 2, game: 2, instudio: 3, studio: 3 };
				const key = String(value === undefined || value === null ? '' : value).replace(/[^a-z]/gi, '').toLowerCase();
				return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : null;
			}

			// { id, name, displayName } or null.
			static normalizeUser(raw) {
				const id = Utils.pick(raw, ['id', 'userId']);
				if (!id) return null;

				return {
					id: Number(id),
					name: String(Utils.pick(raw, ['name', 'username']) || ''),
					displayName: String(Utils.pick(raw, ['displayName']) || '')
				};
			}

			// [{ requestId, imageUrl, state }] or null.
			static normalizeThumbnails(raw) {
				const list = Array.isArray(raw) ? raw : Utils.pick(raw, ['data', 'thumbnails']);
				if (!Array.isArray(list)) return null;

				return list.filter(Boolean).map(entry => ({
					requestId: String(Utils.pick(entry, ['requestId']) || ''),
					imageUrl: Utils.pick(entry, ['imageUrl', 'url']) || null,
					state: Utils.pick(entry, ['state']) || null
				}));
			}

			async fetchServerPage(placeId, cursor = '') {
				const variants = CONFIG.API.SERVER_LIST;
				let lastError = null;

				for (let offset = 0; offset < variants.length; offset++) {
					const index = (this.serverListVariant + offset) % variants.length;
					const endpoint = Utils.fillTemplate(variants[index], { placeId, cursor });

					let raw;
					try {
						raw = await this.http.getData(endpoint, { session: true });
					} catch (error) {
						// Rate limits, timeouts and outages say nothing about the
						// endpoint having moved; they go to the caller's retry logic.
						const status = error && error.status;
						const moved = status === 400 || status === 404 || status === 405 || status === 410;
						if (!moved) throw error;

						lastError = error;
						continue;
					}

					const page = RobloxApi.normalizeServerPage(raw);
					if (!page) {
						lastError = new Error('Unrecognised server list response');
						continue;
					}

					if (index !== this.serverListVariant) {
						console.warn(`[ServerScout] server list endpoint ${this.serverListVariant + 1} stopped working; using endpoint ${index + 1}.`);
						this.serverListVariant = index;
					}

					return page;
				}

				throw lastError || new Error('No server list endpoint answered');
			}

			// The background worker is asked first: presence only answers for a
			// signed-in visitor, and from the page it is a cross-site request whose
			// cookies the browser can withhold. The direct request stays as the
			// fallback for an extension reloaded while the page stayed open.
			async requestPresence(userId) {
				const ids = [Number(userId)];

				try {
					const response = await chrome.runtime.sendMessage({ message: { userIds: ids } });
					if (response && response.ok) return response.data;
					if (response && response.authRequired) throw HTTPClient.authError();
				} catch (error) {
					if (error && error.authRequired) throw error;
				}

				return this.http.postData(CONFIG.API.PRESENCE, JSON.stringify({ userIds: ids }), { session: true });
			}

			// { type, placeId, rootPlaceId, universeId, jobId } or null.
			async fetchPresence(userId) {
				const raw = await this.requestPresence(userId);

				const list = Array.isArray(raw) ? raw : Utils.pick(raw, ['userPresences', 'presences', 'data']);
				if (!Array.isArray(list) || list.length === 0) return null;

				const entry = list.find(item => String(Utils.pick(item, ['userId', 'id'])) === String(userId)) || list[0];

				return {
					type: RobloxApi.normalizePresenceType(Utils.pick(entry, ['userPresenceType', 'presenceType', 'type'])),
					placeId: Utils.pick(entry, ['placeId']) || null,
					rootPlaceId: Utils.pick(entry, ['rootPlaceId']) || null,
					universeId: Utils.pick(entry, ['universeId']) || null,
					jobId: Utils.pick(entry, ['gameId', 'gameInstanceId', 'jobId']) || null
				};
			}

			// A presence that names the universe but not the place still points at
			// one game: the universe's root place is the place to join.
			async fetchUniversePlace(universeId) {
				try {
					const raw = await this.http.getData(Utils.fillTemplate(CONFIG.API.UNIVERSE, { universeId }));
					const list = Array.isArray(raw) ? raw : Utils.pick(raw, ['data', 'games']);
					const game = Array.isArray(list) ? list[0] : null;

					return (game && Utils.pick(game, ['rootPlaceId', 'placeId'])) || null;
				} catch (error) {
					console.warn('[ServerScout] universe lookup failed:', error);
					return null;
				}
			}

			// One entry of the games box to a place id: a pasted game link or a
			// number is used as it is, anything else is looked up by name. Returns
			// null when no game matches.
			async resolvePlace(entry) {
				const value = String(entry || '').trim();
				if (!value) return null;

				const link = value.match(/roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?games\/(\d+)/i);
				if (link) return link[1];

				if (/^\d{1,20}$/.test(value)) return value;

				const raw = await this.http.getData(Utils.fillTemplate(CONFIG.API.GAME_SEARCH, {
					query: value,
					// Any string is accepted; the website sends a analytics session id.
					session: Math.random().toString(36).slice(2)
				}));

				const groups = Utils.pick(raw, ['searchResults']);
				for (const group of (Array.isArray(groups) ? groups : [])) {
					const contents = group && Array.isArray(group.contents) ? group.contents : [];

					for (const item of contents) {
						const place = Utils.pick(item, ['rootPlaceId', 'placeId']);
						if (place) return String(place);
					}
				}

				return null;
			}

			// Accepts a username or a numeric user id. Returns null only when
			// Roblox says there is no such user; network failures are thrown.
			async lookupUser(value) {
				if (Utils.isUserId(value)) {
					try {
						const raw = await this.http.getData(Utils.fillTemplate(CONFIG.API.USER_BY_ID, { userId: value }));
						return RobloxApi.normalizeUser(raw);
					} catch (error) {
						if (error.status === 400 || error.status === 404) return null;
						throw error;
					}
				}

				const raw = await this.http.postData(
					CONFIG.API.USERNAMES,
					JSON.stringify({ usernames: [value], excludeBannedUsers: true })
				);

				const list = Array.isArray(raw) ? raw : Utils.pick(raw, ['data', 'users']);
				return Array.isArray(list) ? RobloxApi.normalizeUser(list[0]) : null;
			}

			async fetchThumbnailBatch(requests, options = {}) {
				const raw = await this.http.postData(CONFIG.API.THUMBNAIL_BATCH, JSON.stringify(requests), options);
				return RobloxApi.normalizeThumbnails(raw);
			}

			async fetchAvatarHeadshot(userId) {
				const raw = await this.http.getData(Utils.fillTemplate(CONFIG.API.AVATAR_HEADSHOT, { userId }));
				return RobloxApi.normalizeThumbnails(raw);
			}
		}

		class LanguageManager {
			constructor() {
				this.translations = createLanguageMap();
				this.currentLocale = 'en_us';
				this.initialized = false;
			}

			// start.js already asked for the locale and parked the promise on the
			// shared isolated-world global, so reuse it rather than repeating the
			// request on every page.
			async initialize() {
				if (this.initialized) return;
				this.initialized = true;

				try {
					if (window.__ssLocalePromise) {
						this.currentLocale = await window.__ssLocalePromise;
						return;
					}

					const response = await fetch(
						'https://locale.roblox.com/v1/locales/user-localization-locus-supported-locales',
						{ credentials: 'include', redirect: 'manual' }
					);
					const data = response.ok ? await response.json() : null;
					const locale = data && data.generalExperience && data.generalExperience.locale;
					this.currentLocale = String(locale || 'en_us').toLowerCase();
				} catch {
					this.currentLocale = 'en_us';
				}
			}

			// A language that lacks a newer string falls back to English for that one
			// string, instead of the panel showing "undefined".
			getText(key) {
				const translation = this.translations.get(this.currentLocale);
				if (translation && translation[key]) return translation[key];

				return this.translations.get('en_us')[key] || '';
			}
		}

		// Synthesises a short chime through the Web Audio API instead of shipping an
		// audio file, so the volume stays under our control and the extension needs
		// no media asset at all.
		class AudioManager {
			constructor() {
				this.context = null;

				// There is no mute toggle any more. A "muted" choice saved by an older
				// version could never be undone again, so it is removed.
				try {
					localStorage.removeItem(CONFIG.SOUND.LEGACY_STORAGE_KEY);
				} catch (error) {
					// Storage can be blocked - then nothing was stored either.
				}
			}

			// Called from the submit handler so the AudioContext is created inside a
			// user gesture, which is what browsers require.
			async initialize() {
				try {
					const AudioContextClass = window.AudioContext || window.webkitAudioContext;
					if (!AudioContextClass) return;

					if (!this.context) this.context = new AudioContextClass();
					if (this.context.state === 'suspended') await this.context.resume();
				} catch (error) {
					this.context = null;
				}
			}

			// Two soft sine notes, roughly a major third apart, ~0.35s in total.
			playSuccess() {
				if (!this.context) return;

				try {
					const ctx = this.context;
					const now = ctx.currentTime;

					const master = ctx.createGain();
					master.gain.value = CONFIG.SOUND.VOLUME;
					master.connect(ctx.destination);

					[[880, 0], [1318.5, 0.09]].forEach(([frequency, offset]) => {
						const oscillator = ctx.createOscillator();
						const envelope = ctx.createGain();

						oscillator.type = 'sine';
						oscillator.frequency.value = frequency;

						const startAt = now + offset;
						envelope.gain.setValueAtTime(0.0001, startAt);
						envelope.gain.exponentialRampToValueAtTime(1, startAt + 0.015);
						envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.28);

						oscillator.connect(envelope);
						envelope.connect(master);
						oscillator.start(startAt);
						oscillator.stop(startAt + 0.3);
					});
				} catch (error) {
					// A decorative sound must never break the search.
				}
			}
		}

		// The panel's appearance is entirely CSS-driven. This class only records
		// which state is active; colours, icon swaps and dark mode are handled by
		// stylesheet rules, so none of it has to be recomputed in JavaScript.
		class UIStateManager {
			constructor() {
				this.elements = {};
			}

			getElements() {
				const elementIds = ['ss-panel', 'ss-form', 'ss-input', 'ss-search', 'ss-status'];

				elementIds.forEach(id => {
					this.elements[id] = document.getElementById(id);
				});

				// Optional: the games box only exists on the movable panel.
				this.elements['ss-games'] = document.getElementById('ss-games');

				return elementIds.every(id => this.elements[id] !== null);
			}

			get panel() {
				return this.elements['ss-panel'];
			}

			setState(state) {
				const panel = this.panel;
				if (!panel) return;

				['is-idle', 'is-searching', 'is-found', 'is-notfound', 'is-error']
					.forEach(name => panel.classList.remove(name));

				if (state) panel.classList.add(state);
			}

			setInputValidity(state) {
				const panel = this.panel;
				if (!panel) return;

				panel.classList.remove('has-valid', 'has-invalid');
				if (state) panel.classList.add(state);
			}

			setStatus(text) {
				if (this.elements['ss-status']) {
					this.elements['ss-status'].textContent = text;
				}
			}

			// Read-only rather than disabled: a disabled input loses focus, which
			// silently broke Escape-to-cancel while a search was running.
			setBusy(busy) {
				const input = this.elements['ss-input'];
				if (!input) return;

				input.disabled = false;
				input.readOnly = Boolean(busy);
			}
		}

		class ServerScanner {
			constructor(api) {
				this.api = api;
				this.playerTokens = [];
				this.thumbnailStorage = new Map();
				this.isComplete = false;
				this.totalPlayers = 0;
				this.processedPlayers = 0;
				this.shouldContinue = true;
				this.shouldStop = false;
				this.rateLimitUntil = 0;
				this.requestCounter = 0;
				this.concurrencyLimit = CONFIG.SEARCH.START_CONCURRENCY;
				this.inFlight = 0;
				this.consecutiveSuccesses = 0;
				this.scanIncomplete = false;
				this.loggedSample = false;
				this.seenTokens = new Set();
				this.serverInfo = new Map();
				this.expectedPlayers = 0;
				this.passesRun = 0;
				// Replaced by the engine so the panel can report live scan progress.
				this.onPass = () => {};
			}

			reset() {
				this.playerTokens = [];
				this.thumbnailStorage.clear();
				this.isComplete = false;
				this.totalPlayers = 0;
				this.processedPlayers = 0;
				this.shouldContinue = true;
				this.shouldStop = false;
				this.rateLimitUntil = 0;
				this.requestCounter = 0;
				this.concurrencyLimit = CONFIG.SEARCH.START_CONCURRENCY;
				this.inFlight = 0;
				this.consecutiveSuccesses = 0;
				this.scanIncomplete = false;
				this.loggedSample = false;
				this.seenTokens = new Set();
				this.serverInfo.clear();
				this.expectedPlayers = 0;
				this.passesRun = 0;
			}

			// Share of the player count Roblox itself reports that we have actually
			// seen a token for. This is the honest measure of how complete a sweep
			// is - the queued-token count alone always looks finished.
			get coverage() {
				if (this.expectedPlayers <= 0) return 0;
				return Math.min(1, this.seenTokens.size / this.expectedPlayers);
			}

			get isRunning() {
				return this.shouldContinue && !this.shouldStop;
			}

			// Producer: pages through every public server and feeds playerTokens.
			// Runs concurrently with the matching workers, so tokens from page 1 are
			// already being checked while page 2 is still in flight.
			async scanGameServers(gameId) {
				try {
					for (let pass = 1; pass <= CONFIG.SCAN.MAX_PASSES && this.isRunning; pass++) {
						const before = this.seenTokens.size;

						await this.scanOnePass(gameId);
						this.passesRun = pass;

						const gained = this.seenTokens.size - before;

						console.log(
							`[ServerScout] pass ${pass}: +${gained} new players, ` +
							`${this.seenTokens.size}/${this.expectedPlayers} known ` +
							`(${Math.round(this.coverage * 100)}% coverage)`
						);

						this.onPass({
							pass,
							gained,
							seen: this.seenTokens.size,
							expected: this.expectedPlayers,
							servers: this.serverInfo.size,
							coverage: this.coverage
						});

						if (!this.isRunning) break;

						// Enough of the game has been seen.
						if (this.coverage >= CONFIG.SCAN.COVERAGE_TARGET) break;

						// The sample is exhausted - further passes would only re-fetch
						// players that are already queued.
						if (gained < CONFIG.SCAN.MIN_NEW_TOKENS_PER_PASS) break;
					}
				} finally {
					// Signals the workers that no more tokens are coming, however the
					// loop ended (finished, aborted, or errored out).
					this.isComplete = true;
				}
			}

			// One full walk over the paginated server list.
			async scanOnePass(gameId) {
				const MAX_ERROR_RETRIES = 5;

				let cursor = '';
				let errorRetries = 0;

				while (this.isRunning) {
					let page;

					try {
						page = await this.api.fetchServerPage(gameId, cursor);
						errorRetries = 0;
					} catch (error) {
						console.warn('[ServerScout] server list page failed:', error);
						if (++errorRetries > MAX_ERROR_RETRIES) {
							// Bailing out here means whole pages of servers were never
							// looked at. Remember it, so a later "not found" is not
							// reported as if the game had been swept completely.
							this.scanIncomplete = true;
							return;
						}
						await Utils.delay(1);
						continue;
					}

					page.servers.forEach(server => this.ingestServer(server));

					// A page without a cursor is the end of the list - including an
					// empty first page. The old loop treated an empty page as a hiccup
					// and waited 30 seconds before accepting a game had no servers.
					if (!page.nextCursor) return;
					cursor = page.nextCursor;
				}
			}

			// Takes a server already normalised by RobloxApi.
			ingestServer(server) {
				if (!server || !server.id) return;

				// Server stats are stable between passes, so record them once. They
				// also give the result row its player count and ping without costing
				// an extra request.
				if (!this.serverInfo.has(server.id)) {
					this.serverInfo.set(server.id, {
						id: server.id,
						playing: server.playing,
						maxPlayers: server.maxPlayers,
						ping: server.ping,
						fps: server.fps
					});

					this.expectedPlayers += server.playing;
				}

				server.tokens.forEach(token => {
					// The same player reappears in later samples; queue each exactly
					// once. This dedup is what makes multi-pass scanning affordable.
					if (this.seenTokens.has(token)) return;
					this.seenTokens.add(token);

					this.totalPlayers++;
					this.playerTokens.push({
						token,
						type: 'AvatarHeadshot',
						size: '150x150',
						// Must match the parameters used to fetch the target's
						// own avatar, or the two URLs can never compare equal.
						format: 'Png',
						isCircular: false,
						// requestId has to be unique per entry. The old code
						// put the same server id on every player of a server,
						// so the API could collapse 20 players into a single
						// result - the other 19 were never actually checked.
						requestId: `${server.id}|${this.requestCounter++}`
					});
				});
			}

			// Consumer: several workers pull batches off the shared queue at once.
			// This is where nearly all the time goes - one batch is one network
			// round trip, and a busy game needs thousands of them. Array.splice is
			// atomic here (no await inside it), so no worker can take another's
			// batch.
			async findTargetInServers(targetImageUrl) {
				const workers = [];
				const targetIdentity = Utils.thumbnailIdentity(targetImageUrl);

				this.loggedSample = false;
				console.log('[ServerScout] target avatar:', targetImageUrl, '| identity:', targetIdentity);

				// Spawn the ceiling; how many actually hold a request slot at any
				// moment is governed by the adaptive concurrencyLimit.
				for (let i = 0; i < CONFIG.SEARCH.MAX_CONCURRENCY; i++) {
					workers.push(this.runMatchWorker(targetIdentity));
				}

				const results = await Promise.all(workers);
				return [...new Set(results.flat())];
			}

			// A batch that could not be checked is put back in the queue rather than
			// thrown away - the target could have been in it, and silently dropping
			// it would report "not found" for a player who is right there.
			requeueFailedBatch(batch) {
				const retryable = [];

				batch.forEach(item => {
					item.tries = (item.tries || 0) + 1;
					if (item.tries < CONFIG.SEARCH.MAX_BATCH_RETRIES) retryable.push(item);
				});

				const abandoned = batch.length - retryable.length;
				if (abandoned > 0) this.processedPlayers += abandoned;
				if (retryable.length > 0) this.playerTokens.push(...retryable);

				this.updateProgress();
			}

			async waitForRateLimit() {
				const remaining = this.rateLimitUntil - Date.now();
				if (remaining > 0) await Utils.delay(remaining / 1000);
			}

			async acquireSlot() {
				while (this.isRunning && this.inFlight >= this.concurrencyLimit) {
					await Utils.delay(CONFIG.SEARCH.IDLE_POLL_SECONDS);
				}
				this.inFlight++;
			}

			releaseSlot() {
				this.inFlight = Math.max(0, this.inFlight - 1);
			}

			// Additive increase: a run of clean batches widens the pipe by one.
			noteSuccess() {
				this.consecutiveSuccesses++;
				if (this.consecutiveSuccesses < CONFIG.SEARCH.SUCCESSES_BEFORE_RAMP) return;

				this.consecutiveSuccesses = 0;
				this.concurrencyLimit = Math.min(CONFIG.SEARCH.MAX_CONCURRENCY, this.concurrencyLimit + 1);
			}

			// Multiplicative decrease: a rate-limit halves it immediately.
			noteRateLimit() {
				this.consecutiveSuccesses = 0;
				this.concurrencyLimit = Math.max(
					CONFIG.SEARCH.MIN_CONCURRENCY,
					Math.floor(this.concurrencyLimit / 2)
				);
				this.rateLimitUntil = Date.now() + CONFIG.SEARCH.RATE_LIMIT_COOLDOWN_MS;
			}

			async fetchBatchThumbnails(payload) {
				await this.waitForRateLimit();
				await this.acquireSlot();

				try {
					// Player tokens only exist for a signed-in viewer, so they are
					// resolved the same way they were obtained.
					return await this.api.fetchThumbnailBatch(payload, { session: true });
				} finally {
					this.releaseSlot();
				}
			}

			async runMatchWorker(targetIdentity) {
				const foundServers = [];

				while (this.isRunning) {
					const batch = this.playerTokens.splice(0, CONFIG.SEARCH.BATCH_SIZE);

					if (batch.length === 0) {
						// Nothing queued: either the producer is still fetching a page,
						// or it finished and this worker is done.
						if (this.isComplete) break;
						await Utils.delay(CONFIG.SEARCH.IDLE_POLL_SECONDS);
						continue;
					}

					let thumbnails;

					try {
						// Only the fields the endpoint expects - `tries` is bookkeeping
						// of ours and must not end up in the request body.
						const payload = batch.map(({ token, type, size, format, isCircular, requestId }) => ({
							token,
							type,
							size,
							format,
							isCircular,
							requestId
						}));

						thumbnails = await this.fetchBatchThumbnails(payload);
						this.noteSuccess();
					} catch (error) {
						console.warn('[ServerScout] thumbnail batch failed, retrying it:', error);

						if (error && error.status === 429) this.noteRateLimit();

						this.requeueFailedBatch(batch);
						await Utils.delay(0.5);
						continue;
					}

					if (!this.isRunning) break;

					if (!Array.isArray(thumbnails)) {
						this.requeueFailedBatch(batch);
						await Utils.delay(0.25);
						continue;
					}

					// One sample per search, so a mismatch between the two sides is
					// visible in the console instead of silently reading as "not found".
					if (!this.loggedSample && thumbnails.length > 0) {
						this.loggedSample = true;
						console.log(
							'[ServerScout] sample player avatar:', thumbnails[0].imageUrl,
							'| identity:', Utils.thumbnailIdentity(thumbnails[0].imageUrl),
							'| state:', thumbnails[0].state
						);
					}

					thumbnails.forEach(thumb => {
						// requestId is "<serverId>|<n>" - strip the unique suffix back
						// off to learn which server this player was in.
						const serverId = String(thumb.requestId).split('|')[0];

						// Counted either way: skipping it silently would leave the
						// progress total unreachable and the workers spinning.
						this.processedPlayers++;

						// Placeholder images are shared by every not-yet-rendered
						// avatar, so they must never take part in the comparison.
						if (!Utils.isUsableThumbnail(thumb)) return;

						let serverThumbs = this.thumbnailStorage.get(serverId);
						if (!serverThumbs) {
							serverThumbs = [];
							this.thumbnailStorage.set(serverId, serverThumbs);
						}

						if (!serverThumbs.includes(thumb.imageUrl)) {
							serverThumbs.push(thumb.imageUrl);
						}

						// Compared by content identity, not by raw URL: see
						// Utils.thumbnailIdentity for why the host cannot be trusted.
						if (Utils.thumbnailIdentity(thumb.imageUrl) === targetIdentity) {
							foundServers.push(serverId);
							// Stops every worker and the producer's pagination too.
							this.shouldContinue = false;
						}
					});

					// The API can return fewer entries than requested; make up the
					// difference so the progress total stays reachable.
					if (thumbnails.length < batch.length) {
						this.processedPlayers += batch.length - thumbnails.length;
					}

					// Once per batch rather than once per player - the old code wrote
					// to the DOM 100 times for every request.
					this.updateProgress();
				}

				return foundServers;
			}

			updateProgress() {
			}
		}

		class ServerScoutEngine {
			constructor() {
				this.httpClient = new HTTPClient();
				this.languageManager = new LanguageManager();
				this.audioManager = new AudioManager();
				this.uiManager = new UIStateManager();
				this.api = new RobloxApi(this.httpClient);
				this.scanner = this.createScanner();
				
				this.isSearching = false;
				this.isAutoMode = false;
				this.attemptCount = 0;
				this.discoveredServers = [];
				this.highlightedElements = [];
				this.serverContainer = null;
				this.repeatTimer = null;
				this.cachedTarget = null;

				this.refreshTimer = null;
				this.tokenProbe = null;
				this.attemptInFlight = false;
				this.probeInFlight = false;

				// Incremented by every start and every cancel; see isStale.
				this.runId = 0;
				// What was submitted, so repeat attempts do not depend on the box.
				this.activeQuery = '';
				this.originalTitle = null;
			}

			// Hooks only paint for the scanner that is current, so one left over from
			// a cancelled attempt cannot write into the panel.
			createScanner() {
				const scanner = new ServerScanner(this.api);

				scanner.updateProgress = () => {
					if (scanner === this.scanner) this.updateSearchProgress();
				};

				scanner.onPass = progress => {
					if (scanner === this.scanner) this.renderScanProgress(progress);
				};

				return scanner;
			}

			async initialize(attempt = 0) {
				const MAX_INIT_ATTEMPTS = 15;

				await this.languageManager.initialize();

				if (!this.uiManager.getElements()) {
					if (attempt >= MAX_INIT_ATTEMPTS) {
						console.error("[ServerScout] panel elements not found - giving up.");
						return;
					}
					setTimeout(() => this.initialize(attempt + 1), 1000);
					return;
				}

				this.currentPlaceId = this.extractGameId();
				this.setupUI();
				this.setupEventListeners();
				this.setupDrag();
				console.log("[ServerScout] ready");

				// Deliberately not awaited: the panel must stay responsive while the
				// probe runs, and its result only feeds an informational row.
				this.showTokenDiagnostic();
				this.startTokenRefresh();
			}

			setupUI() {
				this.uiManager.setState('is-idle');
				this.uiManager.setStatus('');

				const gamesInput = document.getElementById('ss-games');
				if (gamesInput) gamesInput.placeholder = this.languageManager.getText('gamesPlaceholder');

				const repeatLabel = document.getElementById('ss-repeat-label');
				if (repeatLabel) repeatLabel.textContent = this.languageManager.getText('repeatUntilFound');

				const joinButton = document.getElementById('ss-join');
				if (joinButton) {
					const joinLabel = this.languageManager.getText('joinPlayer');
					joinButton.title = `${joinLabel} - joins whichever game they are in`;
					joinButton.setAttribute('aria-label', joinLabel);
				}

				Utils.setText('ss-attempts', `${this.languageManager.getText('attemptCounter')} 0`);

				this.forgetLegacyQuery();
				this.clearQueryInput();
			}

			// Older versions stored the last searched name in the page's storage and
			// filled it back in on every visit. Remove whatever they left behind.
			forgetLegacyQuery() {
				try {
					localStorage.removeItem(CONFIG.STORAGE.LEGACY_LAST_QUERY_KEY);
				} catch (error) {
					// Storage can be blocked - then nothing was stored either.
				}
			}

			// Single place that derives the input's look from its value, used by
			// typing, clearing and the end of a search alike.
			syncInputState() {
				const elements = this.uiManager.elements;
				const input = elements['ss-input'];
				if (!input) return;

				const value = input.value.trim();
				const isValid = Utils.isValidQuery(value);

				if (!value) {
					this.uiManager.setInputValidity(null);
				} else {
					this.uiManager.setInputValidity(isValid ? 'has-valid' : 'has-invalid');
				}

				// The server search exists on the game-page panel only; the floating
				// panel on other Roblox pages is join-only.
				if (elements['ss-search']) {
					elements['ss-search'].disabled = !isValid && !this.isSearching;
				}

				// While a search runs, the repeat toggle's visibility belongs to the
				// search, so the loop can always be switched off again. It belongs to
				// the game-page panel, which is where searching is possible at all.
				if (!this.isSearching) {
					const canRepeat = isValid && Boolean(this.extractGameId());
					Utils.setDisplay('ss-repeat-wrapper', canRepeat ? 'flex' : 'none');
				}

				// The join button needs a valid name too, and must not fire while the
				// search owns the panel.
				const joinButton = document.getElementById('ss-join');
				if (joinButton) joinButton.disabled = !isValid || this.isJoining || this.isSearching;

				const clearButton = document.getElementById('ss-clear');
				if (clearButton) clearButton.hidden = !value;
			}

			clearQueryInput() {
				const input = this.uiManager.elements['ss-input'];
				if (!input) return;

				input.value = '';
				this.syncInputState();
			}

			setupEventListeners() {
				const elements = this.uiManager.elements;

				elements['ss-input'].addEventListener('input', () => this.syncInputState());

				// Escape stops a running search; with nothing running it empties the
				// box. Listened for on the whole panel, because focus is not always
				// in the input (the stop button, a result row).
				this.uiManager.panel.addEventListener('keydown', (event) => {
					if (event.key !== 'Escape') return;

					if (this.isSearching) {
						event.preventDefault();
						this.cancelSearch();
						return;
					}

					// A games-box join can sweep several games, so it needs the same
					// escape hatch as a search.
					if (this.isJoining) {
						event.preventDefault();
						this.gamesJoinCancelled = true;
						if (this.scanner) this.scanner.shouldStop = true;
						this.uiManager.setState('is-idle');
						this.uiManager.setStatus('');
						return;
					}

					if (elements['ss-input'].value) {
						event.preventDefault();
						this.clearQueryInput();
						elements['ss-input'].focus();
					}
				});

				const clearButton = document.getElementById('ss-clear');
				if (clearButton) {
					clearButton.addEventListener('click', () => {
						if (this.isSearching) return;

						this.clearQueryInput();
						elements['ss-input'].focus();
					});
				}

				// The panel lives in a <form>: without this, pressing Enter submitted
				// it and navigated the page away, taking the panel with it.
				elements['ss-form'].addEventListener('submit', async (event) => {
					event.preventDefault();

					await this.audioManager.initialize();

					if (this.isSearching) {
						this.cancelSearch();
						return;
					}

					if (!Utils.isValidQuery(elements['ss-input'].value)) return;

					// Without a game page there is no "this game" to scan, which is what
					// used to end in an error. The name alone is enough to join the
					// player, so Enter does that here instead.
					if (!this.extractGameId()) {
						this.joinPlayer();
						return;
					}

					this.startSearch();
				});

				const repeatCheckbox = document.getElementById('ss-repeat-checkbox');
				if (repeatCheckbox) {
					repeatCheckbox.addEventListener('change', () => {
						if (repeatCheckbox.checked) return;

						Utils.setDisplay('ss-attempts', 'none');

						// Unticking it mid-loop now actually stops the loop.
						if (this.isAutoMode) this.stopRepeating();
					});
				}

				// Type button, not submit: joining must never count as a search.
				const joinButton = document.getElementById('ss-join');
				if (joinButton) {
					joinButton.addEventListener('click', () => this.joinPlayer());
				}
			}

			// The floating panel can be picked up anywhere that is not a control: the
			// grip at the top, the space around the status line, the padding at the
			// edge. It then follows the pointer across the whole screen. A moved panel
			// is detached from Roblox's layout and pinned (the ss-pinned class), which
			// is also what tells start.js to stop placing it back in the corner.
			//
			// Only the floating panel moves. The box under a game's Play button keeps
			// the original, fixed shape it always had, so a press there is left to the
			// page and the grip is hidden by the stylesheet.
			setupDrag() {
				const panel = this.uiManager.panel;
				if (!panel || this.dragReady) return;

				this.dragReady = true;

				const isMovable = () => panel.classList.contains('ss-away');

				let offsetX = 0;
				let offsetY = 0;
				let startX = 0;
				let startY = 0;
				let pressed = false;
				let dragging = false;

				const DRAG_THRESHOLD_PX = 4;
				const clamp = (value, max) => Math.min(Math.max(0, value), Math.max(0, max));

				// Buttons, the input and result links keep their normal behaviour; a
				// press anywhere else on the panel moves it.
				const isControl = target => Boolean(
					target && target.closest &&
					target.closest('input, button, a, select, textarea, label, [contenteditable], .ss-chip')
				);

				const moveTo = event => {
					const width = panel.offsetWidth || 0;
					const height = panel.offsetHeight || 0;

					panel.style.left = `${clamp(event.clientX - offsetX, window.innerWidth - width)}px`;
					panel.style.top = `${clamp(event.clientY - offsetY, window.innerHeight - height)}px`;
				};

				// Called on the first movement, not on the press, so a plain click on
				// the panel does not pin it or detach it from Roblox's layout.
				const begin = event => {
					const rect = panel.getBoundingClientRect();
					offsetX = startX - rect.left;
					offsetY = startY - rect.top;

					panel.classList.add('ss-pinned', 'is-dragging');
					panel.classList.remove('ss-floating');
					if (panel.parentNode !== document.body) document.body.appendChild(panel);

					panel.style.left = `${rect.left}px`;
					panel.style.top = `${rect.top}px`;
					panel.style.width = `${rect.width}px`;

					dragging = true;
					try { panel.setPointerCapture(event.pointerId); } catch (error) {}
				};

				panel.addEventListener('pointerdown', event => {
					if (event.button !== 0 || isControl(event.target) || !isMovable()) return;

					pressed = true;
					dragging = false;
					startX = event.clientX;
					startY = event.clientY;

					// Stops the press from selecting Roblox's text underneath.
					event.preventDefault();
				});

				panel.addEventListener('pointermove', event => {
					if (!pressed) return;

					if (!dragging) {
						const movedEnough = Math.abs(event.clientX - startX) >= DRAG_THRESHOLD_PX ||
							Math.abs(event.clientY - startY) >= DRAG_THRESHOLD_PX;
						if (!movedEnough) return;

						begin(event);
					}

					moveTo(event);
				});

				const stop = event => {
					pressed = false;
					if (!dragging) return;

					dragging = false;
					panel.classList.remove('is-dragging');
					try { panel.releasePointerCapture(event.pointerId); } catch (error) {}
				};

				panel.addEventListener('pointerup', stop);
				panel.addEventListener('pointercancel', stop);
			}

			// Joins the game - and, when Roblox shares it, the exact server - that the
			// typed player is in. The game of the page the panel sits on is never
			// consulted, so the game does not have to be known beforehand: presence
			// names both the place and the server.
			async joinPlayer() {
				if (this.isJoining || this.isSearching) return;

				const input = this.uiManager.elements['ss-input'];
				const query = Utils.normalizeQuery(input ? input.value : '');
				if (!Utils.isValidQuery(query)) return;

				this.isJoining = true;
				this.syncInputState();
				this.uiManager.setStatus(this.languageManager.getText('joinLocating'));

				try {
					const target = await this.resolveTarget(query);

					if (!target) {
						this.uiManager.setState('is-error');
						this.uiManager.setStatus(this.languageManager.getText('userNotValid'));
						return;
					}

					this.uiManager.setStatus(`${this.languageManager.getText('joinLocating')} ${target.label}`);

					// A games list turns the join into a targeted search: each listed game
					// is checked in turn and the first server that has them wins. Without
					// a list the join stays presence-only, as before.
					const games = this.readGamesList();
					if (games.length > 0) {
						await this.joinFromGames(target, games);
						return;
					}

					const presence = await this.api.fetchPresence(target.userId);

					// The place can arrive under several names, and a presence that only
					// names the universe is resolved to that universe's root place.
					let presencePlaceId = presence && (presence.placeId || presence.rootPlaceId);
					if (!presencePlaceId && presence && presence.universeId) {
						presencePlaceId = await this.api.fetchUniversePlace(presence.universeId);
					}

					// 2 means "in a game"; 1 (on the website) and 3 (in Studio) are
					// definite "not in a game" answers. Anything else - including 0,
					// which Roblox also reports for a hidden presence - is the case
					// where Roblox simply will not say.
					const placeId = presencePlaceId;
					if (!presence || presence.type !== 2 || !placeId) {
						console.log('[ServerScout] join presence:', presence);

						const inNoGame = Boolean(presence) && (presence.type === 1 || presence.type === 3);

						// Roblox will not name their game - usually because of the player's
						// "show current experience" setting. On a game page the public
						// server list can still answer: the sweep matches their avatar,
						// and joining that server id works even when their joins are off.
						if (!inNoGame && this.extractGameId()) {
							await this.startSearch();
							return;
						}

						const text = this.languageManager.getText(inNoGame ? 'joinNotInGame' : 'joinPrivate');
						this.uiManager.setState('is-notfound');
						this.uiManager.setStatus(`${text}: ${target.label}`);
						return;
					}

					// A hidden server id (privacy setting) still allows joining the game
					// itself; Roblox then picks one of its public servers.
					this.uiManager.setState('is-found');
					this.uiManager.setStatus('');
					await this.sendJoinRequest(String(placeId), presence.jobId ? String(presence.jobId) : '');

					// Roblox can take a moment to start; say so rather than leaving a
					// blank status line behind a button that looks like it did nothing.
					this.flashStatus(this.languageManager.getText('joinOpening'), 8000);
				} catch (error) {
					(error && error.authRequired ? console.warn : console.error)('[ServerScout] join by username failed:', error);
					this.uiManager.setState('is-error');
					this.uiManager.setStatus(this.languageManager.getText(
						error && error.authRequired ? 'joinSignIn' : 'joinFailed'
					));
				} finally {
					this.isJoining = false;
					this.syncInputState();
				}
			}

			async startSearch() {
				const input = this.uiManager.elements['ss-input'];

				this.runId++;
				this.isSearching = true;
				this.isAutoMode = false;
				this.attemptCount = 0;
				this.activeQuery = Utils.normalizeQuery(input ? input.value : '');

				Utils.setText('ss-attempts', `${this.languageManager.getText('attemptCounter')} 0`);

				// Immediate feedback: the user lookup comes first and used to leave the
				// panel looking idle until it had finished.
				this.uiManager.setState('is-searching');
				this.uiManager.setStatus(this.languageManager.getText('activeSearch'));
				this.uiManager.setBusy(true);
				this.syncInputState();

				await this.executeSearch();
			}

			// Every search run gets a number. Anything an abandoned run still has in
			// flight compares its number with the current one and drops its result,
			// instead of painting over a newer search or the idle panel.
			isStale(run) {
				return run !== this.runId;
			}

			searchingText(repeating = this.isAutoMode) {
				const text = this.languageManager.getText('activeSearch');
				return repeating ? `${text} ${this.languageManager.getText('repeatIndicator')}` : text;
			}

			cancelSearch() {
				this.runId++;
				this.scanner.shouldStop = true;
				this.clearRepeatTimer();

				// Cleared here and now. A cancel during the pause between two repeat
				// attempts used to leave isSearching set, which locked the panel: the
				// button could only ever "cancel" again and no new search started.
				this.isAutoMode = false;
				this.isSearching = false;
				this.attemptInFlight = false;

				this.uiManager.setState('is-idle');
				this.uiManager.setBusy(false);
				this.uiManager.setStatus(this.languageManager.getText('searchAborted'));
				this.resetProgressCount();

				Utils.setDisplay('ss-attempts', 'none');
				this.syncInputState();
				this.showTokenDiagnostic();
			}

			async executeSearch() {
				const run = this.runId;

				try {
					const gameId = this.extractGameId();

					// Bailing out here used to leave isSearching set, so the panel sat
					// on "searching" forever and the button silently became a cancel
					// button with nothing to cancel.
					if (!gameId) {
						console.warn('[ServerScout] no place id in the URL - not a game page.');
						this.failSearch(this.languageManager.getText('systemError'), true);
						return;
					}

					const target = await this.resolveTarget(this.activeQuery);
					if (this.isStale(run)) return;

					if (!target) {
						this.showUserError();
						return;
					}

					this.clearPreviousResults();
					await this.performTargetSearch(target, gameId, run);
				} catch (error) {
					if (this.isStale(run)) return;

					// Being signed out is not a fault of the extension; logging it as an
					// error put a scary entry into the browser's extension error list.
					(error && error.authRequired ? console.warn : console.error)('[ServerScout] search failed:', error);
					this.handleSearchError(error);
				}
			}

			// Repeat mode re-runs this for every attempt. Resolving the same name to
			// the same id and avatar each time cost two extra requests per pass.
			// The avatar is deliberately NOT fetched here. The presence lookup does
			// not need it, and an avatar that is still rendering used to abort the
			// whole search before that faster path ever got a chance to run.
			async resolveTarget(input) {
				const value = Utils.normalizeQuery(input);
				const key = value.toLowerCase();

				if (this.cachedTarget && this.cachedTarget.key === key) {
					return this.cachedTarget;
				}

				const user = await this.validateUser(value);
				if (!user) return null;

				// The real name from Roblox, not whatever was typed - an id, a
				// lower-cased name or a profile link reads badly in the result row.
				const name = user.name || value;
				const label = user.displayName && user.displayName !== name
					? `${user.displayName} (@${name})`
					: name;

				this.cachedTarget = { key, userId: user.id, thumbnailUrl: null, label };
				return this.cachedTarget;
			}

			// Roblox knows exactly which server instance a user is in and will tell
			// you - presence returns the jobId directly. That is one request instead
			// of the thousands the avatar sweep needs, and it is exact rather than
			// inferred from image comparison.
			//
			// It only answers for users whose activity you are allowed to see
			// (friends, or anyone who has not restricted it), which is why the sweep
			// stays as a fallback.
			// Returns one of three answers, because "no jobId" and "definitely not
			// here" are very different things:
			//   found     - the jobId, use it directly
			//   elsewhere - Roblox says they are not in this game; a sweep cannot
			//               find them either, so it is skipped entirely
			//   unknown   - presence could not or would not say; fall back to the sweep
			async findViaPresence(userId, placeId) {
				const UNKNOWN = { status: 'unknown', jobId: null };
				const ELSEWHERE = { status: 'elsewhere', jobId: null };

				try {
					const presence = await this.api.fetchPresence(userId);
					if (!presence) return UNKNOWN;

					console.log('[ServerScout] presence:', { ...presence, thisPlace: placeId });

					// 0 offline, 1 on the website, 2 in a game, 3 in Studio.
					// 1 and 3 are visible states that rule out being in a game at all.
					// 0 is NOT conclusive - a hidden presence also reports as offline -
					// so that case still earns a sweep. An unrecognised type (null)
					// is treated the same way.
					if (presence.type === 1 || presence.type === 3) {
						console.log('[ServerScout] user is not in any game - skipping the sweep.');
						return ELSEWHERE;
					}

					if (presence.type !== 2) return UNKNOWN;

					const samePlace = String(presence.placeId) === String(placeId) ||
						String(presence.rootPlaceId) === String(placeId);

					if (!samePlace) {
						// Only conclusive if Roblox actually named the place.
						if (presence.placeId) {
							console.log('[ServerScout] user is in a different game - skipping the sweep.');
							return ELSEWHERE;
						}
						return UNKNOWN;
					}

					if (!presence.jobId) {
						console.log('[ServerScout] presence hides the server id (privacy setting) - falling back to the avatar sweep.');
						return UNKNOWN;
					}

					return { status: 'found', jobId: presence.jobId };
				} catch (error) {
					console.warn('[ServerScout] presence lookup failed, falling back to the avatar sweep.', error);
					return UNKNOWN;
				}
			}

			// Asks the servers endpoint for a single page and reports whether it
			// actually carries playerTokens. Roblox has been restricting these, and
			// without them the avatar sweep cannot work at all - so it is worth
			// stating plainly in the UI rather than leaving it to be guessed.
			// `limit=100` is the endpoint's maximum PAGE SIZE, not a total. Reading one
			// page therefore always reported "100 servers" for every game above that
			// size. This walks several pages and reports whether it stopped early.
			async probePlayerTokens(placeId) {
				let cursor = '';
				let servers = 0;
				let tokens = 0;
				let hasMore = false;

				for (let pageIndex = 0; pageIndex < CONFIG.SCAN.PROBE_MAX_PAGES; pageIndex++) {
					let page;

					try {
						page = await this.api.fetchServerPage(placeId, cursor);
					} catch (error) {
						console.warn('[ServerScout] token probe failed:', error);
						// Whatever was already counted is still true; only mark the
						// result unreachable if nothing at all came back.
						return { reachable: servers > 0, servers, tokens, truncated: true };
					}

					servers += page.servers.length;
					tokens += page.servers.reduce((total, server) => total + server.tokens.length, 0);

					hasMore = Boolean(page.nextCursor);
					if (!hasMore) return { reachable: true, servers, tokens, truncated: false };

					cursor = page.nextCursor;
				}

				return { reachable: true, servers, tokens, truncated: hasMore };
			}

			// Presence finds a server without listing any, so its player count and
			// ping are unknown. Walk a bounded number of pages to pick them up;
			// giving up simply means the row shows less, never that it fails.
			async fetchServerInfo(gameId, jobId) {
				let cursor = '';

				for (let pageIndex = 0; pageIndex < CONFIG.SCAN.INFO_LOOKUP_MAX_PAGES; pageIndex++) {
					let page;

					try {
						page = await this.api.fetchServerPage(gameId, cursor);
					} catch (error) {
						console.warn('[ServerScout] server info lookup failed:', error);
						return null;
					}

					const hit = page.servers.find(server => server.id === String(jobId));

					if (hit) {
						return {
							id: hit.id,
							playing: hit.playing,
							maxPlayers: hit.maxPlayers,
							ping: hit.ping,
							fps: hit.fps
						};
					}

					if (!page.nextCursor) {
						console.warn('[ServerScout] server info: reached the end of the list without finding', jobId);
						return null;
					}

					cursor = page.nextCursor;
				}

				console.warn(
					`[ServerScout] server info: gave up after ${CONFIG.SCAN.INFO_LOOKUP_MAX_PAGES} pages; ` +
					'the server sits further back than the lookup budget, so player count and ping stay blank.'
				);
				return null;
			}

			// Single place that paints the readout row, so every caller - the idle
			// refresher and the live scan alike - produces a consistent line.
			renderDiag(state, text, title) {
				const row = document.getElementById('ss-diag');
				const label = document.getElementById('ss-diag-text');
				if (!row || !label) return;

				row.classList.remove('is-ok', 'is-warn', 'is-bad', 'is-busy');
				if (state) row.classList.add(state);

				label.textContent = text;
				row.title = title || '';
				row.hidden = false;
			}

			// Called by the scanner after each pass: the same row that shows the
			// token count while idle becomes the live progress readout while a sweep
			// is running.
			renderScanProgress(progress) {
				const percent = Math.round(progress.coverage * 100);
				const fmt = Utils.compactNumber;

				this.renderDiag(
					'is-busy',
					`Pass ${progress.pass} · ${fmt(progress.seen)}/${fmt(progress.expected)} players · ${percent}%`,
					`Scan pass ${progress.pass}: ${progress.seen.toLocaleString()} of ${progress.expected.toLocaleString()} players seen (${percent}%).\n` +
					'Roblox only returns a random sample of each server\'s players per call, so the scan repeats to collect the ones it has not seen yet.'
				);
			}

			async showTokenDiagnostic() {
				const placeId = this.extractGameId();
				if (!placeId) return;

				// The live scan owns this row while it runs.
				if (this.isSearching) return;

				// The probe now walks several pages, so it can outlive the refresh
				// interval on a slow connection. Without this guard the timer would
				// stack overlapping probes on top of each other.
				if (this.probeInFlight) return;
				this.probeInFlight = true;

				// A refresh keeps the last numbers on screen and only pulses the dot.
				// Swapping the text for "refreshing..." every 30 seconds made the row
				// flicker for no new information.
				const row = document.getElementById('ss-diag');
				if (this.tokenProbe && row && !row.hidden) {
					row.classList.add('is-busy');
				} else {
					this.renderDiag('is-busy', 'Checking servers…', 'Reading the server list.');
				}

				let probe;
				try {
					probe = await this.probePlayerTokens(placeId);
				} finally {
					this.probeInFlight = false;
				}

				this.tokenProbe = probe;
				console.log('[ServerScout] token probe:', probe);

				// A search may have started while the probe was in flight; do not
				// overwrite its progress line.
				if (this.isSearching) return;

				// Short labels only; everything else lives in the tooltip.
				if (!probe.reachable) {
					this.renderDiag('is-bad', 'Servers unavailable',
						'The public servers endpoint could not be read. Only the presence lookup can find anyone.');
				} else if (probe.servers === 0) {
					this.renderDiag('is-warn', 'No public servers',
						'This game reports no public servers, so there is nothing to sweep.');
				} else {
					// "500+" rather than a bare number: the probe reads a bounded
					// number of pages, and pretending that is the total is how the
					// readout looked capped in the first place.
					const serverLabel = `${Utils.compactNumber(probe.servers)}${probe.truncated ? '+' : ''}`;
					const perServer = (probe.tokens / probe.servers).toFixed(1);
					const counts = `${probe.tokens.toLocaleString()} player tokens in ` +
						`${probe.servers.toLocaleString()}${probe.truncated ? '+' : ''} servers (~${perServer} per server).`;

					if (probe.tokens === 0) {
						this.renderDiag('is-warn',
							`0 tokens · ${serverLabel} servers`,
							`${counts}\nRoblox did not share player tokens for these servers, so the avatar sweep cannot work here. Only the presence lookup can find someone.`);
					} else {
						this.renderDiag('is-ok',
							`${Utils.compactNumber(probe.tokens)} tokens · ${serverLabel} servers`,
							`${counts}\n` + (probe.truncated
								? 'Sampled the first servers only; this game has more. Roblox returns only a few players per server per call, so the sweep re-queries to reach the rest.'
								: 'Read every public server. Roblox returns only a few players per server per call, so the sweep re-queries to reach the rest.'));
					}
				}
			}

			// Keeps the readout current instead of freezing on whatever was true
			// when the page loaded. Skipped while the tab is hidden so a backgrounded
			// page does not keep polling Roblox.
			startTokenRefresh() {
				this.stopTokenRefresh();

				this.refreshTimer = setInterval(() => {
					// Roblox can re-render the page out from under the panel for a
					// moment; start.js puts it back. Skipping the tick instead of
					// stopping for good keeps the readout alive once it returns.
					if (!document.getElementById('ss-panel')) return;

					if (document.hidden) return;
					if (this.isSearching) return;
					this.showTokenDiagnostic();
				}, CONFIG.REFRESH.INTERVAL_MS);

				this.placeTimer = setInterval(() => this.checkPlaceChange(), CONFIG.REFRESH.PLACE_CHECK_MS);

				// Catch up immediately when the tab comes back to the foreground.
				this.visibilityHandler = () => {
					if (!document.hidden && !this.isSearching) this.showTokenDiagnostic();
				};
				document.addEventListener('visibilitychange', this.visibilityHandler);
			}

			// Roblox may switch to another game without reloading the page. Results,
			// a running search and the readout all belong to one game, so they are
			// reset as soon as the place id in the address bar changes - otherwise a
			// Join button could send the user into the previous game's server.
			checkPlaceChange() {
				const placeId = this.extractGameId();
				if (placeId === this.currentPlaceId) return;

				console.info('[ServerScout] place changed:', this.currentPlaceId, '->', placeId);
				this.currentPlaceId = placeId;

				if (this.isSearching) this.cancelSearch();

				this.clearPreviousResults();
				this.tokenProbe = null;
				this.uiManager.setState('is-idle');
				this.uiManager.setStatus('');
				Utils.setDisplay('ss-attempts', 'none');

				if (placeId) this.showTokenDiagnostic();
			}

			stopTokenRefresh() {
				if (this.refreshTimer) {
					clearInterval(this.refreshTimer);
					this.refreshTimer = null;
				}

				if (this.placeTimer) {
					clearInterval(this.placeTimer);
					this.placeTimer = null;
				}

				if (this.visibilityHandler) {
					document.removeEventListener('visibilitychange', this.visibilityHandler);
					this.visibilityHandler = null;
				}
			}

			// Accepts a username or a bare numeric user id and resolves it to the
			// Roblox user object ({ id, name, displayName }).
			//
			// Returns null only when Roblox says there is no such user. Network
			// failures are thrown: reporting them as "invalid username" was
			// permanent and ended "repeat until found" over a dropped request.
			async validateUser(input) {
				return this.api.lookupUser(String(input).trim());
			}

			// No trailing slash required: /games/123 is a valid Roblox URL and the
			// old pattern refused to match it.
			extractGameId() {
				const match = window.location.pathname.match(/\/games\/(\d+)/);
				return match ? match[1] : null;
			}

			// Requested through the very same /v1/batch endpoint - and with the same
			// parameters - that the player sweep uses, so both sides of the comparison
			// are produced identically. The dedicated avatar-headshot endpoint stays
			// as a fallback in case batch refuses a targetId lookup.
			async getUserThumbnail(userId) {
				try {
					const entries = await this.api.fetchThumbnailBatch([{
						requestId: `target|${userId}`,
						targetId: Number(userId),
						type: 'AvatarHeadshot',
						size: '150x150',
						format: 'Png',
						isCircular: false
					}]);

					const entry = entries && entries[0];
					if (Utils.isUsableThumbnail(entry)) return entry.imageUrl;

					console.warn(
						'[ServerScout] batch target lookup unusable (state:',
						(entry && entry.state) || 'none', ') - falling back.'
					);
				} catch (error) {
					console.warn('[ServerScout] batch target lookup failed, falling back.', error);
				}

				try {
					const entries = await this.api.fetchAvatarHeadshot(userId);

					const entry = entries && entries[0];
					if (Utils.isUsableThumbnail(entry)) return entry.imageUrl;

					console.warn(
						'[ServerScout] target avatar is not rendered yet (state:',
						(entry && entry.state) || 'none',
						') - it cannot be matched reliably.'
					);
				} catch (error) {
					console.warn('[ServerScout] target avatar lookup failed:', error);
				}

				// Returns null without touching the UI: the caller decides whether a
				// missing avatar is fatal. It is for the sweep, but not for drawing a
				// result that presence already found.
				return null;
			}

			// Presence finds the server without ever looking at a player list, so
			// there are no avatars to show for it. The one face that is always both
			// known and relevant is the person who was searched for.
			async getTargetAvatars() {
				const target = this.cachedTarget;
				if (!target) return [];

				if (!target.thumbnailUrl) {
					target.thumbnailUrl = await this.getUserThumbnail(target.userId);
				}

				return target.thumbnailUrl ? [target.thumbnailUrl] : [];
			}

			async performTargetSearch(target, gameId, run) {
				this.prepareSearchUI();

				// A fresh scanner per attempt. Resetting one shared scanner let the
				// workers of a cancelled attempt - still waiting on a request - carry
				// on against the new attempt's queue with the old target.
				this.scanner.shouldStop = true;
				this.scanner = this.createScanner();
				this.resetProgressCount();

				this.uiManager.setState('is-searching');
				this.uiManager.setStatus(this.searchingText());
				this.uiManager.setBusy(true);
				this.attemptInFlight = true;

				try {
					// Fast path: ask Roblox directly.
					const presence = await this.findViaPresence(target.userId, gameId);
					if (this.isStale(run)) return;

					if (presence.status === 'found') {
						console.log('[ServerScout] found via presence - no avatar sweep needed. jobId:', presence.jobId);
						await this.processSearchResults([presence.jobId], gameId, run);
						return;
					}

					// Roblox stated they are not in this game. Sweeping thousands of
					// servers cannot produce a different answer, so do not waste the
					// requests - report it immediately.
					if (presence.status === 'elsewhere') {
						await this.processSearchResults([], gameId, run, 'elsewhere');
						return;
					}

					// Fallback: sweep every public server and compare avatars. Needs the
					// target's avatar, which is only fetched now that it is actually
					// required.
					if (!target.thumbnailUrl) {
						target.thumbnailUrl = await this.getUserThumbnail(target.userId);
						if (this.isStale(run)) return;

						// Without the avatar the sweep has nothing to compare against.
						if (!target.thumbnailUrl) {
							this.handleSearchError();
							return;
						}
					}

					// Producer and consumers run together. The old code awaited the
					// full server scan before checking a single player, so nothing was
					// matched until every page had been paged through.
					const scanner = this.scanner;
					const scanning = scanner.scanGameServers(gameId);
					const matching = scanner.findTargetInServers(target.thumbnailUrl);

					const [, foundServerIds] = await Promise.all([scanning, matching]);
					if (this.isStale(run)) return;

					// One line that answers every question about why a sweep failed.
					console.log('[ServerScout] sweep summary:', {
						placeId: gameId,
						passes: scanner.passesRun,
						servers: scanner.serverInfo.size,
						playersReported: scanner.expectedPlayers,
						playersSeen: scanner.seenTokens.size,
						coverage: `${Math.round(scanner.coverage * 100)}%`,
						playersChecked: scanner.processedPlayers,
						scanCompletedFully: !scanner.scanIncomplete,
						matches: foundServerIds.length
					});

					if (scanner.totalPlayers === 0) {
						console.warn(
							'[ServerScout] the servers endpoint returned no playerTokens at all. ' +
							'Roblox restricts these, and without them the avatar sweep cannot work - ' +
							'only the presence path can find anyone.'
						);
					}

					await this.processSearchResults(foundServerIds, gameId, run);
				} catch (error) {
					if (this.isStale(run)) return;

					(error && error.authRequired ? console.warn : console.error)('[ServerScout] target search failed:', error);
					this.handleSearchError(error);
				} finally {
					// A cancelled run already cleared this, and a newer run may own it.
					if (!this.isStale(run)) this.attemptInFlight = false;
				}
			}

			prepareSearchUI() {
				// The repeat toggle stays visible while a search runs. Hiding it meant
				// that once "repeat until found" was looping there was no way to switch
				// it off again - the only exit was the stop button.
				const repeating = Utils.isChecked('ss-repeat-checkbox');

				Utils.setDisplay('ss-repeat-wrapper', repeating ? 'flex' : 'none');
				Utils.setDisplay('ss-attempts', repeating ? 'block' : 'none');
			}

			// There is no progress bar any more - the panel's colours already say
			// searching, found or not found. The live count and the readout row at
			// the bottom show how far a sweep has got.
			resetProgressCount() {
				Utils.setText('ss-count', '');
			}

			updateSearchProgress() {
				// Written on every batch: on a huge game the raw count is what shows
				// the search is alive.
				const scanned = Math.min(this.scanner.processedPlayers, this.scanner.totalPlayers);
				const expected = this.scanner.expectedPlayers;

				// Shown against the player count Roblox reports, not against the
				// queued tokens - otherwise it always reads as 100% complete while
				// most of the game has never been sampled.
				Utils.setText(
					'ss-count',
					scanned > 0
						? (expected > 0
							? `${scanned.toLocaleString()} / ${expected.toLocaleString()}`
							: scanned.toLocaleString())
						: ''
				);
			}

			async processSearchResults(serverIds, gameId, run, missReason = null) {
				this.attemptCount++;
				Utils.setText('ss-attempts', `${this.languageManager.getText('attemptCounter')} ${this.attemptCount}`);

				let settled;

				if (serverIds.length > 0) {
					this.discoveredServers = [...serverIds];
					await this.displayFoundServers(gameId, run);
					if (this.isStale(run)) return;

					this.audioManager.playSuccess();
					this.completeSuccessfulSearch();
					settled = true;
				} else {
					settled = this.handleNoResultsFound(missReason);
				}

				this.finalizeSearch();

				// The search is over, so the name is not left sitting in the box. The
				// result row and the status line still say who was searched for.
				// Errors keep it, so a typo can be fixed and retried.
				if (settled && !this.isSearching) this.clearQueryInput();
			}

			async displayFoundServers(gameId, run) {
				this.highlightedElements.forEach(element => element.remove());
				this.highlightedElements = [];

				const container = this.getServerContainer();
				while (container.firstChild) {
					container.removeChild(container.firstChild);
				}

				// Only fetched when a row would otherwise have no faces at all.
				const needsFallback = this.discoveredServers.some(serverId => {
					const stored = this.scanner.thumbnailStorage.get(serverId);
					return !stored || stored.length === 0;
				});

				const fallbackAvatars = needsFallback ? await this.getTargetAvatars() : [];
				if (run !== undefined && this.isStale(run)) return;

				for (const serverId of this.discoveredServers) {
					const stored = this.scanner.thumbnailStorage.get(serverId);
					const avatars = stored && stored.length > 0 ? stored : fallbackAvatars;

					// Known already when the sweep ran.
					const info = this.scanner.serverInfo.get(serverId) || null;
					const row = this.createServerDisplay(serverId, gameId, container, avatars, info);

					// Presence found the server without listing any, so the stats have
					// to be looked up. Deliberately NOT awaited: it pages through the
					// server list, and blocking on it meant the whole result row only
					// appeared after that walk - or never showed stats at all when the
					// server sat past the page budget.
					if (!info) {
						this.fetchServerInfo(gameId, serverId)
							.then(fresh => this.refreshServerMeta(row, serverId, fresh))
							.catch(error => console.warn('[ServerScout] server info lookup failed:', error));
					}
				}
			}

			getServerContainer() {
				// Roblox can re-render the page and replace the panel. A cached node
				// would then be an orphan and every result would be appended to
				// something no longer on the page.
				if (this.serverContainer && !document.contains(this.serverContainer)) {
					this.serverContainer = null;
				}

				if (!this.serverContainer) {
					this.serverContainer = document.getElementById('ss-server-list-container');
				}

				if (!this.serverContainer) {
					this.serverContainer = document.createElement('div');
					this.serverContainer.id = 'ss-server-list-container';

					// Results go above the token readout, which stays at the bottom.
					const panel = this.uiManager.panel;
					if (panel) panel.insertBefore(this.serverContainer, document.getElementById('ss-diag'));
				}

				return this.serverContainer;
			}

			// Builds one chip for the meta row. Returns null so callers can simply
			// skip facts Roblox did not give us, rather than printing "unknown".
			buildChip(text, title) {
				if (text === null || text === undefined || text === '') return null;

				const chip = document.createElement('span');
				chip.className = 'ss-chip';
				chip.textContent = text;
				if (title) chip.title = title;

				return chip;
			}

			buildServerMeta(serverId, info, pending = false) {
				const meta = document.createElement('div');
				meta.className = 'ss-result-meta';

				const chips = [];

				// Presence hands over a server without any stats. Say so instead of
				// silently rendering a row that looks like it is missing something.
				if (!info && pending) {
					const waiting = this.buildChip('loading stats...', 'Reading player count and ping from the server list');
					if (waiting) {
						waiting.className = 'ss-chip ss-chip-pending';
						chips.push(waiting);
					}
				}

				if (info && info.maxPlayers > 0) {
					chips.push(this.buildChip(
						`${info.playing} / ${info.maxPlayers}`,
						'Players in this server'
					));
				}

				if (info && typeof info.ping === 'number') {
					chips.push(this.buildChip(`${Math.round(info.ping)} ms`, 'Server ping reported by Roblox'));
				}

				// The job id is the server's actual address - worth being able to
				// copy, so the chip is a button that puts it on the clipboard.
				const idChip = document.createElement('button');
				idChip.type = 'button';
				idChip.className = 'ss-chip ss-chip-id';
				idChip.textContent = String(serverId).slice(0, 8);
				idChip.title = `Server (job) id: ${serverId}\nClick to copy`;

				idChip.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(String(serverId));
						const previous = idChip.textContent;
						idChip.textContent = 'copied';
						setTimeout(() => { idChip.textContent = previous; }, 1200);
					} catch (error) {
						// Clipboard access can be denied; the full id is in the tooltip.
					}
				});

				chips.push(idChip);
				chips.filter(Boolean).forEach(chip => meta.appendChild(chip));

				return meta;
			}

			createServerDisplay(serverId, gameId, container, avatars = [], info = null) {
				const row = document.createElement('div');
				row.className = 'ss-result';

				const identity = document.createElement('div');
				identity.className = 'ss-result-identity';

				const players = document.createElement('div');
				players.className = 'ss-result-players';

				// The row only has to show that the server was found, not every
				// player in it.
				avatars.slice(0, CONFIG.SEARCH.MAX_RESULT_AVATARS).forEach(url => {
					const image = document.createElement('img');
					image.src = url;
					image.alt = '';
					image.loading = 'lazy';
					players.appendChild(image);
				});

				identity.appendChild(players);

				const details = document.createElement('div');
				details.className = 'ss-result-info';

				// Names the person who was found. Without it a single avatar is
				// ambiguous - it could be read as "some player in this server".
				const label = this.cachedTarget && this.cachedTarget.label;
				if (label) {
					const name = document.createElement('span');
					name.className = 'ss-result-name';
					name.textContent = label;
					details.appendChild(name);
				}

				details.appendChild(this.buildServerMeta(serverId, info, !info));
				identity.appendChild(details);

				row.appendChild(identity);
				row.appendChild(this.buildServerActions(serverId, gameId, info));
				container.appendChild(row);
				this.highlightedElements.push(row);

				return row;
			}

			// Swaps the meta chips once the stats arrive, so the row can be shown
			// immediately instead of waiting on a lookup that pages through the
			// whole server list.
			refreshServerMeta(row, serverId, info) {
				if (!row || !info) return;

				const existing = row.querySelector('.ss-result-meta');
				if (existing && existing.parentNode) {
					existing.parentNode.replaceChild(this.buildServerMeta(serverId, info), existing);
				}

				// The stats may reveal the server filled up while it was being looked
				// up; offering a join that cannot succeed would be worse than none.
				this.applyJoinAvailability(row.querySelector('.ss-action-play'), info);
			}

			applyJoinAvailability(joinButton, info) {
				if (!joinButton) return;

				const label = this.languageManager.getText('serverJoin');
				const full = Boolean(info && info.maxPlayers > 0 && info.playing >= info.maxPlayers);

				joinButton.classList.toggle('is-full', full);
				joinButton.disabled = full;
				joinButton.title = full
					? `${label} - server is full (${info.playing}/${info.maxPlayers})`
					: label;
			}

			// Roblox's own deep link to one specific server.
			// Without a server id the link joins the game itself, which is what a
			// player whose server is hidden can be joined by.
			buildJoinLink(gameId, serverId) {
				const base = `https://www.roblox.com/games/start?placeId=${gameId}`;
				return serverId ? `${base}&gameInstanceId=${serverId}` : base;
			}

			// Read from the page itself, without any request: Roblox marks a
			// signed-out visitor on its game pages. Anything else - including the
			// marker disappearing in a Roblox redesign - counts as signed in, so a
			// join is never blocked by mistake.
			isSignedOut() {
				// A signed-in page carries the viewer's own user data. When that is
				// present the visitor is signed in, whatever the other marker says.
				if (document.querySelector('meta[name="user-data"][data-userid]')) return false;

				const marker = document.getElementById('ItemPurchaseAjaxData');
				return Boolean(marker && marker.getAttribute('data-authenticateduser-isnull') === 'True');
			}

			// chrome.runtime dies when the extension is reloaded while the page stays
			// open. Unhandled, the join button just did nothing and said nothing.
			// The background now also answers, so a missing launcher is reported
			// instead of looking like a join that silently did nothing.
			async sendJoinRequest(gameId, serverId) {
				try {
					const response = await chrome.runtime.sendMessage({ message: { place: gameId, id: serverId } });
					if (response && response.ok === true) return;

					// Roblox's in-page launcher is gone. Its documented deep link still
					// starts the exact same server, so that is used instead of failing.
					if (response && response.fallback) {
						this.joinThroughDeepLink(gameId, serverId, response.error);
						return;
					}

					this.reportJoinFailure(new Error((response && response.error) || 'no response from the extension'));
				} catch (error) {
					// The extension was reloaded while this page stayed open, so it can
					// no longer be reached. The deep link needs no extension at all.
					this.joinThroughDeepLink(gameId, serverId, error);
				}
			}

			// Reads the optional games box. Entries are separated by commas, semicolons
			// or new lines; duplicates are dropped and the list is capped so one click
			// cannot start an unbounded scan.
			readGamesList() {
				const input = document.getElementById('ss-games');
				if (!input) return [];

				const seen = new Set();
				return String(input.value || '')
					.split(/[\n,;]+/)
					.map(part => part.trim())
					.filter(part => {
						const key = part.toLowerCase();
						if (!part || seen.has(key)) return false;
						seen.add(key);
						return true;
					})
					.slice(0, 8);
			}

			// Joins the first listed game whose servers contain the player. A game
			// whose presence answer says they are elsewhere is skipped outright - the
			// sweep cannot contradict Roblox - and a game Roblox will not talk about
			// falls back to the public server sweep, exactly like the game page does.
			async joinFromGames(target, games) {
				const resolved = [];
				this.gamesJoinCancelled = false;

				for (const entry of games) {
					try {
						const placeId = await this.api.resolvePlace(entry);
						if (placeId) resolved.push({ entry, placeId });
						else console.log('[ServerScout] no game matched:', entry);
					} catch (error) {
						console.warn('[ServerScout] game lookup failed:', entry, error);
					}
				}

				if (resolved.length === 0) {
					this.uiManager.setState('is-notfound');
					this.uiManager.setStatus(`${this.languageManager.getText('userNotLocated')}: ${games.join(', ')}`);
					return;
				}

				for (let index = 0; index < resolved.length; index++) {
					if (this.gamesJoinCancelled) return;

					const { entry, placeId } = resolved[index];

					this.uiManager.setState('is-searching');
					this.uiManager.setStatus(`${this.languageManager.getText('activeSearch')} ${entry} (${index + 1}/${resolved.length})`);

					const hit = await this.findInGame(target, placeId);
					if (this.gamesJoinCancelled) return;

					if (hit) {
						this.uiManager.setState('is-found');
						this.uiManager.setStatus('');
						await this.sendJoinRequest(String(placeId), hit.serverId ? String(hit.serverId) : '');
						this.flashStatus(this.languageManager.getText('joinOpening'), 8000);
						return;
					}
				}

				this.uiManager.setState('is-notfound');
				this.uiManager.setStatus(`${this.languageManager.getText('userNotLocated')}: ${target.label}`);
			}

			// One game, one answer: presence first, then the public server sweep.
			// Shaped like performTargetSearch but returning the server instead of
			// rendering result rows, since the games box joins immediately.
			async findInGame(target, placeId) {
				const presence = await this.findViaPresence(target.userId, placeId);

				if (presence.status === 'found') return { serverId: presence.jobId };
				if (presence.status === 'elsewhere') return null;

				if (!target.thumbnailUrl) {
					target.thumbnailUrl = await this.getUserThumbnail(target.userId);
					if (!target.thumbnailUrl) return null;
				}

				// A newer run owns the panel; retire the previous scanner first so its
				// workers cannot answer into this one.
				this.scanner.shouldStop = true;
				const scanner = this.createScanner();
				this.scanner = scanner;

				const scanning = scanner.scanGameServers(placeId);
				const matching = scanner.findTargetInServers(target.thumbnailUrl);
				const [, found] = await Promise.all([scanning, matching]);

				return found.length > 0 ? { serverId: found[0] } : null;
			}

			joinThroughDeepLink(gameId, serverId, reason) {
				console.warn('[ServerScout] joining through Roblox\'s deep link instead of the launcher:', reason);
				window.location.assign(this.buildJoinLink(gameId, serverId));
			}

			// Shows a short confirmation that removes itself again, unless something
			// else has written to the status line in the meantime.
			flashStatus(text, durationMs = 2500) {
				this.uiManager.setStatus(text);
				clearTimeout(this.flashTimer);

				this.flashTimer = setTimeout(() => {
					const status = this.uiManager.elements['ss-status'];
					if (status && status.textContent === text) this.uiManager.setStatus('');
				}, durationMs);
			}

			// Copies text on click, briefly marks the button and confirms it in the
			// status line. Clipboard access can be refused; the text is then logged
			// so it is never lost.
			bindCopyButton(button, text, statusKey = null) {
				button.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(text);
						button.classList.add('is-copied');
						setTimeout(() => button.classList.remove('is-copied'), 1200);
						if (statusKey) this.flashStatus(this.languageManager.getText(statusKey));
					} catch (error) {
						console.log('[ServerScout] copy manually:', text);
					}
				});
			}

			reportJoinFailure(error) {
				console.error('[ServerScout] join failed - reload the page if the extension was updated:', error);
				this.uiManager.setState('is-error');
				this.uiManager.setStatus(this.languageManager.getText('systemError'));
			}

			// Signed in: Join (starts Roblox right here) plus a button that copies the
			// join link. Signed out: Roblox cannot start a game from this page - its
			// launcher would only send the visitor to roblox.com/login - so Join is
			// left out and the join link becomes the highlighted main action.
			//
			// The join link replaced the old "copy console command" button. A link
			// opens from any browser and can be sent to a friend's phone. The console
			// command needed DevTools, and "paste this into your console" is the
			// classic trick for stealing Roblox accounts, which people are rightly
			// taught never to do.
			buildServerActions(serverId, gameId, info = null) {
				const actions = document.createElement('div');
				actions.className = 'ss-actions';

				const signedOut = this.isSignedOut();

				if (!signedOut) {
					const joinLabel = this.languageManager.getText('serverJoin');

					const joinButton = document.createElement('button');
					joinButton.type = 'button';
					joinButton.className = 'ss-action ss-action-play';
					joinButton.title = joinLabel;
					joinButton.setAttribute('aria-label', joinLabel);
					joinButton.appendChild(Utils.svgIcon(
						['M8.5 5.6a1 1 0 0 1 1.52-.85l8.1 5.4a1 1 0 0 1 0 1.7l-8.1 5.4a1 1 0 0 1-1.52-.85z'],
						{ fill: 'currentColor' }
					));

					this.applyJoinAvailability(joinButton, info);

					joinButton.addEventListener('click', () => {
						this.sendJoinRequest(gameId, serverId);
					});

					actions.appendChild(joinButton);
				}

				// Roblox's own deep link to one specific server. Opening it joins that
				// exact server, so it can be sent to a friend.
				const joinLink = this.buildJoinLink(gameId, serverId);

				const linkButton = document.createElement('button');
				linkButton.type = 'button';
				linkButton.className = signedOut ? 'ss-action ss-action-link is-primary' : 'ss-action ss-action-link';
				linkButton.title = `Copy join link:\n${joinLink}`;
				linkButton.setAttribute('aria-label', 'Copy join link');
				linkButton.appendChild(Utils.svgIcon([
					'M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.5 6',
					'M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.3-1.2'
				], { stroke: 2 }));
				this.bindCopyButton(linkButton, joinLink, 'linkCopied');

				actions.appendChild(linkButton);

				return actions;
			}

			completeSuccessfulSearch() {
				this.uiManager.setState('is-found');
				// No "Found target" text: the green result row right below already
				// says it, and the line only took up space.
				this.uiManager.setStatus('');

				Utils.setDisplay('ss-repeat-wrapper', 'flex');
				Utils.setDisplay('ss-attempts', 'none');
				this.isAutoMode = false;

				this.announceInTitle();
			}

			// A repeat search can run for a long time in a background tab. Marking the
			// tab title means a hit gets noticed without keeping the page in view; the
			// title goes back to normal as soon as the tab is looked at again.
			announceInTitle() {
				if (!document.hidden) return;

				if (this.originalTitle === null) this.originalTitle = document.title;
				document.title = `✓ ${this.languageManager.getText('userLocated')} | ${this.originalTitle}`;

				const restore = () => {
					if (document.hidden) return;
					document.removeEventListener('visibilitychange', restore);

					if (this.originalTitle !== null) {
						document.title = this.originalTitle;
						this.originalTitle = null;
					}
				};

				document.addEventListener('visibilitychange', restore);
			}

			// Returns true when the search ended with a definite answer, false when it
			// goes on repeating or could not be completed.
			handleNoResultsFound(missReason = null) {
				if (!Utils.isChecked('ss-repeat-checkbox')) {
					// If the server scan gave up part-way, "not found" would be a claim
					// we cannot actually back - report it as an error instead.
					const scanFailed = this.scanner.scanIncomplete;

					if (scanFailed) {
						console.warn('[ServerScout] server scan ended early; the game was not swept completely.');
					}

					let statusKey = 'userNotLocated';
					if (scanFailed) statusKey = 'systemError';
					else if (missReason === 'elsewhere') statusKey = 'userElsewhere';

					// Names who was searched for, since the box is emptied afterwards.
					const label = this.cachedTarget && this.cachedTarget.label;
					const statusText = this.languageManager.getText(statusKey);

					this.uiManager.setState(scanFailed ? 'is-error' : 'is-notfound');
					this.uiManager.setStatus(label && !scanFailed ? `${statusText}: ${label}` : statusText);

					Utils.setDisplay('ss-repeat-wrapper', 'flex');
					Utils.setDisplay('ss-attempts', 'none');
					return !scanFailed;
				}

				this.uiManager.setState('is-searching');
				this.uiManager.setStatus(this.searchingText(true));
				Utils.setDisplay('ss-repeat-wrapper', 'flex');
				Utils.setDisplay('ss-attempts', 'block');

				this.scheduleRepeat(CONFIG.REPEAT.DELAY_MS);
				return false;
			}

			// One place that owns the retry loop. Every path that wants another
			// attempt goes through here, so the guards cannot drift apart.
			scheduleRepeat(delayMs) {
				const run = this.runId;

				this.isAutoMode = true;
				this.isSearching = true;

				// Kept on the instance so cancelSearch can clear it - otherwise
				// cancelling inside this window still kicked off another search.
				this.clearRepeatTimer();

				this.repeatTimer = setTimeout(() => {
					this.repeatTimer = null;

					// Re-checked at fire time: the user may have cancelled or unticked
					// the box during the wait.
					if (this.isStale(run) || !this.isAutoMode) return;
					if (!Utils.isChecked('ss-repeat-checkbox')) {
						this.stopRepeating();
						return;
					}

					this.executeSearch();
				}, delayMs);
			}

			// Cancels the scheduling of further attempts. It deliberately does NOT
			// abort an attempt that is already running - unticking "repeat until
			// found" means "stop looping", not "throw away the search in progress".
			stopRepeating() {
				this.clearRepeatTimer();
				this.isAutoMode = false;

				Utils.setDisplay('ss-repeat-wrapper', 'flex');
				Utils.setDisplay('ss-attempts', 'none');

				// The running attempt reports its own result when it finishes.
				if (this.attemptInFlight) return;

				this.isSearching = false;
				this.uiManager.setState('is-idle');
				this.uiManager.setStatus('');
				this.uiManager.setBusy(false);
				this.syncInputState();
				this.showTokenDiagnostic();
			}

			clearRepeatTimer() {
				if (this.repeatTimer) {
					clearTimeout(this.repeatTimer);
					this.repeatTimer = null;
				}
			}

			finalizeSearch() {
				this.isSearching = this.isAutoMode;
				this.uiManager.setBusy(this.isAutoMode);

				// The readout row still shows the sweep's last pass with a pulsing
				// dot, which looks like work is still going on. Put the idle readout
				// back once the search is really over.
				if (!this.isSearching) this.showTokenDiagnostic();
			}

			// A bad username is permanent: retrying it every few seconds would hammer
			// the API forever, because a typo can never resolve on a later attempt.
			showUserError() {
				this.failSearch(this.languageManager.getText('userNotValid'), true);
			}

			handleSearchError() {
				this.failSearch(this.languageManager.getText('systemError'));
			}

			failSearch(statusText, permanent = false) {
				this.uiManager.setState('is-error');
				this.uiManager.setStatus(statusText);

				// With "repeat until found" ticked, a single TRANSIENT failure must not
				// end the loop. A dropped request or a brief rate-limit used to kill it
				// permanently - and on the very first attempt it never retried at all,
				// because the loop only counted as running from the second attempt on.
				const retrying = !permanent && Utils.isChecked('ss-repeat-checkbox');

				if (retrying) {
					console.warn('[ServerScout] attempt failed while repeating - retrying.');
					Utils.setDisplay('ss-repeat-wrapper', 'flex');
					Utils.setDisplay('ss-attempts', 'block');
					this.scheduleRepeat(CONFIG.REPEAT.ERROR_DELAY_MS);
					return;
				}

				this.clearRepeatTimer();
				this.isSearching = false;
				this.isAutoMode = false;
				this.attemptInFlight = false;
				this.uiManager.setBusy(false);

				Utils.setDisplay('ss-attempts', 'none');
				this.syncInputState();
				this.showTokenDiagnostic();
			}

			clearPreviousResults() {
				this.highlightedElements.forEach(element => element.remove());
				this.highlightedElements = [];
			}
		}

		const searchEngine = new ServerScoutEngine();
		
		try {
			searchEngine.initialize();
		} catch (error) {
			console.error("[ServerScout] initialization error:", error);
			setTimeout(() => {
				try {
					searchEngine.initialize();
				} catch (retryError) {
					console.error("[ServerScout] initialization retry failed:", retryError);
				}
			}, 2000);
		}
	})();
}

// Wait for the panel that start.js injects, then start ServerScout.
// (The old gate watched for a Roblox nav element that no longer exists in the
// current site layout, which meant the engine never started.)
// Wrapped in a function so that a second injection into the same page cannot
// fail on already-declared constants.
(function waitForPanel() {
    // start.js always places the panel - at the latest after ~10 seconds, as a
    // floating panel - so this limit is only reached on a page that is broken.
    const PANEL_WAIT_TIMEOUT_MS = 60000;
    const panelWaitStart = Date.now();

    const interval = setInterval(() => {
        if (document.getElementById('ss-panel')) {
            clearInterval(interval);
            startServerScout();
        } else if (Date.now() - panelWaitStart > PANEL_WAIT_TIMEOUT_MS) {
            clearInterval(interval);
        }
    }, 100);
})();