// I Spy Road Trip — Conversational Game Master Client
// All game logic handled by Claude as Professor Jones via /api/gamemaster

// Game State
let gameState = {
    phase: 'setup_intro',
    players: [],
    roundNumber: 0,
    category: null,
    difficulty: null, // 'easy' | 'medium' | 'hard'
    currentRound: {
        letter: null,
        answer: null,
        hints: [],
        hintsRevealed: 0,
        proximity: null,
        nearbyLocation: null,
        essay: null,
        guessValidated: false // true when validateGuess() confirmed a correct answer this round
    },
    conversationHistory: [],
    previousAnswers: [], // all answers from this session, to prevent repeats
    answerPool: [], // pre-generated answers for instant round starts
    poolLoading: false, // true while fetching a new pool batch
    location: {
        latitude: null,
        longitude: null,
        city: null,
        county: null,
        region: null,
        watching: false,
        watchId: null
    }
};

let isProcessing = false;

// --- Transcript Preprocessing ---
// Voice input is messy — "Hi this is John, is it Selma?" needs to be split into
// the player intro and the actual guess so classifyIntent and validateGuess work
// on the right text. Raw transcript is still sent to Claude for player identification.

function preprocessTranscript(raw) {
    // Strip filler words from the front
    let cleaned = raw
        .replace(/^(hi|hello|hey|ok|okay|so|um|uh|well|like)[,\s]+/i, '')
        .trim();

    // Extract player name if present (keep it for Claude, strip for intent)
    let playerName = null;
    const introMatch = cleaned.match(/^(this is|i'm|my name is|it's)\s+(\w+)[,\s]*/i);
    if (introMatch) {
        playerName = introMatch[2];
        cleaned = cleaned.slice(introMatch[0].length).trim();
    }

    // If compound ("this is John, is it Selma?"), take the last clause for intent
    const clauses = cleaned.split(/[,;]\s*/);
    const lastClause = clauses[clauses.length - 1].trim();

    // Strip guess preamble to get bare answer for validation
    const guessText = lastClause
        .replace(/^(is it|i think it'?s|my guess is|i say|i'?ll guess|it'?s|gotta be|must be)\s+/i, '')
        .trim();

    return {
        raw,
        cleaned,
        playerName,
        lastClause,   // for classifyIntent
        guessText     // for validateGuess (bare answer, no "is it" prefix)
    };
}

// --- Intent Classification ---
// Classifies player voice input so Claude gets a hint about what the player means.
// Voice transcripts are messy — this helps route "yes" (to a hint offer) vs a guess.

function classifyIntent(transcript) {
    const t = transcript.toLowerCase().trim();

    // Skip/give up
    if (/\b(skip|give up|pass|next|move on)\b/.test(t))
        return 'skip';

    // Explicit hint request
    if (/\b(hint|clue|help me|stuck|don'?t know)\b/.test(t))
        return 'hint_request';

    // Question (has question mark or starts with question word)
    if (t.includes('?') || /^(who|what|where|when|why|how|is|are|was|were|do|does|did|can|could|would|tell me about)\b/.test(t))
        return 'question';

    // Explicit guess patterns
    if (/\b(is it|i think|my (guess|answer)|i say|it'?s|gotta be|must be|i'?ll guess)\b/.test(t))
        return 'guess';

    // "yes"/"no"/"sure"/"nope" — affirmation/denial (context-dependent)
    if (/^(yes|yeah|yep|sure|ok|okay|no|nah|nope|not yet)$/i.test(t))
        return 'response';

    // Short phrase (1-4 words, no question mark) — likely a guess during active round
    if (t.split(/\s+/).length <= 4)
        return 'probable_guess';

    return 'conversation';
}

// --- Deterministic Guess Validation ---
// Checks player guesses against the current answer in code, so Claude can't
// accept wrong answers or reject correct ones.

function validateGuess(guess, correctAnswer) {
    const normalize = s => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
    const g = normalize(guess);
    const a = normalize(correctAnswer);

    if (!g || !a) return { correct: false };

    // Exact match
    if (g === a) return { correct: true, reason: 'exact' };

    // Handle common articles ("the selma march" vs "selma march")
    const stripped = a.replace(/^(the|a|an)\s+/i, '');
    if (g === normalize(stripped)) return { correct: true, reason: 'article_stripped' };

    // Guess without articles matching answer without articles
    const gStripped = g.replace(/^(the|a|an)\s+/i, '');
    if (gStripped === normalize(stripped)) return { correct: true, reason: 'article_stripped' };

    // For multi-word answers: all key words (>3 chars) present in guess
    const keyWords = normalize(stripped).split(/\s+/).filter(w => w.length > 3);
    if (keyWords.length > 1 && keyWords.every(w => g.includes(w))) {
        return { correct: true, reason: 'all_keywords' };
    }

    return { correct: false };
}

// --- Answer Pool Management ---
// Pre-generates a batch of answers so rounds start instantly.

async function fetchAnswerPool() {
    if (gameState.poolLoading) return;
    gameState.poolLoading = true;

    try {
        const response = await fetch('/api/generate-pool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category: gameState.category,
                difficulty: gameState.difficulty,
                location: {
                    city: gameState.location.city,
                    county: gameState.location.county,
                    region: gameState.location.region
                },
                previousAnswers: gameState.previousAnswers
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.pool && data.pool.length > 0) {
                // Append to existing pool (don't replace — may have unused entries)
                gameState.answerPool = gameState.answerPool.concat(data.pool);
                console.log(`[Pool] Loaded ${data.pool.length} answers, total pool: ${gameState.answerPool.length}`);
            }
        } else {
            console.warn('[Pool] Failed to fetch:', response.status);
        }
    } catch (err) {
        console.warn('[Pool] Fetch error:', err);
    }

    gameState.poolLoading = false;
}

function drawFromPool() {
    if (gameState.answerPool.length === 0) return null;

    // Take the first available answer
    const entry = gameState.answerPool.shift();

    // If pool is running low (<=2 left), trigger a background refill
    if (gameState.answerPool.length <= 2 && !gameState.poolLoading) {
        fetchAnswerPool();
    }

    return entry;
}

// DOM Elements
const setupScreen = document.getElementById('setup-screen');
const gameScreen = document.getElementById('game-screen');

// --- Core: Send everything to the Game Master ---

let retryCount = 0;

async function callGamemaster(transcript, onSpeech) {
    try {
        const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch('/api/gamemaster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                userId: user?.id || null,
                gameState: {
                    phase: gameState.phase,
                    players: gameState.players,
                    currentRound: gameState.currentRound,
                    roundNumber: gameState.roundNumber,
                    category: gameState.category,
                    difficulty: gameState.difficulty,
                    previousAnswers: gameState.previousAnswers,
                    location: {
                        latitude: gameState.location.latitude,
                        longitude: gameState.location.longitude,
                        city: gameState.location.city,
                        county: gameState.location.county,
                        region: gameState.location.region
                    }
                },
                conversationHistory: gameState.conversationHistory.slice(-2),
                transcript: transcript
            })
        });

        clearTimeout(timeout);

        if (response.status === 402) {
            console.warn('[Game] Out of credits (402)');
            showOutOfCredits();
            return null;
        }

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            console.error('[Game] Gamemaster API error:', response.status, errBody);
            if (retryCount < 1) {
                retryCount++;
                return callGamemaster(transcript, onSpeech);
            }
            return null;
        }

        // Parse NDJSON lines, processing speech as early as possible
        let completeData = null;

        function processLine(line) {
            line = line.trim();
            if (!line) return;
            let msg;
            try { msg = JSON.parse(line); } catch { return; }

            if (msg.type === 'speech' && onSpeech) {
                onSpeech(msg.speech);
            } else if (msg.type === 'complete') {
                completeData = msg;
            } else if (msg.type === 'error') {
                completeData = msg.speech ? msg : null;
            } else if (msg.speech && msg.actions) {
                completeData = msg;
            }
        }

        // Try streaming for faster speech playback, fall back to buffered read
        if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let newlineIdx;
                while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                    processLine(buffer.slice(0, newlineIdx));
                    buffer = buffer.slice(newlineIdx + 1);
                }
            }
            // Process any remaining data in the buffer
            if (buffer.trim()) processLine(buffer);
        } else {
            // Fallback: read entire response at once
            const text = await response.text();
            for (const line of text.trim().split('\n')) {
                processLine(line);
            }
        }

        return completeData;
    } catch (error) {
        if (retryCount < 1) {
            retryCount++;
            return callGamemaster(transcript, onSpeech);
        }
        return null;
    }
}

