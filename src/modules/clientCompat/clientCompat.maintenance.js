'use strict';

const { Setting } = require('../admin/setting.model');

// Restrict maintenance only to compatibility order creation. Read/check routes
// remain usable by downstream clients.
const requireCompatOrderingAvailable = async (_req, res, next) => {
    try {
        const setting = await Setting.findOne({ key: 'maintenanceMode' }).select('value').lean();
        if (setting?.value === true) {
            return res.status(503).json({ status: 'ERROR', code: 130, message: 'Site is under maintenance' });
        }
        return next();
    } catch (_) {
        return res.status(500).json({ status: 'ERROR', code: 500, message: 'Unknown internal error' });
    }
};

module.exports = { requireCompatOrderingAvailable };
