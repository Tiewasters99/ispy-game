// I Spy Road Trip — Thin Client
// Claude (via /api/gamemaster) is the SOLE authority on game logic.
// This file: renders UI, captures voice, sends raw transcripts, executes actions.
// NO intent classification, NO guess validation, NO answer pool, NO auto-advance.

// --- Game State ---
let gameState = {
    phase: 'setup_intro',
    players: [],
    roundNumber: 0,
    category: null,
    difficulty: null,
    currentRound: {
        letter: null,
        answer: null,
        hints: [],
        hintsRevealed: 0,
        essay: null
    },
    preloadedRound: null,     // next round pre-generated in background (Opus 4)
    preloadPending: false,    // true while a prefetch is in flight
    conversationHistory: [],  // last 4 messages (2 exchanges)
    previousAnswers: [],
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
                    preloadedRound: gameState.preloadedRound
                        ? { letter: gameState.preloadedRound.letter }
                        : null,
                    location: {
                        latitude: gameState.location.latitude,
                        longitude: gameState.location.longitude,
                        city: gameState.location.city,
                        county: gameState.location.county,
                        region: gameState.location.region
                    }
                },
                conversationHistory: gameState.conversationHistory.slice(-4),
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

    // Show player's message in transcript (hide internal system messages)
    const isSystemMessage = transcript.startsWith('[');
    if (!isSystemMessage) {
        addTranscriptEntry('player', transcript);
    }

    // Show thinking indicator
    addTranscriptEntry('jones', '...', true);

    let ttsPromise = null;
    let speechHandled = false;

    let data;
    try {
        data = await callGamemaster(transcript, (speech) => {
            // Speech line arrived early — start TTS immediately
            speechHandled = true;
            ttsPromise = AudioManager.prefetchAudio(speech);
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
        removeThinkingIndicator();
        removeThinkingIndicator();
        isProcessing = false;
        addTranscriptEntry('jones', 'Having trouble connecting. Try tapping Send or speaking to retry.');
        if (pendingTranscript) {
            const queued = pendingTranscript;
            pendingTranscript = null;
            sendToGamemaster(queued);
        }
        return;
    }

    removeThinkingIndicator();
    retryCount = 0;

    // Update conversation history — keep last 4 messages (2 exchanges)
    gameState.conversationHistory.push({ role: 'user', content: transcript });
    if (data.speech) {
        gameState.conversationHistory.push({ role: 'assistant', content: data.speech });
    }
    if (gameState.conversationHistory.length > 4) {
        gameState.conversationHistory = gameState.conversationHistory.slice(-4);
    }

    // Execute actions from Claude
    if (data.actions && Array.isArray(data.actions)) {
        for (const action of data.actions) {
            executeAction(action);
        }
    }

    // Update credits display
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

    isProcessing = false;

    // Process any queued input that arrived while we were busy
    if (pendingTranscript) {
        const queued = pendingTranscript;
        pendingTranscript = null;
        sendToGamemaster(queued);
    }
}

// --- Execute structured actions from the Game Master ---
// Claude is trusted. No guessValidated gate, no client-side validation.

function executeAction(action) {
    if (!action || !action.type) return;

    switch (action.type) {
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
            break;

        case 'set_difficulty':
            gameState.difficulty = action.difficulty;
            break;

        case 'start_round': {
            // Legacy path — rounds now come via applyRoundData, but keep for safety
            applyRoundData(action);
            break;
        }

        case 'correct_guess': {
            // Trust Claude's judgment — no guessValidated gate
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
            // No state change — Professor Jones handles it verbally
            break;

        case 'reveal_hint':
            if (typeof action.hintIndex === 'number') {
                gameState.currentRound.hintsRevealed = action.hintIndex + 1;
                updateHintDisplay();
                // Hint penalty: deduct 1 point from the player who asked
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

        case 'request_new_round':
            // Claude wants a new round — use preloaded if available, otherwise fetch
            activateOrFetchRound();
            break;

        case 'deliver_preloaded_round':
            // Claude says "I spy..." and tells us to activate the preloaded round
            if (gameState.preloadedRound) {
                applyRoundData(gameState.preloadedRound);
                gameState.preloadedRound = null;
            }
            break;

        case 'reveal_answer':
            showAnswer();
            break;

        case 'show_essay':
            showEssay(action.essay || gameState.currentRound.essay);
            break;

        case 'end_game':
            endGame();
            break;

        case 'no_action':
        default:
            break;
    }
}

// --- Round Pre-Generation (Opus 4, background) ---

async function prefetchNextRound() {
    if (gameState.preloadedRound || gameState.preloadPending) return;
    gameState.preloadPending = true;

    try {
        const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

        const response = await fetch('/api/generate-round', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user?.id || null,
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
            })
        });

        if (!response.ok) {
            console.warn('[Prefetch] Failed:', response.status);
            gameState.preloadPending = false;
            return;
        }

        const round = await response.json();
        gameState.preloadedRound = round;
        gameState.preloadPending = false;
        console.log('[Prefetch] Next round ready:', round.letter, round.answer);

        if (round.remainingCredits !== null && round.remainingCredits !== undefined) {
            updateGameCreditsDisplay(round.remainingCredits);
        }
    } catch (err) {
        console.warn('[Prefetch] Error:', err);
        gameState.preloadPending = false;
    }
}