let pendingTranscript = null;

async function sendToGamemaster(transcript) {
    if (!transcript) return;

    // Cancel any pending silence timer — player is actively communicating
    AudioManager.clearSilenceTimer();

    if (isProcessing) {
        // Don't drop player input — queue it (real speech replaces queued silence)
        const isSystemMessage = transcript.startsWith('[');
        if (!isSystemMessage || !pendingTranscript) {
            pendingTranscript = transcript;
        }
        return;
    }
    isProcessing = true;

    // Safety net: if isProcessing is still true after 35 seconds, force reset
    const safetyTimeout = setTimeout(() => {
        if (isProcessing) {
            console.warn('[Game] Safety reset: isProcessing stuck, forcing reset');
            isProcessing = false;
            removeThinkingIndicator();
        }
    }, 35000);

    // Show thinking indicator (hide internal system messages from transcript)
    const isSystemMessage = transcript.startsWith('[');
    if (!isSystemMessage) {
        addTranscriptEntry('player', transcript);
    }

    // --- Preprocess, classify intent, and validate guesses ---
    let annotatedTranscript = transcript;
    if (!isSystemMessage && gameState.phase === 'playing' && gameState.currentRound?.answer) {
        const pp = preprocessTranscript(transcript);
        const intent = classifyIntent(pp.lastClause);

        // Check for correct guess — use guessText (bare answer, no "is it" prefix)
        if (!gameState.currentRound.guessValidated && (intent === 'guess' || intent === 'probable_guess')) {
            // Try multiple cleaned forms to catch "is it Selma", "Selma", full transcript
            const answer = gameState.currentRound.answer;
            const r1 = validateGuess(pp.guessText, answer);
            const r2 = !r1.correct ? validateGuess(pp.lastClause, answer) : r1;
            const r3 = !r2.correct ? validateGuess(transcript, answer) : r2;
            const result = r3;
            if (result.correct) {
                gameState.currentRound.guessValidated = true;
                annotatedTranscript = `${transcript}\n[SYSTEM: CORRECT ANSWER. The guess matches "${gameState.currentRound.answer}". Celebrate, emit correct_guess (identify which player), then ask if they have questions before moving on.]`;
            } else {
                annotatedTranscript = `${transcript}\n[SYSTEM: Intent=${intent}. This is a guess attempt — evaluate against the answer "${gameState.currentRound.answer}".]`;
            }
        } else if (intent === 'hint_request') {
            annotatedTranscript = `${transcript}\n[SYSTEM: Intent=hint_request. Player wants a HINT, not the answer. Use reveal_hint.]`;
        } else if (intent === 'skip') {
            annotatedTranscript = `${transcript}\n[SYSTEM: Intent=skip. Player wants to skip/give up. Reveal answer and essay.]`;
        } else if (intent !== 'conversation' && intent !== 'response') {
            annotatedTranscript = `${transcript}\n[SYSTEM: Intent=${intent}.]`;
        }
    }

    // --- Pool-based round injection ---
    // If it's time for a new round and we have a pre-generated answer, use it.
    // Apply the round data client-side and tell Claude to just announce it.
    let pooledRound = null;
    const isNextRoundTrigger = isSystemMessage && (
        transcript === '[Start next round]' ||
        transcript === '[Game session started]' ||
        transcript.includes('generate the I Spy clue')
    );
    const playerWantsNext = !isSystemMessage && gameState.phase === 'playing' &&
        !gameState.currentRound?.answer &&
        classifyIntent(transcript) !== 'question';

    if ((isNextRoundTrigger || playerWantsNext) && gameState.answerPool.length > 0) {
        pooledRound = drawFromPool();
        if (pooledRound) {
            // Apply the round immediately — UI updates now
            executeAction({
                type: 'start_round',
                letter: pooledRound.letter,
                answer: pooledRound.answer,
                hints: pooledRound.hints,
                essay: pooledRound.essay,
                proximity: pooledRound.proximity || 'region'
            });

            // If pool entry has pre-generated speech, skip the API call entirely
            if (pooledRound.speech) {
                clearTimeout(safetyTimeout);
                addTranscriptEntry('jones', pooledRound.speech);
                AudioManager.speak(pooledRound.speech);
                gameState.conversationHistory.push({ role: 'user', content: transcript });
                gameState.conversationHistory.push({ role: 'assistant', content: pooledRound.speech });
                if (gameState.conversationHistory.length > 2) {
                    gameState.conversationHistory = gameState.conversationHistory.slice(-2);
                }
                isProcessing = false;
                if (pendingTranscript) {
                    const queued = pendingTranscript;
                    pendingTranscript = null;
                    sendToGamemaster(queued);
                }
                return;
            }

            // No speech in pool entry — ask Claude to announce it
            annotatedTranscript = `[SYSTEM: A new round has started. Letter: ${pooledRound.letter}. DO NOT call create_round — the round is already set. Announce it with: "I spy with my little eye something that begins with the letter ${pooledRound.letter}." Then add a brief teaser. Speech only, no start_round action.]`;
        }
    }

    // Always show thinking indicator — even for system messages, so the UI never looks dead
    addTranscriptEntry('jones', '...', true);

    let ttsPromise = null;
    let speechHandled = false;

    let data;
    try {
        data = await callGamemaster(annotatedTranscript, (speech) => {
            speechHandled = true;
            ttsPromise = AudioManager.prefetchAudio(speech);
            // Fire-and-forget — don't let TTS failures block the processing pipeline
            AudioManager.playPrefetched(ttsPromise).catch(e =>
                console.warn('[Game] TTS playback error (non-blocking):', e)
            );
            addTranscriptEntry('jones', speech);
            removeThinkingIndicator();
        });
    } catch (err) {
        console.error('[Game] callGamemaster threw:', err);
        data = null;
    }

    clearTimeout(safetyTimeout);

    if (!data) {
        // Remove ALL thinking indicators (there may be more than one)
        removeThinkingIndicator();
        removeThinkingIndicator();
        isProcessing = false;

        // Show visible error so the user isn't left staring at a blank screen
        addTranscriptEntry('jones', 'Having trouble connecting. Try tapping Send or speaking to retry.');

        // Still process queued input even on failure
        if (pendingTranscript) {
            const queued = pendingTranscript;
            pendingTranscript = null;
            sendToGamemaster(queued);
        }
        return;
    }

    removeThinkingIndicator();
    retryCount = 0;

    // Store original transcript in history, not the annotated version
    gameState.conversationHistory.push({ role: 'user', content: transcript });
    if (data.speech) {
        gameState.conversationHistory.push({ role: 'assistant', content: data.speech });
    }
    if (gameState.conversationHistory.length > 2) {
        gameState.conversationHistory = gameState.conversationHistory.slice(-2);
    }

    if (data.actions && Array.isArray(data.actions)) {
        for (const action of data.actions) {
            executeAction(action);
        }
    }

    if (data.remainingCredits !== null && data.remainingCredits !== undefined) {
        updateGameCreditsDisplay(data.remainingCredits);
    }

    // If speech callback didn't fire (edge case), play now
    if (data.speech && !speechHandled) {
        ttsPromise = AudioManager.prefetchAudio(data.speech);
        addTranscriptEntry('jones', data.speech);
        AudioManager.playPrefetched(ttsPromise).catch(e =>
            console.warn('[Game] TTS playback error (non-blocking):', e)
        );
    }

    // AUTO-ADVANCE: if round just ended (correct guess or answer revealed), start next round
    const hadCorrectGuess = data.actions && data.actions.some(a => a.type === 'correct_guess');
    const hadRevealAnswer = data.actions && data.actions.some(a => a.type === 'reveal_answer');
    if ((hadCorrectGuess || hadRevealAnswer) && gameState.answerPool.length > 0) {
        isProcessing = false;
        // Wait for TTS to finish speaking, then brief pause, then next round
        const waitForSpeech = () => {
            if (AudioManager.isSpeaking) {
                setTimeout(waitForSpeech, 500);
            } else {
                // Brief pause after speech ends so it doesn't feel rushed
                setTimeout(() => sendToGamemaster('[Start next round]'), 1500);
            }
        };
        // Start checking after a minimum delay
        setTimeout(waitForSpeech, 1000);
        return;
    }

    // Safety net: if category is set but Claude didn't generate a clue yet
    if (gameState.category && !gameState.currentRound.answer && gameState.phase !== 'setup_intro') {
        isProcessing = false;
        setTimeout(() => sendToGamemaster('[Now generate the I Spy clue. Include a start_round action with letter, answer, hints, essay, proximity.]'), 1500);
        return;
    }

    isProcessing = false;

    // Process any queued input that arrived while we were busy
    if (pendingTranscript) {
        const queued = pendingTranscript;
        pendingTranscript = null;
        sendToGamemaster(queued);
    }
}

