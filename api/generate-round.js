// Vercel Serverless Function — Round Generation (Opus 4)
// Dedicated endpoint for generating I Spy rounds with the best reasoning model.
// Called by the client to pre-generate the next round while the essay plays.
// Returns validated round data: { letter, answer, hints, essay, speech, proximity }

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL_ROUND = 'claude-opus-4-20250514';

const ROUND_TOOL = {
    name: 'create_round',
    description: 'Create a new I Spy round. The answer MUST start with the given letter. The system validates this.',
    input_schema: {
        type: 'object',
        properties: {
            letter: {
                type: 'string',
                description: 'A single uppercase letter (A-Z) for this round'
            },
            answer: {
                type: 'string',
                description: 'The answer — MUST start with the given letter'
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
                description: 'Specific location reference if proximity is nearby'
            },
            speech: {
                type: 'string',
                description: 'Professor Jones announcing this round. MUST begin with "I spy with my little eye something that begins with the letter [X]." Then a brief witty teaser. 2 sentences max.'
            }
        },
        required: ['letter', 'answer', 'hints', 'essay', 'proximity', 'speech']
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, category, difficulty, previousAnswers, location } = req.body;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
    }

    // Credit check (10 per round)
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

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
            if (user.credits < 10) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: 10
                });
            }
            remainingCredits = user.credits - 10;
            supabase
                .from('users')
                .update({ credits: remainingCredits })
                .eq('id', userId)
                .then(null, err => console.error('Credit deduct failed:', err));
        }
    }

    // Pick a random letter, avoiding letters of already-used answers
    const usedLetters = (previousAnswers || []).map(a => a[0]?.toUpperCase()).filter(Boolean);
    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => !usedLetters.includes(l));
    const letter = available.length > 0
        ? available[Math.floor(Math.random() * available.length)]
        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];

    // Location context
    let locationStr = 'United States';
    if (location?.city && location?.region) {
        locationStr = `${location.city}${location.county ? ', ' + location.county : ''}, ${location.region} (GPS: ${location.latitude}, ${location.longitude})`;
    }

    const prevList = (previousAnswers || []).length > 0
        ? (previousAnswers || []).join(', ')
        : 'none';

    const client = new Anthropic({ apiKey });

    // Try up to 2 letters if first one fails validation
    for (let attempt = 0; attempt < 2; attempt++) {
        const tryLetter = attempt === 0 ? letter : pickDifferentLetter(usedLetters, letter);

        try {
            const response = await client.messages.create({
                model: MODEL_ROUND,
                max_tokens: 512,
                system: `You generate I Spy game rounds. Always use the create_round tool. The answer MUST start with the assigned letter — this is validated by code and will be rejected if wrong. Be creative and varied. Each essay should teach something genuinely surprising. For speech: always begin with "I spy with my little eye something that begins with the letter [X]." then add a brief witty teaser. Keep speech punchy — 2 sentences max. You are Professor Jones — witty, irreverent, playful.`,
                messages: [{
                    role: 'user',
                    content: `Generate an I Spy round for the letter "${tryLetter}".
Category: ${category || 'general knowledge'}.
Difficulty: ${difficulty || 'medium'} (easy = household names, medium = mix, hard = deep cuts).
Players are near: ${locationStr}. Prefer local/regional connections when possible.
Already used answers (do NOT repeat any): ${prevList}.
The answer MUST start with the letter "${tryLetter}". Be creative — avoid the most obvious entry.`
                }],
                tools: [ROUND_TOOL],
                tool_choice: { type: 'tool', name: 'create_round' }
            });

            // Extract tool result
            for (const block of response.content) {
                if (block.type === 'tool_use' && block.name === 'create_round') {
                    const round = block.input;
                    const roundLetter = (round.letter || '').toUpperCase();
                    const roundAnswer = round.answer || '';

                    // Validate letter match
                    if (roundAnswer && roundLetter && roundAnswer[0].toUpperCase() === roundLetter) {
                        return res.status(200).json({
                            letter: roundLetter,
                            answer: roundAnswer,
                            hints: round.hints || [],
                            essay: round.essay || '',
                            speech: round.speech || `I spy with my little eye something that begins with the letter ${roundLetter}.`,
                            proximity: round.proximity || 'region',
                            nearbyLocation: round.nearbyLocation || null,
                            remainingCredits
                        });
                    }

                    console.warn(`[GenerateRound] Letter mismatch: "${roundAnswer}" for "${roundLetter}" (attempt ${attempt + 1})`);
                }
            }
        } catch (err) {
            console.error(`[GenerateRound] Attempt ${attempt + 1} failed:`, err?.message || err);
        }
    }

    // Both attempts failed
    return res.status(500).json({ error: 'Failed to generate valid round after 2 attempts' });
}

function pickDifferentLetter(usedLetters, avoidLetter) {
    const available = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
        .filter(l => !usedLetters.includes(l) && l !== avoidLetter);
    return available.length > 0
        ? available[Math.floor(Math.random() * available.length)]
        : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
}
