export const authenticate = (req, res, next) => {
  next();
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    next();
  };
};