// --- Execute structured actions from the Game Master ---

function executeAction(action) {
    if (!action || !action.type) return;

    switch (action.type) {
        case 'set_phase':
            gameState.phase = action.phase;
            updatePhaseUI();
            break;

        case 'register_player':
            // Avoid duplicates
            if (!gameState.players.find(p => p.name.toLowerCase() === action.name.toLowerCase())) {
                gameState.players.push({
                    name: action.name,
                    score: 0,
                    isLeader: action.isLeader || false
                });
            }
            updateScoreboard();
            break;

        case 'set_category':
            gameState.category = action.category;
            updateCategoryDisplay();
            // Pre-generate answer pool in background as soon as category is set
            fetchAnswerPool();
            break;

        case 'set_difficulty':
            gameState.difficulty = action.difficulty;
            // If category is already set, refresh the pool with correct difficulty
            if (gameState.category && gameState.answerPool.length === 0) {
                fetchAnswerPool();
            }
            break;

        case 'start_round': {
            // Server validates letter matching via tool use — this is a safety net only
            const letter = (action.letter || '').toUpperCase();
            const answer = (action.answer || '');
            if (answer && letter && answer[0].toUpperCase() !== letter) {
                console.warn(`[Game] Letter mismatch slipped through: "${answer}" for "${letter}" — skipping`);
                break;
            }
            gameState.roundNumber++;
            gameState.currentRound = {
                letter: letter,
                answer: answer,
                hints: action.hints || [],
                hintsRevealed: 0,
                proximity: action.proximity || 'region',
                nearbyLocation: action.nearbyLocation || null,
                essay: action.essay || null,
                guessValidated: false
            };
            // Track this answer so we never repeat it
            if (answer && !gameState.previousAnswers.includes(answer)) {
                gameState.previousAnswers.push(answer);
            }
            updateRoundDisplay();
            break;
        }

        case 'correct_guess': {
            // Only award points if validateGuess() confirmed the answer in code.
            // This prevents Claude from awarding points for wrong answers.
            if (!gameState.currentRound.guessValidated) {
                console.warn('[Game] correct_guess blocked — validateGuess did not confirm this answer');
                break;
            }
            const player = gameState.players.find(p =>
                p.name.toLowerCase() === (action.player || '').toLowerCase()
            );
            if (player) {
                player.score += (action.points || 1);
            }
            updateScoreboard();
            break;
        }

        case 'set_score': {
            const targetPlayer = gameState.players.find(p =>
                p.name.toLowerCase() === (action.player || '').toLowerCase()
            );
            if (targetPlayer && typeof action.score === 'number') {
                targetPlayer.score = action.score;
            }
            updateScoreboard();
            break;
        }

        case 'incorrect_guess':
            // No state change needed — Professor Jones handles it verbally
            break;

        case 'reveal_hint':
            if (typeof action.hintIndex === 'number') {
                gameState.currentRound.hintsRevealed = action.hintIndex + 1;
                updateHintDisplay();
                // Hint penalty: deduct 1 point from the player who asked
                // (apply to last speaker, or spread across all if unclear)
                if (action.player) {
                    const hintPlayer = gameState.players.find(p =>
                        p.name.toLowerCase() === action.player.toLowerCase()
                    );
                    if (hintPlayer && hintPlayer.score > 0) {
                        hintPlayer.score -= 1;
                        updateScoreboard();
                    }
                }
            }
            break;

        case 'reveal_answer':
            // Show the answer in the UI
            showAnswer();
            break;

        case 'show_essay':
            showEssay(action.essay || gameState.currentRound.essay);
            break;

        case 'next_round':
            // Clear round display, Professor Jones will start a new round
            clearRoundDisplay();
            break;

        case 'reroll':
            clearRoundDisplay();
            break;

        case 'end_game':
            endGame();
            break;

        case 'no_action':
        default:
            break;
    }
}

