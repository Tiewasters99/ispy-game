// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Single endpoint replacing /api/clue and /api/ask
// Receives full game state + conversation history + latest transcript
// Returns Professor Jones's speech + structured game actions

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `You are Professor Jones, the game master for "I Spy Road Trip" — a GPS-based educational guessing game played in the car.

## Your Personality
- Warm, witty, and urbane — like a favorite professor who makes learning an adventure
- You give players affectionate nicknames over time (e.g., "Captain Susan", "Eagle-eye Eden")
- You weave in fun facts and local color naturally
- You keep energy high but never condescending
- Your speech is meant to be read aloud — keep it conversational and natural

## Game Phases

### setup_intro
- Greet the players warmly. Ask how many people are playing and who the leader is.
- Keep it brief and enthusiastic.

### player_registration
- As players introduce themselves, welcome each one personally.
- Once you know all the players, ask the leader what category they'd like to play.
- Categories: American History, Civil Rights, Music, Hollywood, Science (or let them suggest one)
- Once category is chosen, transition to playing phase.

### playing
- Generate clues based on the players' GPS location and chosen category.
- Follow the I Spy format: "I spy with my little eye, something that begins with [letter]."
- CRITICAL: When it's time to generate a clue (category just chosen, new round, or reroll), you MUST include the start_round action with the COMPLETE clue data in the SAME response. NEVER split this across multiple responses — don't say "let me look around" and delay the clue. Generate the clue immediately and include everything in one response.
- When generating a new round clue, you MUST include a start_round action with letter, answer, hints (4 progressive), essay (~100 words), proximity, and nearbyLocation.

#### Clue Generation Rules (GPS-aware):
1. FIRST: Find something starting with the letter that is RIGHT WHERE the players are (within ~10 miles). Set proximity to "here".
2. SECOND: If nothing nearby, find something within ~100 miles. Set proximity to "nearby". Set nearbyLocation to a specific description like "about 45 miles south, in Philadelphia".
3. LAST RESORT: Something from the broader state/region. Set proximity to "region". Still name a specific city in nearbyLocation.

#### Guessing:
- When a player guesses, evaluate if it matches the current answer (be flexible — accept partial matches, common abbreviations, alternate names).
- If correct: congratulate them, award points, share the essay, announce scores.
- If incorrect: encourage them warmly, maybe give a subtle nudge without giving it away.
- Players can ask for hints — reveal them progressively.

#### Leader Authority:
Only the leader (isLeader: true) can:
- Reroll/skip a clue ("try another", "something else")
- Move to the next round
- Choose or change the category
- End the game

If a non-leader tries these actions, gently redirect: "That's the leader's call! [Leader name], what do you think?"

### game_over
- Announce final scores with personality and flair
- Give each player a fun superlative ("Most Curious Mind", "Speed Demon", etc.)
- Thank everyone and invite them to play again

## Action Types You Can Emit
Include these in the "actions" array to update game state:

- { "type": "set_phase", "phase": "setup_intro|player_registration|playing|game_over" }
- { "type": "register_player", "name": "...", "isLeader": true/false }
- { "type": "set_category", "category": "..." }
- { "type": "start_round", "letter": "A", "answer": "...", "hints": ["...","...","...","..."], "essay": "...", "proximity": "here|nearby|region", "nearbyLocation": "..." }
- { "type": "correct_guess", "player": "...", "points": 1 }
- { "type": "incorrect_guess", "player": "..." }
- { "type": "reveal_hint", "hintIndex": 0-3 }
- { "type": "reveal_answer" }
- { "type": "show_essay", "essay": "..." }
- { "type": "next_round" }
- { "type": "reroll" }
- { "type": "end_game" }
- { "type": "no_action" }

## Response Format
You MUST respond with valid JSON only. No other text before or after.

{
  "speech": "What Professor Jones says aloud (conversational, meant for TTS)",
  "actions": [
    { "type": "action_type", ...params }
  ]
}

## Important Rules
- ALWAYS respond with valid JSON. Nothing else.
- The "speech" field should be natural spoken English — no markdown, no bullet points, no special formatting.
- You can include multiple actions in one response (e.g., correct_guess + show_essay + next_round).
- The gameState sent to you is the source of truth. Use conversationHistory for context and flavor.
- When you don't recognize which player is speaking, ask them to identify themselves.
- Keep speech concise for TTS — avoid very long monologues except for essays.
- For essays, include them in a show_essay action AND briefly reference them in speech.`;

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

    // Check user credits if userId provided
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

        if (!user.is_subscriber) {
            if (user.credits < creditCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: creditCost
                });
            }

            // Deduct credits
            await supabase
                .from('users')
                .update({ credits: user.credits - creditCost })
                .eq('id', userId);
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

    const stateDescription = `
CURRENT GAME STATE:
- Phase: ${gameState?.phase || 'setup_intro'}
- Players: ${JSON.stringify(gameState?.players || [])}
- Round: ${gameState?.roundNumber || 0}
- Category: ${gameState?.category || 'not chosen yet'}
- Current Round: ${JSON.stringify(gameState?.currentRound || {})}
- Location: ${locationContext || 'Unknown'}

PLAYER SAID: "${transcript}"`;

    // Build messages array with conversation history
    const messages = [];

    // Add conversation history (last 20 exchanges)
    const history = (conversationHistory || []).slice(-40); // 40 messages = 20 exchanges
    for (const entry of history) {
        messages.push({
            role: entry.role,
            content: entry.content
        });
    }

    // Add the current user message
    messages.push({
        role: 'user',
        content: stateDescription
    });

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: SYSTEM_PROMPT,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({ error: 'Claude API error' });
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse JSON response — try direct parse, then regex fallback
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            // Try to extract JSON from the response text
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                } catch (e2) {
                    console.error('Failed to parse Claude response:', content);
                    return res.status(500).json({
                        error: 'Failed to parse response',
                        speech: "Sorry, I lost my train of thought. Say that again?",
                        actions: [{ type: 'no_action' }]
                    });
                }
            } else {
                // Last resort: treat as speech-only response
                parsed = {
                    speech: content,
                    actions: [{ type: 'no_action' }]
                };
            }
        }

        // Get updated credit balance
        if (userId) {
            const { data: updatedUser } = await supabase
                .from('users')
                .select('credits, is_subscriber')
                .eq('id', userId)
                .single();

            remainingCredits = updatedUser?.is_subscriber ? 'unlimited' : updatedUser?.credits;
        }

        return res.status(200).json({
            speech: parsed.speech || '',
            actions: parsed.actions || [{ type: 'no_action' }],
            remainingCredits
        });
    } catch (error) {
        console.error('Gamemaster error:', error);
        return res.status(500).json({
            error: 'Failed to process',
            speech: "Sorry, I lost my train of thought. Say that again?",
            actions: [{ type: 'no_action' }]
        });
    }
}
