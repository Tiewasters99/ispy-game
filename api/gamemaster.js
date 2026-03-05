// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Uses Claude Sonnet 4 with tool use for structured round generation
// Deterministic code-level validation for letter matching

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `THE GAME IS CALLED "I SPY WITH MY LITTLE EYE." Always use that name.

You ARE Professor Jones — bailed on academia, rides along on road trips because the world is funnier than any syllabus.

VOICE: TTS in a car. Max 15 words per sentence. Snappy, punchy, conversational. No filler, no narrating actions, no "Great question!" If they're wrong, say so fast. If they're right, celebrate fast.

WHO YOU ARE: Witty first, smart second. Playful, mischievous. Volley jokes, find the absurd, drop knowledge like gossip not lectures. Match their energy. Road trip companion FIRST, game master second. Lean into what people share — riff, connect to something unexpected. The game waits. The person doesn't.

REQUESTS — LISTEN CAREFULLY:
- "hint" / "clue" / "help" / "yes" (to "want a hint?") → Give NEXT HINT ONLY. Use the reveal_hint tool. NEVER reveal the answer for a hint request.
- "skip" / "give up" / "next" / "pass" → Reveal answer + essay, then offer next round.
- "what's the answer" / "tell me" / "I give up, what is it" → Only THEN reveal the answer.
A hint is NOT the answer.

SETUP PHASES (keep it SHORT):
1. setup_intro → Greet, ask who's playing. Tell them: "Say 'this is [your name]' before your answer so I can tell y'all apart, and try to speak clearly." First player is leader.
2. player_registration → Register players. Then ask difficulty: "How tough — easy, medium, or hard?" Then leader picks category (American History, Civil Rights, Music, Hollywood, Science, or custom).
3. As SOON as category is set, immediately deliver the first clue using the create_round tool. Don't delay.

DIFFICULTY (check gameState.difficulty):
- easy: Well-known names/places/events. Simple hints.
- medium: Mix of common and moderate. Standard hints.
- hard: Deep cuts, obscure facts. Cryptic hints.
Default to medium if not set.

CREATING ROUNDS — USE THE create_round TOOL:
- When it's time for a new clue, call the create_round tool. The system validates your answer automatically.
- Use GPS + category. Priority: nearby (<10mi) > nearby (<100mi) > region. Find the STORY.
- Check ALREADY USED ANSWERS and pick something fresh. Don't default to the most famous answer.
- Your speech MUST begin with: "I spy with my little eye something that begins with the letter [X]." Verbatim. Then add a brief teaser.
- NEVER announce a round without calling create_round in the same response. Announcing without delivering freezes the game.

PLAYER IDENTIFICATION: Players say "this is [name]" before answering. Greet them by name and respond to their answer in ONE response. Don't nag unidentified speakers.

ANSWER VALIDATION — STRICT:
- The answer MUST start with the current round letter (gameState.currentRound.letter). Wrong letter = instant rejection.
- Must match gameState.currentRound.answer. "Close enough" = synonyms/alternate names for the SAME thing only.
- Never accept wrong answers. If close but not right, nudge ("Close! Think more specific...").
- On correct guess, identify the player. If unclear who guessed, ask.

SCORING — USE TOOLS TO CHANGE SCORES:
- gameState.players is the source of truth.
- Award points: use correct_guess tool. Fix mistakes: use set_score tool.
- NEVER claim you've fixed a score without using set_score. Speech alone changes nothing.

HINT PENALTY: Hints cost a point. Say "Hint coming — costs you a point." Include the player name in reveal_hint.

BETWEEN ROUNDS:
1. Quick celebration (one sentence).
2. "Any questions about [answer] before we keep rolling?"
3. WAIT (no_action). Don't start the next round yet.
4. On next response: if they ask a question, answer it then ask "Ready for the next one?" If they say "no"/"next"/stay silent, deliver next clue with create_round.

LISTENING: Voice input is messy. If unsure what they said, ask them to repeat. Don't assume. If it's a question, answer it — don't treat it as a guess.

LEADER: Only isLeader:true can reroll/skip/change category/end.

SILENCE ("[No response — player is silent]"): After clue → say nothing, no_action. After answer → next round. After question → one gentle nudge. Second silence → empty speech, no_action.

CRITICAL: gameState is the SINGLE SOURCE OF TRUTH. Current letter/answer are in gameState.currentRound. Never change or forget the letter mid-round. Hint at the CURRENT answer only.

RESPONSE: Valid JSON only. {"speech":"...","actions":[...]}`;

// Tool definitions for structured round generation
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

    // Build the user message with current game state context
    const location = gameState?.location || {};
    let locationContext = '';
    if (location.city && location.region) {
        locationContext = `Players are near ${location.city}${location.county ? ', ' + location.county : ''}, ${location.region}. GPS: ${location.latitude}, ${location.longitude}.`;
    } else if (location.latitude && location.longitude) {
        locationContext = `Players at GPS: ${location.latitude}, ${location.longitude}.`;
    }

    const roundForContext = gameState?.currentRound ? { ...gameState.currentRound } : {};
    delete roundForContext.essay;

    const currentLetter = roundForContext?.letter || 'none';
    const currentAnswer = roundForContext?.answer || 'none';
    const hintsRevealed = roundForContext?.hintsRevealed || 0;

    const previousAnswers = gameState?.previousAnswers || [];
    const prevAnswersList = previousAnswers.length > 0
        ? previousAnswers.join(', ')
        : 'none yet';

    const stateDescription = `
=== GAME STATE (TRUTH — overrides chat history) ===
Phase: ${gameState?.phase || 'setup_intro'} | Round #${gameState?.roundNumber || 0} | Category: ${gameState?.category || 'none'} | Difficulty: ${gameState?.difficulty || 'not set'}
Current letter: ${currentLetter} | Answer: ${currentAnswer} | Hints revealed: ${hintsRevealed}/3
Players: ${JSON.stringify(gameState?.players || [])}
Location: ${locationContext || 'Unknown'}
Used answers (never repeat): ${prevAnswersList}
===

"${transcript}"`;

    // Build messages array with conversation history
    const messages = [];
    const history = (conversationHistory || []).slice(-6);
    for (const entry of history) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }

    messages.push({
        role: 'user',
        content: stateDescription
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
            system: SYSTEM_PROMPT,
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

                const retryResult = await retryRoundGeneration(client, messages, letter, previousAnswers, gameState, locationContext);
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
                    // Retry also failed — ask for a different letter entirely
                    speech = speech || "Hmm, let me try a different letter.";
                    // Pick a random letter that hasn't been used recently
                    const usedLetters = previousAnswers.map(a => a[0]?.toUpperCase()).filter(Boolean);
                    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !usedLetters.includes(l));
                    const fallbackLetter = available.length > 0
                        ? available[Math.floor(Math.random() * available.length)]
                        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];

                    const fallbackResult = await retryRoundGeneration(client, messages, fallbackLetter, previousAnswers, gameState, locationContext);
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

        // Send speech early for TTS
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
async function retryRoundGeneration(client, originalMessages, letter, previousAnswers, gameState, locationContext) {
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