// --- UI Update Functions ---

function updatePhaseUI() {
    const scoreboardEl = document.getElementById('scoreboard');
    const roundInfoEl = document.getElementById('round-info');

    if (gameState.phase === 'playing') {
        if (scoreboardEl) scoreboardEl.classList.remove('hidden');
        if (roundInfoEl) roundInfoEl.classList.remove('hidden');
    } else if (gameState.phase === 'game_over') {
        if (roundInfoEl) roundInfoEl.classList.add('hidden');
    }
}

function updateScoreboard() {
    const container = document.getElementById('scoreboard');
    if (!container) return;

    container.innerHTML = '';
    container.classList.remove('hidden');

    for (const player of gameState.players) {
        const card = document.createElement('div');
        card.className = 'player-card' + (player.isLeader ? ' leader' : '');
        card.innerHTML = `
            <span class="player-name">${player.name}${player.isLeader ? ' ★' : ''}</span>
            <span class="player-score">${player.score}</span>
        `;
        container.appendChild(card);
    }
}

function updateCategoryDisplay() {
    const el = document.getElementById('category-display');
    if (el && gameState.category) {
        el.textContent = gameState.category;
    }
}

function updateRoundDisplay() {
    const letterEl = document.getElementById('current-letter');
    const roundInfoEl = document.getElementById('round-info');
    const hintEl = document.getElementById('hint-display');
    const essayEl = document.getElementById('essay-display');

    if (letterEl) letterEl.textContent = gameState.currentRound.letter || '';
    if (roundInfoEl) roundInfoEl.classList.remove('hidden');
    if (hintEl) hintEl.classList.add('hidden');
    if (essayEl) essayEl.classList.add('hidden');
}

