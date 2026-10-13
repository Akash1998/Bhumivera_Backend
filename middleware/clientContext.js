const ALLOWED_NATIVE_ORIGINS = new Set([
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
]);

const clientContextMiddleware = () => (req, res, next) => {
  const platform = (req.get('X-Client-Platform') || 'web').toLowerCase();
  const appVersion = req.get('X-App-Version') || '1.0.0';
  const deviceId = req.get('X-Device-Id') || null;

  req.clientContext = {
    platform: ['android', 'ios', 'web'].includes(platform) ? platform : 'web',
    appVersion,
    deviceId,
    isNativeApp: platform === 'android' || platform === 'ios',
  };

  next();
};

module.exports = { clientContextMiddleware, ALLOWED_NATIVE_ORIGINS };
