// I Spy Road Trip — Conversational Game Master Client
// All game logic handled by Claude as Professor Jones via /api/gamemaster

// Game State
let gameState = {
    phase: 'setup_intro',
    players: [],
    roundNumber: 0,
    category: null,
    currentRound: {
        letter: null,
        answer: null,
        hints: [],
        hintsRevealed: 0,
        proximity: null,
        nearbyLocation: null,
        essay: null
    },
    conversationHistory: [],
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

async function sendToGamemaster(transcript) {
    if (isProcessing || !transcript) return;
    isProcessing = true;

    // Show thinking indicator
    addTranscriptEntry('player', transcript);
    addTranscriptEntry('jones', '...', true); // thinking indicator

    try {
        const user = typeof supabase !== 'undefined' ? supabase.auth.getUser() : null;

        const response = await fetch('/api/gamemaster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user?.id || null,
                gameState: {
                    phase: gameState.phase,
                    players: gameState.players,
                    currentRound: gameState.currentRound,
                    roundNumber: gameState.roundNumber,
                    category: gameState.category,
                    location: {
                        latitude: gameState.location.latitude,
                        longitude: gameState.location.longitude,
                        city: gameState.location.city,
                        county: gameState.location.county,
                        region: gameState.location.region
                    }
                },
                conversationHistory: gameState.conversationHistory.slice(-40),
                transcript: transcript
            })
        });

        // Remove thinking indicator
        removeThinkingIndicator();

        // Handle insufficient credits
        if (response.status === 402) {
            showOutOfCredits();
            isProcessing = false;
            return;
        }

        if (!response.ok) {
            speak("Sorry, I lost my train of thought. Say that again?");
            addTranscriptEntry('jones', "Sorry, I lost my train of thought. Say that again?");
            isProcessing = false;
            return;
        }

        const data = await response.json();

        // Update conversation history
        gameState.conversationHistory.push({ role: 'user', content: transcript });
        gameState.conversationHistory.push({ role: 'assistant', content: data.speech });

        // Trim history to last 40 messages (20 exchanges)
        if (gameState.conversationHistory.length > 40) {
            gameState.conversationHistory = gameState.conversationHistory.slice(-40);
        }

        // Execute all actions
        if (data.actions && Array.isArray(data.actions)) {
            for (const action of data.actions) {
                executeAction(action);
            }
        }

        // Update credits display
        if (data.remainingCredits !== null && data.remainingCredits !== undefined) {
            updateGameCreditsDisplay(data.remainingCredits);
        }

        // Show Professor Jones's response in transcript
        addTranscriptEntry('jones', data.speech);

        // Speak the response
        speak(data.speech);

        // Safety net: if category is set but Claude didn't generate a clue yet,
        // auto-trigger clue generation (Claude sometimes splits "let me look around..." and the actual clue)
        // This catches both: phase already 'playing' with no clue, AND truncated responses where set_phase was lost
        if (gameState.category && !gameState.currentRound.answer && gameState.phase !== 'setup_intro') {
            isProcessing = false;
            setTimeout(() => sendToGamemaster('[Now generate the I Spy clue. Include a start_round action with letter, answer, hints, essay, proximity.]'), 1500);
            return;
        }

    } catch (error) {
        console.warn('Gamemaster error:', error);
        removeThinkingIndicator();
        speak("Sorry, I lost my train of thought. Say that again?");
        addTranscriptEntry('jones', "Sorry, I lost my train of thought. Say that again?");
    }

    isProcessing = false;
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
            break;

        case 'start_round':
            gameState.roundNumber++;
            gameState.currentRound = {
                letter: action.letter,
                answer: action.answer,
                hints: action.hints || [],
                hintsRevealed: 0,
                proximity: action.proximity || 'region',
                nearbyLocation: action.nearbyLocation || null,
                essay: action.essay || null
            };
            updateRoundDisplay();
            break;

        case 'correct_guess': {
            const player = gameState.players.find(p =>
                p.name.toLowerCase() === (action.player || '').toLowerCase()
            );
            if (player) {
                player.score += (action.points || 1);
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
    // Reset state
    gameState.phase = 'setup_intro';
    gameState.players = [];
    gameState.roundNumber = 0;
    gameState.category = null;
    gameState.currentRound = {
        letter: null, answer: null, hints: [], hintsRevealed: 0,
        proximity: null, nearbyLocation: null, essay: null
    };
    gameState.conversationHistory = [];

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

    // Start voice command listening
    if (AudioManager.hasSpeechRecognition && !AudioManager.muted) {
        AudioManager.startListening('command');
    }

    // Trigger Professor Jones's greeting
    sendToGamemaster('[Game session started]');
}

function endGame() {
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

// Make endGame globally accessible
window.endGame = endGame;

// --- Utility Functions ---

function speak(text) {
    AudioManager.speak(text);
}

function showOutOfCredits() {
    const modal = document.getElementById('out-of-credits');
    if (modal) modal.classList.remove('hidden');
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
    if (AudioManager.isListening) {
        AudioManager.stopListening();
    } else {
        AudioManager.startListening('guess');
    }
}

function toggleAudio() {
    AudioManager.toggle();
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

// --- Initialize ---

document.addEventListener('DOMContentLoaded', () => {
    // AudioManager setup
    AudioManager.init();

    // Both voice modes route raw transcript to sendToGamemaster
    AudioManager.setCallbacks({
        guess: (transcript) => sendToGamemaster(transcript),
        command: (transcript) => sendToGamemaster(transcript)
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