function updateHintDisplay() {
    const hintEl = document.getElementById('hint-display');
    const hintTextEl = document.getElementById('hint-text');
    if (!hintEl || !hintTextEl) return;

    const idx = gameState.currentRound.hintsRevealed - 1;
    if (idx >= 0 && idx < gameState.currentRound.hints.length) {
        hintTextEl.textContent = gameState.currentRound.hints[idx];
        hintEl.classList.remove('hidden');
    }
}

function showAnswer() {
    const hintEl = document.getElementById('hint-display');
    const hintTextEl = document.getElementById('hint-text');
    if (hintEl && hintTextEl) {
        hintTextEl.textContent = `The answer was: ${gameState.currentRound.answer}`;
        hintEl.classList.remove('hidden');
    }
}

function showEssay(essay) {
    const essayEl = document.getElementById('essay-display');
    const essayTextEl = document.getElementById('essay-text');
    if (essayEl && essayTextEl && essay) {
        essayTextEl.textContent = essay;
        essayEl.classList.remove('hidden');
    }
}

function clearRoundDisplay() {
    const hintEl = document.getElementById('hint-display');
    const essayEl = document.getElementById('essay-display');
    const letterEl = document.getElementById('current-letter');

    if (hintEl) hintEl.classList.add('hidden');
    if (essayEl) essayEl.classList.add('hidden');
    if (letterEl) letterEl.textContent = '';
}

