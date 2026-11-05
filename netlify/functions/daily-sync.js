// Runs on the schedule in netlify.toml. Re-pulls the last two days so late orders and cancellations settle.
const { syncRange, today, addDays } = require('../lib/shared');

exports.handler = async () => {
  try {
    const r = await syncRange(addDays(today(), -2), addDays(today(), -1));
    console.log('daily-sync', JSON.stringify(r.days));
    return { statusCode: 200 };
  } catch (e) {
    console.error('daily-sync failed:', e.message);
    return { statusCode: 500 };
  }
};
