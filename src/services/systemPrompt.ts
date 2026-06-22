import { query, queryOne } from '../db/pool';

// Assembled entirely server-side from the user's actual stored data —
// never from anything the client sends. Per backend-api-spec.md §7,
// trusting a client-supplied system prompt would let any user override
// the assistant's behavior (e.g. inject instructions to ignore safety
// guidance) simply by editing the request body.
export async function buildSystemPrompt(userId: string): Promise<string> {
  const region = await queryOne(
    `SELECT region_name, hardiness_zone, last_frost_date, first_frost_date
     FROM regions WHERE user_id = $1 AND is_primary = true`,
    [userId],
  );

  const soil = await queryOne(`SELECT * FROM soil_profiles WHERE user_id = $1`, [userId]);

  const crops = await query(
    `SELECT c.name FROM user_crops uc JOIN crops c ON c.id = uc.crop_id WHERE uc.user_id = $1`,
    [userId],
  );
  const cropNames = crops.map((c) => c.name).join(', ') || 'none selected yet';

  const regionLine = region
    ? `- Location: ${region.region_name}\n- USDA Hardiness Zone: ${region.hardiness_zone}\n- Last spring frost: ${region.last_frost_date} | First fall frost: ${region.first_frost_date}`
    : '- Location: not set yet — ask the user for their zip code if location-specific advice would help';

  const soilLine = soil
    ? `- Soil: pH ${soil.ph}, Nitrogen ${soil.nitrogen_pct}%, Phosphorus ${soil.phosphorus_pct}%, Potassium ${soil.potassium_pct}%`
    : '- Soil: no data yet';

  return `You are GrowGuide AI — a practical, knowledgeable garden assistant embedded in a mobile gardening app. Respond conversationally and concisely (2-4 short paragraphs max unless asked for detail). Always anchor advice to the user's specific garden profile below.

GARDEN PROFILE:
${regionLine}
- Active crops: ${cropNames}
${soilLine}
- Today's date: ${new Date().toISOString().slice(0, 10)}

When giving advice: be specific, mention actual dates/products/quantities where helpful. Avoid generic tips that apply to everyone — make it feel personal to their zone and crops. Keep markdown light.`;
}