// --- Transcript Panel ---

function addTranscriptEntry(sender, text, isThinking = false) {
    const panel = document.getElementById('transcript');
    if (!panel) return;

    const entry = document.createElement('div');
    entry.className = `transcript-entry ${sender}${isThinking ? ' thinking' : ''}`;

    if (sender === 'jones') {
        entry.innerHTML = `<strong>Professor Jones:</strong> ${escapeHtml(text)}`;
    } else {
        entry.innerHTML = escapeHtml(text);
    }

    panel.appendChild(entry);
    panel.scrollTop = panel.scrollHeight;
}

function removeThinkingIndicator() {
    const panel = document.getElementById('transcript');
    if (!panel) return;

    const thinking = panel.querySelector('.transcript-entry.thinking');
    if (thinking) thinking.remove();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Game Lifecycle ---

function startGame() {
    // Ensure audio is ON — clear any stale muted state from previous sessions
    if (AudioManager.muted) AudioManager.toggle();

    // Unlock audio on mobile — must happen synchronously in the tap handler
    AudioManager.unlock();

    // Reset state
    gameState.phase = 'setup_intro';
    gameState.players = [];
    gameState.roundNumber = 0;
    gameState.category = null;
    gameState.difficulty = null;
    gameState.currentRound = {
        letter: null, answer: null, hints: [], hintsRevealed: 0,
        proximity: null, nearbyLocation: null, essay: null,
        guessValidated: false
    };
    gameState.conversationHistory = [];
    gameState.previousAnswers = [];
    gameState.answerPool = [];
    gameState.poolLoading = false;

    // Start location tracking
    startLocationTracking();

    // Switch screens
    setupScreen.classList.remove('active');
    gameScreen.classList.add('active');

    // Clear transcript
    const panel = document.getElementById('transcript');
    if (panel) panel.innerHTML = '';

    // Clear scoreboard
    const scoreboard = document.getElementById('scoreboard');
    if (scoreboard) {
        scoreboard.innerHTML = '';
        scoreboard.classList.add('hidden');
    }

    // Hide round info
    const roundInfo = document.getElementById('round-info');
    if (roundInfo) roundInfo.classList.add('hidden');

    // Show immediate loading feedback so the screen isn't blank
    addTranscriptEntry('jones', 'Professor Jones is joining the trip...', true);

    // Start voice command listening
    if (AudioManager.hasSpeechRecognition && !AudioManager.muted) {
        AudioManager.startListening('command');
    }

    // Start heartbeat to keep recognition alive on mobile
    startHeartbeat();

    // Trigger Professor Jones's greeting
    sendToGamemaster('[Game session started]');
}

function endGame() {
    stopHeartbeat();
    AudioManager.stopSpeaking();
    AudioManager.stopEssay();
    AudioManager.stopListening();
    stopLocationTracking();

    // Reset UI
    const outOfCredits = document.getElementById('out-of-credits');
    if (outOfCredits) outOfCredits.classList.add('hidden');

    gameScreen.classList.remove('active');
    setupScreen.classList.add('active');

    if (typeof updateCreditsDisplay === 'function') {
        updateCreditsDisplay();
    }
}

function resetGame() {
    // Force-clear processing state
    isProcessing = false;
    retryCount = 0;
    AudioManager.stopSpeaking();
    AudioManager.clearSilenceTimer();
    removeThinkingIndicator();

    // Clear transcript
    const panel = document.getElementById('transcript');
    if (panel) panel.innerHTML = '';

    // Clear conversation history but keep game state
    gameState.conversationHistory = [];

    // Re-trigger Professor Jones
    addTranscriptEntry('jones', 'Resetting...');
    setTimeout(() => {
        removeThinkingIndicator();
        const panel2 = document.getElementById('transcript');
        if (panel2) panel2.innerHTML = '';
        sendToGamemaster('[Game reset. Greet the players and resume from current game state.]');
    }, 500);
}

// Make endGame globally accessible
window.endGame = endGame;

// --- Utility Functions ---

function speak(text) {
    AudioManager.speak(text);
}

function showOutOfCredits() {
    const modal = document.getElementById('out-of-credits');
    if (modal) modal.classList.remove('hidden');
    // Also show in transcript so user sees it even if modal is obscured
    removeThinkingIndicator();
    removeThinkingIndicator();
    addTranscriptEntry('jones', 'You\'re out of credits! Add more to keep playing.');
}

function hideOutOfCredits() {
    const modal = document.getElementById('out-of-credits');
    if (modal) modal.classList.add('hidden');
}

function updateGameCreditsDisplay(credits) {
    const display = document.getElementById('game-credits-display');
    if (display) {
        display.textContent = credits === 'unlimited' ? 'Unlimited' : credits;
    }
}

function toggleMicForGuess() {
    // If there's text in the input (e.g. from phone dictation), send it immediately
    const textInput = document.getElementById('text-input');
    if (textInput && textInput.value.trim()) {
        const text = textInput.value.trim();
        textInput.value = '';
        sendToGamemaster(text);
        return;
    }

    // Otherwise toggle listening
    if (AudioManager.isListening) {
        AudioManager.stopListening();
    } else {
        AudioManager.startListening('guess');
    }
}

function toggleAudio() {
    const wasOn = !AudioManager.muted;
    AudioManager.toggle();
    // If we just unmuted, restart speech recognition
    if (wasOn === false && !AudioManager.muted && AudioManager.hasSpeechRecognition) {
        AudioManager.startListening('command');
    }
}

function readEssayAloud() {
    if (AudioManager.isEssayPlaying) {
        AudioManager.stopEssay();
        return;
    }
    const essayText = gameState.currentRound?.essay;
    if (essayText) {
        AudioManager.speakEssay(essayText);
    }
}

// --- GPS/Location Functions ---

function startLocationTracking() {
    if (!navigator.geolocation) {
        updateLocationDisplay('GPS not supported');
        return;
    }

    updateLocationDisplay('Getting location...');

    navigator.geolocation.getCurrentPosition(
        handleLocationSuccess,
        handleLocationError,
        { enableHighAccuracy: true, timeout: 10000 }
    );

    gameState.location.watchId = navigator.geolocation.watchPosition(
        handleLocationSuccess,
        handleLocationError,
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 }
    );
    gameState.location.watching = true;
}