/**
 * Activate a pre-loaded round or fetch one on demand.
 * Called when Claude emits request_new_round.
 */
async function activateOrFetchRound() {
    if (gameState.preloadedRound) {
        // Instant — round was pre-generated while essay played
        const round = gameState.preloadedRound;
        gameState.preloadedRound = null;
        applyRoundData(round);
        // Announce it — play the speech that came with the round
        if (round.speech) {
            addTranscriptEntry('jones', round.speech);
            const tts = AudioManager.prefetchAudio(round.speech);
            AudioManager.playPrefetched(tts).catch(e =>
                console.warn('[Game] TTS error:', e)
            );
        }
        return;
    }

    // No preloaded round — fetch one now (blocking but with loading feedback)
    addTranscriptEntry('jones', 'Let me think of a good one...', true);

    try {
        const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

        const response = await fetch('/api/generate-round', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user?.id || null,
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
            })
        });

        removeThinkingIndicator();

        if (response.status === 402) {
            showOutOfCredits();
            return;
        }

        if (!response.ok) {
            addTranscriptEntry('jones', 'Had trouble coming up with one. Try asking me again.');
            return;
        }

        const round = await response.json();
        applyRoundData(round);

        if (round.speech) {
            addTranscriptEntry('jones', round.speech);
            const tts = AudioManager.prefetchAudio(round.speech);
            AudioManager.playPrefetched(tts).catch(e =>
                console.warn('[Game] TTS error:', e)
            );
        }

        if (round.remainingCredits !== null && round.remainingCredits !== undefined) {
            updateGameCreditsDisplay(round.remainingCredits);
        }
    } catch (err) {
        removeThinkingIndicator();
        addTranscriptEntry('jones', 'Having trouble. Try saying "next round" again.');
        console.error('[Game] On-demand round fetch failed:', err);
    }
}

/**
 * Apply round data to game state and update UI.
 */
function applyRoundData(round) {
    const letter = (round.letter || '').toUpperCase();
    const answer = round.answer || '';

    // Safety: validate letter match
    if (answer && letter && answer[0].toUpperCase() !== letter) {
        console.warn(`[Game] Letter mismatch: "${answer}" for "${letter}" — skipping`);
        return;
    }

    gameState.phase = 'playing';
    gameState.roundNumber++;
    gameState.currentRound = {
        letter: letter,
        answer: answer,
        hints: round.hints || [],
        hintsRevealed: 0,
        essay: round.essay || null
    };

    if (answer && !gameState.previousAnswers.includes(answer)) {
        gameState.previousAnswers.push(answer);
    }

    updateRoundDisplay();
    updatePhaseUI();

    // Immediately start generating the NEXT round in the background.
    // Player will spend 30+ seconds guessing — plenty of time for Opus.
    gameState.preloadedRound = null;
    gameState.preloadPending = false;
    prefetchNextRound();
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
    // Ensure audio is ON
    if (AudioManager.muted) AudioManager.toggle();

    // Unlock audio on mobile
    AudioManager.unlock();

    // Reset state
    gameState.phase = 'setup_intro';
    gameState.players = [];
    gameState.roundNumber = 0;
    gameState.category = null;
    gameState.difficulty = null;
    gameState.currentRound = {
        letter: null, answer: null, hints: [], hintsRevealed: 0, essay: null
    };
    gameState.preloadedRound = null;
    gameState.preloadPending = false;
    gameState.conversationHistory = [];
    gameState.previousAnswers = [];

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

    // Show immediate loading feedback
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
    // If there's text in the input, send it immediately
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

// --- Voice Input Handler ---
// Raw transcript goes straight to gamemaster. No preprocessing, no intent classification.

const TRIGGER_WORDS = /^(send|go|play|start|begin|submit|okay|ok)$/i;

function handleVoiceInput(transcript) {
    if (!transcript) return;

    const trimmed = transcript.trim();

    // RESET — emergency stop
    if (/^reset$/i.test(trimmed)) {
        isProcessing = false;
        pendingTranscript = null;
        AudioManager.stopSpeaking();
        AudioManager.clearSilenceTimer();
        removeThinkingIndicator();
        resetGame();
        return;
    }

    // WAIT — stop talking, listen
    if (/^wait$/i.test(trimmed)) {
        AudioManager.stopSpeaking();
        AudioManager.clearSilenceTimer();
        pendingTranscript = null;
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

    // Send raw transcript directly to gamemaster — Claude interprets everything
    sendToGamemaster(trimmed);
}

// --- Recognition Heartbeat ---

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
    }, 5000);
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

    // Voice callback: send raw transcript to gamemaster
    AudioManager.setCallbacks({
        guess: (transcript) => handleVoiceInput(transcript),
        command: (transcript) => handleVoiceInput(transcript),
        silence: () => {
            // Player stayed silent after Professor Jones spoke — let Claude decide what to do
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
