import { Router } from 'express';
import axios from 'axios';
import { redis } from '../db/redis';

export const weatherRouter = Router();

const CACHE_TTL_SECONDS = 30 * 60; // 30 minutes, per backend-api-spec.md §8

weatherRouter.get('/weather', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'lat and lng are required', status: 400 } });
  }

  const cacheKey = `weather:${Number(lat).toFixed(2)}:${Number(lng).toFixed(2)}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  try {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    const response = await axios.get('https://api.openweathermap.org/data/3.0/onecall', {
      params: { lat, lon: lng, appid: apiKey, units: 'imperial' },
    });
    const data = response.data;

    const normalized = {
      current: {
        temp_f: Math.round(data.current.temp),
        condition: data.current.weather?.[0]?.main?.toLowerCase() ?? 'unknown',
        humidity_pct: data.current.humidity,
      },
      forecast: (data.daily ?? []).slice(0, 5).map((d: any) => ({
        date: new Date(d.dt * 1000).toISOString().slice(0, 10),
        high_f: Math.round(d.temp.max),
        low_f: Math.round(d.temp.min),
        condition: d.weather?.[0]?.main?.toLowerCase() ?? 'unknown',
        precip_in: d.rain ? Math.round((d.rain / 25.4) * 100) / 100 : 0,
      })),
      // A real frost-risk model would weigh overnight low against the
      // user's specific tracked crops' frost tolerance (crops.frost_tolerant)
      // rather than a flat threshold — this is a reasonable v1 approximation.
      frost_risk_tonight: data.daily?.[0]?.temp?.min !== undefined && data.daily[0].temp.min <= 36,
    };

    await redis.set(cacheKey, JSON.stringify(normalized), 'EX', CACHE_TTL_SECONDS).catch(() => {});
    res.json(normalized);
  } catch (err) {
    console.error('Weather provider error', err);
    res.status(502).json({ error: { code: 'VALIDATION_ERROR', message: 'Weather provider unavailable', status: 502 } });
  }
});
