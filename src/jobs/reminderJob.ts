import cron from 'node-cron';
import { query } from '../db/pool';

// Per backend-api-spec.md §6: "Push notifications are triggered by a
// scheduled job that scans ScheduleItem rows daily and sends via FCM/APNs
// when target_date is within the user's configured lead time."
//
// Push delivery itself (FCM/APNs SDK calls) is NOT implemented here — this
// only finds the rows that are due and marks them sent. Wiring in
// `firebase-admin` (for both Android FCM and iOS via FCM's APNs bridge)
// is a separate, fairly mechanical task once push credentials exist; the
// query logic below is the part actually specific to this product.
const LEAD_TIME_DAYS = 1;

export async function runReminderSweep() {
  const rows = await query(
    `SELECT si.id, si.title, si.target_date, u.id AS user_id, u.push_token, u.notification_push
     FROM schedule_items si
     JOIN user_crops uc ON uc.id = si.user_crop_id
     JOIN users u ON u.id = uc.user_id
     WHERE si.reminder_sent = false
       AND si.target_date <= (CURRENT_DATE + $1::int)
       AND u.notification_push = true
       AND u.push_token IS NOT NULL`,
    [LEAD_TIME_DAYS],
  );

  for (const row of rows) {
    try {
      // sendPushNotification(row.push_token, { title: 'GrowGuide', body: row.title });
      console.log(`[reminder] would notify user ${row.user_id}: "${row.title}" (${row.target_date})`);
      await query(`UPDATE schedule_items SET reminder_sent = true WHERE id = $1`, [row.id]);
    } catch (err) {
      // Don't let one failed send (e.g. a stale/invalid push token) abort
      // the rest of the sweep — log and continue.
      console.error(`Failed to send reminder for schedule_item ${row.id}`, err);
    }
  }

  if (rows.length > 0) {
    console.log(`[reminder] processed ${rows.length} due reminder(s)`);
  }
}

export function scheduleReminderJob() {
  // Runs daily at 7am server time. In production this should run in the
  // user's local timezone bucket rather than a single fixed server time —
  // tracked as a known simplification, not implemented in this scaffold.
  cron.schedule('0 7 * * *', () => {
    runReminderSweep().catch((err) => console.error('Reminder sweep failed', err));
  });
}
