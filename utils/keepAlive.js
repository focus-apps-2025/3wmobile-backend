import cron from 'node-cron';
import fetch from 'node-fetch';

/**
 * Keep-alive self-ping to prevent Render from spinning down the server.
 * Pings /api/health every 14 minutes (Render spins down after ~15 min inactivity).
 */
export function initKeepAlive() {
  const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
  
  // Ping every 14 minutes
  cron.schedule('*/14 * * * *', async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/health`);
      if (response.ok) {
        console.log(`[KeepAlive] Ping OK at ${new Date().toISOString()}`);
      }
    } catch (err) {
      console.warn(`[KeepAlive] Ping failed:`, err.message);
    }
  });

  console.log('🏓 Keep-alive pinger initialized (every 14 min)');
}
