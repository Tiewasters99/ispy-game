// Vercel Serverless Function — ElevenLabs TTS (Professor Jones voice)
// No credit cost — voice is core gameplay.

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Missing text' });
    }

    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'KTjyUd6ZeCmAkkfvuuU2';

    if (!elevenLabsKey) {
        return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }

    try {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': elevenLabsKey
            },
            body: JSON.stringify({
                text: text,
                model_id: 'eleven_flash_v2_5',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('ElevenLabs API error:', response.status, errorText);
            return res.status(502).json({ error: 'TTS provider error' });
        }

        // Stream audio bytes back to client
        const audioBuffer = await response.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
        return res.status(200).send(Buffer.from(audioBuffer));

    } catch (error) {
        console.error('TTS error:', error);
        return res.status(500).json({ error: 'Failed to generate speech' });
    }
}
