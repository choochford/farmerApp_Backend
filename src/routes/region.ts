import { Router } from 'express';
import { query, queryOne } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';

export const regionRouter = Router();

// GET /v1/region?zip=75457  or  ?lat=33.2&lng=-95.2
//
// Per backend-api-spec.md §4 this should be backed by a pre-ingested USDA
// zone dataset keyed by a lat/lng grid cell, not a live external call.
// That ingestion job (download the USDA shapefile/raster, rasterize to a
// zone-per-grid-cell lookup table, load into Postgres) is a separate
// one-time/yearly task and is NOT implemented here — this route currently
// reads from a `zone_lookup` table that the ingestion job is responsible
// for populating. Until that table is seeded, this endpoint will 404 for
// every input, by design, rather than silently returning made-up data.
regionRouter.get('/region', async (req, res) => {
  const { zip, lat, lng } = req.query;

  let row;
  if (zip) {
    row = await queryOne(
      `SELECT hardiness_zone, last_frost_date, first_frost_date, region_name
       FROM zone_lookup WHERE zip_or_postal = $1 LIMIT 1`,
      [String(zip)],
    );
  } else if (lat && lng) {
    // Nearest-neighbor match against a coarse grid. Replace with a proper
    // PostGIS ST_DWithin query once the zone_lookup table has a geometry
    // column — this linear distance approximation is fine at the ~10km
    // grid resolution USDA zone data is published at, but isn't exact.
    row = await queryOne(
      `SELECT hardiness_zone, last_frost_date, first_frost_date, region_name,
              (latitude - $1)^2 + (longitude - $2)^2 AS dist
       FROM zone_lookup
       ORDER BY dist ASC
       LIMIT 1`,
      [Number(lat), Number(lng)],
    );
  } else {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Provide either zip or lat+lng', status: 400 },
    });
  }

  if (!row) {
    return res.status(404).json({
      error: { code: 'REGION_NOT_FOUND', message: 'No zone data for this location yet', status: 404 },
    });
  }

  res.json({
    hardiness_zone: row.hardiness_zone,
    last_frost_date: row.last_frost_date,
    first_frost_date: row.first_frost_date,
    region_name: row.region_name,
  });
});

// POST /v1/users/me/region — save the user's region + manual overrides
regionRouter.post('/users/me/region', requireAuth, async (req: AuthedRequest, res) => {
  const { zip_or_postal, latitude, longitude, hardiness_zone, last_frost_date, first_frost_date, microclimate_offset } = req.body;

  const existing = await queryOne(`SELECT id FROM regions WHERE user_id = $1 AND is_primary = true`, [req.userId]);

  if (existing) {
    await query(
      `UPDATE regions SET zip_or_postal = $1, latitude = $2, longitude = $3,
        hardiness_zone = $4, last_frost_date = $5, first_frost_date = $6,
        microclimate_offset = $7
       WHERE id = $8`,
      [zip_or_postal, latitude, longitude, hardiness_zone, last_frost_date, first_frost_date, microclimate_offset ?? 0, existing.id],
    );
  } else {
    await query(
      `INSERT INTO regions (user_id, zip_or_postal, latitude, longitude, hardiness_zone, last_frost_date, first_frost_date, microclimate_offset)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.userId, zip_or_postal, latitude, longitude, hardiness_zone, last_frost_date, first_frost_date, microclimate_offset ?? 0],
    );
  }

  res.status(204).send();
});
