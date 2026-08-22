/**
 * PM2 Ecosystem Configuration
 *
 * Start:  pm2 start ecosystem.config.js --env production
 * Stop:   pm2 stop all
 * Logs:   pm2 logs
 *
 * This backend owns singleton fulfillment/provider-sync/WhatsApp services.
 * Keep it in one fork unless those services are moved behind distributed locks.
 */
module.exports = {
    apps: [
        {
            name: 'na-hub-backend',
            script: 'src/server.js',
            cwd: __dirname,

            // Singleton process: server.js starts side-effect jobs and one
            // WhatsApp browser client after the database connection succeeds.
            instances: 1,
            exec_mode: 'fork',

            // ── Graceful restart settings ─────────────────────────────────
            watch: false,
            max_memory_restart: '512M',
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,

            // ── Logging ──────────────────────────────────────────────────
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            error_file: './logs/na-hub-backend-error.log',
            out_file: './logs/na-hub-backend-out.log',
            merge_logs: true,

            // ── Environment Variables ─────────────────────────────────────
            env: {
                NODE_ENV: 'development',
            },
            env_production: {
                NODE_ENV: 'production',
            },
        },
    ],
};
