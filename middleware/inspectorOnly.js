/**
 * Middleware to restrict access to inspector role only
 */
export const inspectorOnly = (req, res, next) => {
  if (req.user && req.user.role === 'inspector') {
    return next();
  }
  
  return res.status(403).json({
    success: false,
    message: 'Access denied. Inspector role required.'
  });
};