function stopLocationTracking() {
    if (gameState.location.watchId !== null) {
        navigator.geolocation.clearWatch(gameState.location.watchId);
        gameState.location.watchId = null;
        gameState.location.watching = false;
    }
}

function handleLocationSuccess(position) {
    gameState.location.latitude = position.coords.latitude;
    gameState.location.longitude = position.coords.longitude;
    reverseGeocode(position.coords.latitude, position.coords.longitude);
}

function handleLocationError(error) {
    let message = 'Location unavailable';
    switch (error.code) {
        case error.PERMISSION_DENIED:
            message = 'Location permission denied';
            break;
        case error.POSITION_UNAVAILABLE:
            message = 'Location unavailable';
            break;
        case error.TIMEOUT:
            message = 'Location request timed out';
            break;
    }
    updateLocationDisplay(message);
}

async function reverseGeocode(lat, lon) {
    try {
        const response = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
        const data = await response.json();

        if (data.city || data.county || data.state) {
            gameState.location.city = data.city || data.county || '';
            gameState.location.county = data.county || '';
            gameState.location.region = data.state || '';

            const locationText = (data.city || data.county) && data.state
                ? `${data.city || data.county}, ${data.state}`
                : data.city || data.county || data.state || 'Unknown location';
            updateLocationDisplay(locationText);
        }
    } catch (error) {
        updateLocationDisplay(`${lat.toFixed(2)}°, ${lon.toFixed(2)}°`);
    }
}

function updateLocationDisplay(text) {
    const locationEl = document.getElementById('location-display');
    if (locationEl) locationEl.textContent = text;
}

// --- Voice Input Handler (trigger words + direct speech) ---

const TRIGGER_WORDS = /^(send|go|play|start|begin|submit|okay|ok)$/i;

function handleVoiceInput(transcript) {
    if (!transcript) return;

    const trimmed = transcript.trim();

    // RESET — emergency stop, back to beginning
    if (/^reset$/i.test(trimmed)) {
        isProcessing = false;
        pendingTranscript = null;
        AudioManager.stopSpeaking();
        AudioManager.clearSilenceTimer();
        removeThinkingIndicator();
        resetGame();
        return;
    }

    // WAIT — stop talking, listen to the player
    if (/^wait$/i.test(trimmed)) {
        AudioManager.stopSpeaking();
        AudioManager.clearSilenceTimer();
        pendingTranscript = null;
        // If still processing a previous request, let it finish but don't speak
        sendToGamemaster('[Player said WAIT. Stop immediately. Say something brief like "Sorry, go ahead" or "I\'m listening" and then WAIT for them to speak. Do NOT continue what you were saying. Do NOT offer hints or move the game forward. Just listen.]');
        return;
    }

    // If it's a trigger word and there's text in the input, send the input text
    if (TRIGGER_WORDS.test(trimmed)) {
        const textInput = document.getElementById('text-input');
        if (textInput && textInput.value.trim()) {
            const text = textInput.value.trim();
            textInput.value = '';
            sendToGamemaster(text);
            return;
        }
    }

    // Otherwise send the spoken words directly to the gamemaster
    sendToGamemaster(trimmed);
}

