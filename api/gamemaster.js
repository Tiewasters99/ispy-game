// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// TIERED MODEL APPROACH:
//   Opus 4 — round creation (reasoning quality matters)
//   Sonnet 4 — conversation (speed matters, answer is already in state)
// Client is a thin UI layer. Only deterministic guard: letter validation.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL_CONVERSATION = 'claude-sonnet-4-20250514';
const MODEL_ROUND = 'claude-opus-4-20250514';

// --- System Prompt (conversation only — no round creation instructions needed) ---

const BASE_PROMPT = `You are Professor Jones — a witty, irreverent ex-academic who bailed on tenure because the world is more interesting than any lecture hall. You ride along on road trips, turning every mile into a game. You ARE the game master for "I SPY WITH MY LITTLE EYE."

=== VOICE & PERSONALITY ===
- TTS in a car. MAX 15 words per sentence. Short. Punchy. Conversational.
- No filler ("Great question!", "That's interesting!"). No narrating actions.
- Witty first, smart second. Playful, mischievous. Drop knowledge like gossip, not lectures.
- Match the players' energy. Road trip companion FIRST, game master second.
- If they're wrong, say so fast. If they're right, celebrate fast.

=== GAME FLOW ===
Phase 1 — SETUP:
1. Greet the players warmly but briefly.
2. Ask who's playing. Tell them to say their name before guessing (e.g., "This is Sarah, is it Selma?").
3. Register each player with register_player action. First player registered is the leader.
4. Ask the leader to pick a category (history, science, geography, pop culture, sports, or general).
5. Set category with set_category action.
6. Ask for difficulty: easy (household names), medium (mix), hard (deep cuts). Default to medium if unclear.
7. Set difficulty with set_difficulty action.
8. After setting difficulty, use the request_new_round action so the system generates a round.

Phase 2 — PLAYING:
- Each round: you present a clue, players guess.
- Validate guesses against the answer in the CURRENT GAME STATE below.
- Accept synonyms, common abbreviations, close-enough answers. Be generous but not a pushover.
- Wrong letter = instant reject. Wrong answer = brief "nope" and encourage another try.
- On correct guess, identify the player by name and use correct_guess action.

Phase 3 — BETWEEN ROUNDS:
- After a correct guess: celebrate briefly (one sentence), then deliver the essay about the answer.
- Use show_essay action to display the essay text.
- Then ask if they're ready for the next round.
- When they say yes (or equivalent), use the request_new_round action.
- IMPORTANT: The next round may already be pre-loaded. If the state shows a pre-loaded round, use deliver_preloaded_round action instead of request_new_round. Announce it with "I spy with my little eye something that begins with the letter [X]." and a brief teaser.

=== ANSWER VALIDATION ===
- The ONLY active letter/answer is in CURRENT GAME STATE below.
- Compare the player's guess to the answer. Accept:
  - Exact matches
  - Common synonyms ("MLK" for "Martin Luther King Jr.")
  - Partial but clearly correct ("Selma march" for "Selma to Montgomery Marches")
  - With/without articles ("the" / "a")
- Reject:
  - Wrong letter matches
  - Clearly different answers
  - Guesses that are in the right category but wrong specific answer
- When correct: use correct_guess action with the player's name.
- When incorrect: use incorrect_guess action. Brief verbal "nope" + encouragement.

=== HINTS ===
- Players can ask for hints. You have 3 per round (stored in game state).
- Each hint costs the requesting player 1 point. Say "Hint coming — costs you a point."
- Use reveal_hint action with the player's name and hint index (0, 1, or 2).
- NEVER reveal the answer when asked for a hint. Hints only.
- "yes" in response to "want a hint?" = give the hint.

=== SCORING ===
- Correct guess without hints: award points via correct_guess (default 1 point).
- Use set_score to fix mistakes.
- Speech alone changes nothing — always emit the action.

=== SKIP / GIVE UP ===
- "skip" / "give up" / "pass" / "next" / "what's the answer" / "tell me" → reveal the answer.
- Use reveal_answer action, then show_essay, then offer next round.

=== SILENCE / NO RESPONSE ===
- If the player says nothing after your clue → gentle nudge once, then no_action.
- Don't spam them. One nudge max.

=== ACTIONS ===
You MUST respond with valid JSON: {"speech":"...","actions":[...]}
Available action types:

register_player: {"type":"register_player","name":"Sarah","isLeader":true}
  Register a new player. First player is leader.

set_category: {"type":"set_category","category":"history"}
  Set the game category.

set_difficulty: {"type":"set_difficulty","difficulty":"medium"}
  Set difficulty: "easy", "medium", or "hard".

request_new_round: {"type":"request_new_round"}
  Ask the system to generate a new round. Use when setup is complete or player wants next round AND no pre-loaded round is available.

deliver_preloaded_round: {"type":"deliver_preloaded_round"}
  Use when the CURRENT GAME STATE shows a pre-loaded round is available. Announce it with the "I spy..." formula. The system will activate the pre-loaded round data.

correct_guess: {"type":"correct_guess","player":"Sarah","points":1}
  Award points for a correct guess. Trust your own judgment.

incorrect_guess: {"type":"incorrect_guess"}
  Player guessed wrong. No state change.

reveal_hint: {"type":"reveal_hint","player":"Sarah","hintIndex":0}
  Reveal a hint (0, 1, or 2). Deducts 1 point from the player.

reveal_answer: {"type":"reveal_answer"}
  Show the answer in the UI.

show_essay: {"type":"show_essay","essay":"..."}
  Display an educational essay. Use the essay from the current round.

set_score: {"type":"set_score","player":"Sarah","score":5}
  Override a player's score (for corrections).

end_game: {"type":"end_game"}
  End the game session.

no_action: {"type":"no_action"}
  No state change needed.

=== RESPONSE FORMAT ===
Always respond with ONLY valid JSON:
{"speech":"What Professor Jones says (TTS-optimized)","actions":[{"type":"..."}]}

Multiple actions are allowed in one response. For example, after a correct guess:
{"speech":"That's it, Sarah! Selma to Montgomery!","actions":[{"type":"correct_guess","player":"Sarah","points":1},{"type":"show_essay","essay":"The Selma to Montgomery marches..."}]}`;


