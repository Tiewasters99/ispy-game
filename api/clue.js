// Vercel Serverless Function - Claude API Integration
// This keeps the API key secure on the server side

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { category, letter, latitude, longitude, city, county, region, userId, token } = req.body;

    if (!category || !letter) {
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

    // Check user credits if userId provided
    if (userId) {
        const { data: user, error } = await supabase
            .from('users')
            .select('credits, is_subscriber')
            .eq('id', userId)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        // Subscribers have unlimited access
        if (!user.is_subscriber) {
            // Each clue costs 10 credits (roughly $0.10 worth)
            const clueCost = 10;

            if (user.credits < clueCost) {
                return res.status(402).json({
                    error: 'Insufficient credits',
                    credits: user.credits,
                    required: clueCost
                });
            }

            // Deduct credits
            await supabase
                .from('users')
                .update({ credits: user.credits - clueCost })
                .eq('id', userId);
        }
    }

    // Build location context
    let locationContext = '';
    let hasLocation = false;
    if (city && region) {
        locationContext = `The players are currently near ${city}${county ? ', ' + county : ''}, ${region}. Their GPS coordinates are approximately ${latitude}, ${longitude}.`;
        hasLocation = true;
    } else if (latitude && longitude) {
        locationContext = `The players are at GPS coordinates ${latitude}, ${longitude}.`;
        hasLocation = true;
    }

    const prompt = `You are the game master for a GPS-based educational "I Spy" road trip game. The game is LOCATION-DRIVEN — clues must be tied to where the players physically are.

Category: ${category}
Letter: ${letter}
${locationContext || 'Location unknown.'}

CRITICAL RULES — follow this priority order:

1. FIRST PRIORITY: Find something starting with "${letter}" that is RIGHT WHERE THE PLAYERS ARE — a landmark, historic site, person from this town, local event, or notable place in their immediate city/town (within ~10 miles). Set "proximity" to "here".

2. SECOND PRIORITY: If nothing starts with "${letter}" in their immediate area, find something within about 100 miles — a nearby city's landmark, a regional figure, a state-level historic site. Set "proximity" to "nearby" and set "nearbyLocation" to describe where it is relative to the player.

3. LAST RESORT: If nothing in the category starts with "${letter}" within 100 miles, pick something notable from the broader state or region. Set "proximity" to "region".

The answer MUST be geographically connected to the player's location. Never pick something random or unrelated to where they are.

Generate:
- 4 progressive hints (vague to specific), weaving in local geography
- A 100-word educational essay connecting the answer to this location
- The proximity level and nearby location description

Respond in this exact JSON format:
{
    "answer": "The full answer",
    "hints": [
        "First hint (hardest/most vague)",
        "Second hint (medium)",
        "Third hint (easier)",
        "Fourth hint (easiest/most specific)"
    ],
    "essay": "A 100-word educational essay tying this answer to the player's location",
    "proximity": "here" | "nearby" | "region",
    "nearbyLocation": "e.g. 'about 45 miles south in Philadelphia' or null if proximity is 'here'",
    "locationRelevance": "One sentence about why this is relevant to where the player is"
}

Only respond with valid JSON, no other text.`;

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
                max_tokens: 1024,
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({ error: 'Claude API error' });
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse the JSON response from Claude
        const clueData = JSON.parse(content);

        // Get updated credit balance
        let remainingCredits = null;
        if (userId) {
            const { data: updatedUser } = await supabase
                .from('users')
                .select('credits, is_subscriber')
                .eq('id', userId)
                .single();

            remainingCredits = updatedUser?.is_subscriber ? 'unlimited' : updatedUser?.credits;
        }

        return res.status(200).json({
            ...clueData,
            remainingCredits
        });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Failed to generate clue' });
    }
}