// --- Recognition Heartbeat ---
// Ensures command mode stays alive on mobile where it tends to die silently.
// Checks every 3 seconds: if the game is active and we should be listening but aren't, restart.

let heartbeatInterval = null;

function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(() => {
        const gameActive = gameScreen && gameScreen.classList.contains('active');
        if (gameActive &&
            AudioManager.hasSpeechRecognition &&
            !AudioManager.muted &&
            !AudioManager.isListening &&
            !AudioManager.isSpeaking) {
            console.log('[Heartbeat] Recognition died, restarting command mode');
            AudioManager.startListening('command');
        }
    }, 5000); // Increased from 3s to 5s to reduce restart pressure
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// --- Initialize ---

document.addEventListener('DOMContentLoaded', () => {
    // AudioManager setup
    AudioManager.init();

    // Voice callback: handle trigger words + direct speech + silence
    AudioManager.setCallbacks({
        guess: (transcript) => handleVoiceInput(transcript),
        command: (transcript) => handleVoiceInput(transcript),
        silence: () => {
            // Player stayed silent after Professor Jones spoke — auto-continue
            // Guard: don't fire if we're still processing, or if Jones is still speaking
            if (!isProcessing && !AudioManager.isSpeaking) {
                sendToGamemaster('[No response — player is silent]');
            }
        }
    });

    // Audio toggle button
    const audioToggleBtn = document.getElementById('audio-toggle-btn');
    if (audioToggleBtn) {
        audioToggleBtn.addEventListener('click', toggleAudio);
    }

    // Mic button
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
        if (!AudioManager.hasSpeechRecognition) {
            micBtn.classList.add('hidden');
        } else {
            micBtn.addEventListener('click', toggleMicForGuess);
        }
    }

    // Read Aloud button
    const readAloudBtn = document.getElementById('read-aloud-btn');
    if (readAloudBtn) {
        readAloudBtn.addEventListener('click', readEssayAloud);
    }

    // Start Road Trip button
    const startBtn = document.getElementById('start-game-btn');
    if (startBtn) {
        startBtn.addEventListener('click', startGame);
    }

    // Text input + send button
    const textInput = document.getElementById('text-input');
    const sendBtn = document.getElementById('send-btn');

    if (sendBtn && textInput) {
        sendBtn.addEventListener('click', () => {
            const text = textInput.value.trim();
            if (text) {
                textInput.value = '';
                sendToGamemaster(text);
            }
        });
    }

    if (textInput) {
        textInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const text = textInput.value.trim();
                if (text) {
                    textInput.value = '';
                    sendToGamemaster(text);
                }
            }
        });
    }

    // Reset button
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetGame);
    }

    // End game listener
    const endGameBtn = document.getElementById('end-game-btn');
    if (endGameBtn) {
        endGameBtn.addEventListener('click', endGame);
    }

    // Listen for AudioManager custom events
    window.addEventListener('listening-state-change', (e) => {
        const { listening, mode } = e.detail;
        const micBtnEl = document.getElementById('mic-btn');
        const commandBar = document.getElementById('voice-command-bar');

        if (micBtnEl) {
            micBtnEl.classList.toggle('listening', listening && mode === 'guess');
        }
        if (commandBar) {
            commandBar.classList.toggle('hidden', !(listening && mode === 'command'));
        }
    });

    window.addEventListener('speech-interim', (e) => {
        const { transcript, mode } = e.detail;
        const textInputEl = document.getElementById('text-input');
        if (mode === 'guess' && textInputEl) {
            textInputEl.value = transcript;
        } else if (mode === 'command') {
            const textEl = document.getElementById('voice-command-text');
            if (textEl) textEl.textContent = transcript || 'Listening...';
        }
    });

    window.addEventListener('essay-playback-change', (e) => {
        const { playing, source } = e.detail;
        const btn = document.getElementById('read-aloud-btn');
        if (btn) {
            btn.classList.toggle('playing', playing);
            btn.textContent = playing
                ? (source === 'elevenlabs' ? 'Stop Reading (ElevenLabs)' : 'Stop Reading')
                : 'Read Aloud';
        }
    });
});