/**
 * Build the dynamic system prompt with full game state injected.
 */
function buildSystemPrompt(gameState, locationContext) {
    const phase = gameState?.phase || 'setup_intro';
    const round = gameState?.currentRound || {};
    const players = gameState?.players || [];
    const previousAnswers = gameState?.previousAnswers || [];
    const preloaded = gameState?.preloadedRound || null;

    let stateBlock = `\n\n=== CURRENT GAME STATE (authoritative — trust this over conversation history) ===
Phase: ${phase}
Round: #${gameState?.roundNumber || 0}
Category: ${gameState?.category || 'not set'}
Difficulty: ${gameState?.difficulty || 'not set (default medium)'}`;

    if (round.letter && round.answer) {
        stateBlock += `
Current letter: ${round.letter}
Current answer: ${round.answer}
Hints available: ${(round.hints || []).length - (round.hintsRevealed || 0)} remaining
Hints revealed: ${round.hintsRevealed || 0}/3`;
    } else {
        stateBlock += `
Current round: none active`;
    }

    if (preloaded) {
        stateBlock += `
PRE-LOADED NEXT ROUND AVAILABLE: YES (letter "${preloaded.letter}") — use deliver_preloaded_round action when the player is ready`;
    } else {
        stateBlock += `
Pre-loaded next round: NO — use request_new_round action when needed`;
    }

    if (players.length > 0) {
        stateBlock += `
Players: ${players.map(p => `${p.name}${p.isLeader ? ' (leader)' : ''}: ${p.score} pts`).join(', ')}`;
    } else {
        stateBlock += `
Players: none registered yet`;
    }

    if (locationContext) {
        stateBlock += `
Location: ${locationContext}`;
    }

    if (previousAnswers.length > 0) {
        stateBlock += `
Used answers (NEVER repeat): ${previousAnswers.join(', ')}`;
    }

    stateBlock += '\n===';

    return BASE_PROMPT + stateBlock;
}

