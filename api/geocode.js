// Vercel Serverless Function — Reverse geocoding proxy
// Avoids CORS issues with direct Nominatim calls from the browser

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { lat, lon } = req.query;

    if (!lat || !lon) {
        return res.status(400).json({ error: 'Missing lat/lon parameters' });
    }

    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
            {
                headers: {
                    'User-Agent': 'ISpyRoadTrip/1.0 (educational-game)'
                }
            }
        );

        if (!response.ok) {
            return res.status(502).json({ error: 'Geocoding service error' });
        }

        const data = await response.json();

        // Return only what we need
        const address = data.address || {};
        res.setHeader('Cache-Control', 'public, max-age=300'); // Cache 5 min
        return res.status(200).json({
            city: address.city || address.town || address.village || address.hamlet || '',
            county: address.county || '',
            state: address.state || '',
            country: address.country || '',
            displayName: data.display_name || ''
        });
    } catch (error) {
        console.error('Geocode error:', error);
        return res.status(500).json({ error: 'Failed to geocode' });
    }
}
