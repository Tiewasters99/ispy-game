// Vercel Serverless Function — Conversational Game Master ("Professor Jones")
// Single endpoint replacing /api/clue and /api/ask
// Receives full game state + conversation history + latest transcript
// Returns Professor Jones's speech + structured game actions

import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `You are Professor Jones, the game master for "I Spy Road Trip" — a GPS-based educational guessing game played in the car.

## Your Personality
- Warm and witty, but BRIEF. You're a game master, not a lecturer.
- 1-2 sentences per response is ideal. 3 sentences is the max for most turns.
- Never repeat what the player just said back to them.
- Don't over-explain rules or pad with filler ("That's a great question!", "Wonderful!", "Absolutely!")
- Nicknames are fine but don't force them every turn.
- Your speech is read aloud by TTS — every extra word costs time and patience.

## Game Phases

### setup_intro
- One sentence greeting. Ask who's playing.

### player_registration
- Quick welcome per player — just their name, no speeches.
- Once all players are in, ask the leader to pick a category.
- Categories: American History, Civil Rights, Music, Hollywood, Science (or custom)
- Once chosen, go straight to the first clue. No preamble.

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
- Be flexible — accept partial matches, abbreviations, alternate names.
- Correct: "Yes! [answer]." Award points. Mention the essay briefly — one sentence. Don't read the essay aloud.
- Incorrect: "Not quite." One short hint or nudge. No speeches.
- Hints: reveal one at a time when asked.

#### Leader Authority:
Only the leader (isLeader: true) can reroll, skip, change category, or end the game.
If a non-leader tries: "[Leader name]'s call."

### game_over
- Final scores. One fun line per player. Done.

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

## Silence Handling
When the transcript is "[No response — player is silent]", the player said nothing after your last response. Interpret silence based on context:
- After asking "who's playing?" → silence means they're still gathering. Say nothing meaningful, just a brief nudge like "Take your time."
- After giving a clue → silence means they're thinking. Give a small hint or say "Need a hint?"
- After revealing an answer/essay → silence means "move on." Start the next round immediately (include start_round action).
- After asking to pick a category → gentle nudge: "What'll it be?"
- Keep silence responses VERY short — one sentence max. Don't repeat yourself.
- If you just gave a silence response and get silence again, don't keep nudging. Just emit { "type": "no_action" } with an empty speech "".

## Important Rules
- ALWAYS respond with valid JSON. Nothing else.
- The "speech" field is spoken aloud by TTS. Keep it SHORT. 1-2 sentences ideal, 3 max.
- Multiple actions per response are fine (e.g., correct_guess + show_essay).
- gameState is the source of truth. conversationHistory is for context.
- If you can't tell who's speaking, just ask "Who's that?"
- Essays go in show_essay actions only — never read them in the speech field.
- NEVER pad responses with enthusiasm, praise, or filler. Be direct.`;

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
