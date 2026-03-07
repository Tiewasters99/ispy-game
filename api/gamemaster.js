// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Claude is the SOLE authority on game logic. The client is a thin UI layer.
// Only deterministic guard: letter validation on round creation.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// --- System Prompt ---
// This is the ONLY thing controlling game logic. It must be thorough.

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
8. Immediately deliver the first clue by calling the create_round tool.

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
- When they say yes (or equivalent), call create_round for a new round.

=== CREATING ROUNDS ===
- ALWAYS use the create_round tool. Never announce a letter without calling it.
- Speech MUST begin with "I spy with my little eye something that begins with the letter [X]."
- Follow with a brief, witty teaser (1 sentence max).

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

start_round: NEVER emit this directly — it's generated from the create_round tool.

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
 * This is the SINGLE SOURCE OF TRUTH for Claude.
 */
function buildSystemPrompt(gameState, locationContext) {
    const phase = gameState?.phase || 'setup_intro';
    const round = gameState?.currentRound || {};
    const players = gameState?.players || [];
    const previousAnswers = gameState?.previousAnswers || [];

    let stateBlock = `\n\n=== CURRENT GAME STATE (authoritative — trust this over conversation history) ===
Phase: ${phase}
Round: #${gameState?.roundNumber || 0}
Category: ${gameState?.category || 'not set'}
Difficulty: ${gameState?.difficulty || 'not set (default medium)'}`;

    if (round.letter && round.answer) {
        stateBlock += `
Current letter: ${round.letter}
Current answer: ${round.answer}
Hints revealed: ${round.hintsRevealed || 0}/3`;
    } else {
        stateBlock += `
Current round: none active`;
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

// --- Tool definition for structured round generation ---
const TOOLS = [
    {
        name: 'create_round',
        description: 'Create a new I Spy round with a letter, answer, hints, and essay. The answer MUST start with the given letter. The system will validate this automatically.',
        input_schema: {
            type: 'object',
            properties: {
                letter: {
                    type: 'string',
                    description: 'A single uppercase letter (A-Z) for this round'
                },
                answer: {
                    type: 'string',
                    description: 'The answer that players must guess. MUST start with the given letter.'
                },
                hints: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Exactly 3 hints, ordered from vague to specific',
                    minItems: 3,
                    maxItems: 3
                },
                essay: {
                    type: 'string',
                    description: 'A 2-3 sentence fun fact essay about the answer'
                },
                proximity: {
                    type: 'string',
                    enum: ['here', 'nearby', 'region'],
                    description: 'How close the answer is to the players GPS location'
                },
                nearbyLocation: {
                    type: 'string',
                    description: 'If proximity is nearby, the name of the nearby location'
                },
                speech: {
                    type: 'string',
                    description: 'What Professor Jones says when presenting this clue. MUST begin with "I spy with my little eye something that begins with the letter [X]." followed by a brief teaser.'
                }
            },
            required: ['letter', 'answer', 'hints', 'essay', 'proximity', 'speech']
        }
    }
];

// --- Main handler ---

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

    // Determine credit cost: 10 for round-starting calls, 3 for follow-ups
    const isRoundStart = gameState?.phase === 'playing' &&
        (!gameState.currentRound?.answer || transcript === '[Start next round]' || transcript === '[Game session started]');
    const creditCost = isRoundStart ? 10 : 3;

    // Check user credits and deduct if userId provided
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

    const previousAnswers = gameState?.previousAnswers || [];

    // Build dynamic system prompt with full state
    const systemPrompt = buildSystemPrompt(gameState, locationContext);

    // Build messages: last 4 messages (2 exchanges) for conversational continuity
    // e.g. "want a hint?" → "yes" works because both messages are in history
    const messages = [];
    const history = (conversationHistory || []).slice(-4);
    for (const entry of history) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }

    // Current user message — raw transcript, no annotations
    messages.push({
        role: 'user',
        content: transcript
    });

    const client = new Anthropic({ apiKey });

    // Set NDJSON headers
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // Call Claude with tools available
        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages,
            tools: TOOLS
        });

        // Process the response — may contain text, tool_use, or both
        let speech = '';
        let actions = [];
        let toolUseBlock = null;

        for (const block of response.content) {
            if (block.type === 'text') {
                // Parse the JSON text response for speech and actions
                let parsed = tryParseJSON(block.text);
                if (parsed) {
                    if (parsed.speech) speech = parsed.speech;
                    if (parsed.actions) actions = parsed.actions;
                }
            } else if (block.type === 'tool_use' && block.name === 'create_round') {
                toolUseBlock = block;
            }
        }

        // If Claude called create_round, validate and convert to start_round action
        if (toolUseBlock) {
            const round = toolUseBlock.input;
            const letter = (round.letter || '').toUpperCase();
            const answer = round.answer || '';

            // DETERMINISTIC VALIDATION: answer must start with the letter
            if (answer && letter && answer[0].toUpperCase() === letter) {
                // Valid — convert to start_round action
                actions.push({
                    type: 'start_round',
                    letter: letter,
                    answer: answer,
                    hints: round.hints || [],
                    essay: round.essay || '',
                    proximity: round.proximity || 'region',
                    nearbyLocation: round.nearbyLocation || null
                });

                // Use speech from the tool call if main speech is empty
                if (!speech && round.speech) {
                    speech = round.speech;
                }
            } else {
                // LETTER MISMATCH — retry with explicit correction
                console.warn(`[Gamemaster] Letter mismatch: "${answer}" doesn't start with "${letter}". Retrying...`);

                const retryResult = await retryRoundGeneration(client, letter, previousAnswers, gameState, locationContext);
                if (retryResult) {
                    actions.push({
                        type: 'start_round',
                        letter: retryResult.letter,
                        answer: retryResult.answer,
                        hints: retryResult.hints || [],
                        essay: retryResult.essay || '',
                        proximity: retryResult.proximity || 'region',
                        nearbyLocation: retryResult.nearbyLocation || null
                    });
                    if (!speech && retryResult.speech) {
                        speech = retryResult.speech;
                    }
                } else {
                    // Retry also failed — try a different letter entirely
                    speech = speech || "Hmm, let me try a different letter.";
                    const usedLetters = previousAnswers.map(a => a[0]?.toUpperCase()).filter(Boolean);
                    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !usedLetters.includes(l));
                    const fallbackLetter = available.length > 0
                        ? available[Math.floor(Math.random() * available.length)]
                        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];

                    const fallbackResult = await retryRoundGeneration(client, fallbackLetter, previousAnswers, gameState, locationContext);
                    if (fallbackResult) {
                        actions.push({
                            type: 'start_round',
                            letter: fallbackResult.letter,
                            answer: fallbackResult.answer,
                            hints: fallbackResult.hints || [],
                            essay: fallbackResult.essay || '',
                            proximity: fallbackResult.proximity || 'region',
                            nearbyLocation: fallbackResult.nearbyLocation || null
                        });
                        speech = fallbackResult.speech || speech;
                    }
                }
            }
        }

        // If no actions parsed, default to no_action
        if (actions.length === 0) {
            actions = [{ type: 'no_action' }];
        }

        // Send speech early for TTS prefetch
        if (speech) {
            res.write(JSON.stringify({ type: 'speech', speech }) + '\n');
        }

        // Send complete response
        res.write(JSON.stringify({
            type: 'complete',
            speech: speech,
            actions: actions,
            remainingCredits
        }) + '\n');
        return res.end();
    } catch (error) {
        console.error('Gamemaster error:', error?.message || error, error?.status || '');
        if (!res.headersSent) {
            return res.status(500).json({
                error: 'Failed to process',
                detail: error?.message || String(error),
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
 * Retry round generation with a specific letter using forced tool_choice.
 * Returns validated round data or null.
 */
async function retryRoundGeneration(client, letter, previousAnswers, gameState, locationContext) {
    const prevAnswersList = previousAnswers.length > 0 ? previousAnswers.join(', ') : 'none';
    const category = gameState?.category || 'general';
    const difficulty = gameState?.difficulty || 'medium';

    const retryMessages = [
        {
            role: 'user',
            content: `Generate an I Spy round for the letter "${letter}". Category: ${category}. Difficulty: ${difficulty}. Location: ${locationContext || 'Unknown'}. Already used answers (do NOT repeat): ${prevAnswersList}. The answer MUST start with the letter "${letter}". Call the create_round tool.`
        }
    ];

    try {
        const retryResponse = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 512,
            system: 'You generate I Spy game rounds. Always use the create_round tool. The answer MUST start with the specified letter. Begin your speech with "I spy with my little eye something that begins with the letter [X]." followed by a brief teaser.',
            messages: retryMessages,
            tools: TOOLS,
            tool_choice: { type: 'tool', name: 'create_round' }
        });

        for (const block of retryResponse.content) {
            if (block.type === 'tool_use' && block.name === 'create_round') {
                const round = block.input;
                const roundLetter = (round.letter || '').toUpperCase();
                const roundAnswer = round.answer || '';

                if (roundAnswer && roundLetter && roundAnswer[0].toUpperCase() === roundLetter) {
                    return { ...round, letter: roundLetter };
                }
                console.warn(`[Gamemaster] Retry also mismatched: "${roundAnswer}" for letter "${roundLetter}"`);
            }
        }
    } catch (err) {
        console.error('[Gamemaster] Retry failed:', err?.message || err);
    }
    return null;
}

/**
 * Try to parse JSON from Claude's text response.
 * Handles both clean JSON and JSON embedded in other text.
 */
function tryParseJSON(text) {
    if (!text || !text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                return null;
            }
        }
        return null;
    }
}
