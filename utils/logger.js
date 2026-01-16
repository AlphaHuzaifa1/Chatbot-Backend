const LogLevel = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

const formatLog = (level, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };
  return JSON.stringify(logEntry);
};

export const logError = (message, data = {}) => {
  console.error(formatLog(LogLevel.ERROR, message, data));
};

export const logWarn = (message, data = {}) => {
  console.warn(formatLog(LogLevel.WARN, message, data));
};

export const logInfo = (message, data = {}) => {
  console.log(formatLog(LogLevel.INFO, message, data));
};

export const logDebug = (message, data = {}) => {
  if (process.env.NODE_ENV === 'development') {
    console.debug(formatLog(LogLevel.DEBUG, message, data));
  }
};

