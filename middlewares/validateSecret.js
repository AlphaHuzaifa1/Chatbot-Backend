export const validateSharedSecret = (req, res, next) => {
  const sharedSecret = process.env.CHAT_SHARED_SECRET || 'default-secret-change-in-production';
  const providedSecret = req.headers['x-shared-secret'] || req.body.sharedSecret;

  if (!providedSecret) {
    return res.status(401).json({
      success: false,
      error: 'Shared secret is required'
    });
  }

  if (providedSecret !== sharedSecret) {
    return res.status(403).json({
      success: false,
      error: 'Invalid shared secret'
    });
  }

  next();
};