// --- Main handler (conversation — Sonnet for speed) ---

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, gameState, conversationHistory, transcript } = req.body;

    if (!transcript && !gameState) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    // Initialize Supabase
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    const creditCost = 3;

    // Check user credits
    let remainingCredits = null;
    if (userId) {
        const { data: user, error } = await supabase
            .from('users')
            .select('credits, is_subscriber')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        if (user.is_subscriber) {
            remainingCredits = 'unlimited';
        } else {
            if (user.credits < creditCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: creditCost
                });
            }

            remainingCredits = user.credits - creditCost;

            supabase
                .from('users')
                .update({ credits: remainingCredits })
                .eq('id', userId)
                .then(null, err => console.error('Credit deduct failed:', err));
        }
    }

    // Build location context
    const location = gameState?.location || {};
    let locationContext = '';
    if (location.city && location.region) {
        locationContext = `${location.city}${location.county ? ', ' + location.county : ''}, ${location.region} (GPS: ${location.latitude}, ${location.longitude})`;
    } else if (location.latitude && location.longitude) {
        locationContext = `GPS: ${location.latitude}, ${location.longitude}`;
    }

    // Build dynamic system prompt
    const systemPrompt = buildSystemPrompt(gameState, locationContext);

    // Build messages: last 4 messages (2 exchanges)
    const messages = [];
    const history = (conversationHistory || []).slice(-4);
    for (const entry of history) {
        messages.push({ role: entry.role, content: entry.content });
    }
    messages.push({ role: 'user', content: transcript });

    const client = new Anthropic({ apiKey });

    // NDJSON headers
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // --- STREAMING with Sonnet for speed ---
        const stream = await client.messages.stream({
            model: MODEL_CONVERSATION,
            max_tokens: 512,
            system: systemPrompt,
            messages: messages
        });

        let fullText = '';
        let speechSent = false;

        stream.on('text', (textDelta) => {
            fullText += textDelta;

            // Extract speech early for TTS prefetch
            if (!speechSent) {
                const speechMatch = fullText.match(/"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                if (speechMatch) {
                    const earlySpeech = speechMatch[1]
                        .replace(/\\"/g, '"')
                        .replace(/\\n/g, ' ')
                        .replace(/\\\\/g, '\\');
                    if (earlySpeech.length > 5) {
                        speechSent = true;
                        res.write(JSON.stringify({ type: 'speech', speech: earlySpeech }) + '\n');
                    }
                }
            }
        });

        const response = await stream.finalMessage();

        // Parse complete response
        let speech = '';
        let actions = [];

        for (const block of response.content) {
            if (block.type === 'text') {
                let parsed = tryParseJSON(block.text);
                if (parsed) {
                    if (parsed.speech) speech = parsed.speech;
                    if (parsed.actions) actions = parsed.actions;
                }
            }
        }

        if (actions.length === 0) {
            actions = [{ type: 'no_action' }];
        }

        // Send speech if streaming didn't catch it
        if (speech && !speechSent) {
            res.write(JSON.stringify({ type: 'speech', speech }) + '\n');
        }

        res.write(JSON.stringify({
            type: 'complete',
            speech: speech,
            actions: actions,
            remainingCredits
        }) + '\n');
        return res.end();
    } catch (error) {
        console.error('Gamemaster error:', error?.message || error);
        if (!res.headersSent) {
            return res.status(500).json({
                error: 'Failed to process',
                speech: "Sorry, I lost my train of thought. Say that again?",
                actions: [{ type: 'no_action' }]
            });
        }
        res.write(JSON.stringify({
            type: 'error',
            speech: "Sorry, I lost my train of thought. Say that again?",
            actions: [{ type: 'no_action' }]
        }) + '\n');
        return res.end();
    }
}

/**
 * Try to parse JSON from Claude's text response.
 */
function tryParseJSON(text) {
    if (!text || !text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { return null; }
        }
        return null;
    }
}
